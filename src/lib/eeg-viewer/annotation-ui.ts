/**
 * Annotation mode for the signal viewer (website#255): the DOM and pointer
 * layer over the pure model in `annotations.ts`.
 *
 * Mounted by `mountEegViewer` alongside the existing controls rather than
 * woven into them. It owns three pieces of the viewer's DOM and nothing else:
 * an overlay canvas stacked above the chrome canvas, a popover, and a panel
 * under the scope. That containment is deliberate — the viewer's render loop,
 * its store reads and its keyboard bindings are untouched, and this layer only
 * ever *reads* geometry the renderer already computed (`onFrame`).
 *
 * Two interactions, matching the two annotation kinds:
 *
 * - **On the trace**, in annotation mode, a click drops a zero-duration event
 *   marker and a horizontal drag makes a span. Both open the popover.
 * - **In the gutter**, channel selection is the viewer's *existing* gesture —
 *   clicking a channel label marks it (the "bad channel" marking that has been
 *   there since website#99). Annotation mode does not intercept it; it reads
 *   it. With channels marked, the panel offers to annotate them as a set.
 *
 * Annotating a time range *on a specific channel* is deliberately not here.
 * It is the intersection of the two gestures and needs its own answer for what
 * the export means; deferred out of this epic.
 */

import { type AnnotationStore, type RecordingKey, openAnnotationStore } from "./annotation-store";
import {
  type AnnotationSet,
  type ChannelAnnotation,
  type HedPath,
  type TimeAnnotation,
  assignOverlapLanes,
  channelsTsvFilename,
  createTimeAnnotation,
  emptyAnnotationSet,
  eventsTsvFilename,
  formatSeconds,
  isAnnotationSetEmpty,
  normalizeRange,
  removeChannelAnnotation,
  removeTimeAnnotation,
  serializeChannelsTsv,
  serializeEventsTsv,
  timeAnnotationsInWindow,
  upsertChannelAnnotations,
  upsertTimeAnnotation,
} from "./annotations";
import {
  type HedVocab,
  type HedVocabEntry,
  entriesByPath,
  hedVersionSpec,
  loadHedVocab,
  searchVocab,
} from "./hed-vocab";
import type { TraceSlot } from "./render";

/** Pixels of horizontal travel before a press counts as a drag, not a click. */
const DRAG_THRESHOLD_PX = 4;
/** Pixels either side of a marker line that still count as hitting it. */
const MARKER_HIT_PX = 4;
const SEARCH_RESULT_LIMIT = 30;
/** How long after the last edit the set is written to IndexedDB. */
const SAVE_DEBOUNCE_MS = 400;

export interface AnnotationGeometry {
  cssWidth: number;
  cssHeight: number;
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
  windowStartS: number;
  windowEndS: number;
  /** Channel labels in slot order (already bad-filtered by the renderer). */
  channelLabels: string[];
  slots: TraceSlot[];
  butterfly: boolean;
}

export interface AnnotationLayerOptions {
  /** The viewer root; the popover and panel are positioned inside it. */
  root: HTMLElement;
  /** The positioned scope frame the overlay canvas is stacked into. */
  scope: HTMLElement;
  /** Empty container under the scope for the annotation panel. */
  panel: HTMLElement;
  /** Toolbar toggle, built by the viewer so it sits with the other controls. */
  toggleBtn: HTMLButtonElement;
  key: RecordingKey;
  /** Channels the user has marked in the montage (the viewer's `badChannels`). */
  getSelectedChannels: () => string[];
  /**
   * Bring the viewer's montage marking in line with what the annotations say:
   * mark `bad`, unmark `good`. Called when persisted annotations are restored
   * and after a channel annotation is saved, so a channel the annotator has
   * just declared good stops showing as dimmed.
   *
   * Only ever names channels this layer has an annotation for — a channel the
   * user has marked but not yet annotated is left exactly as they left it.
   */
  setChannelMarks: (bad: string[], good: string[]) => void;
  /** Ask the viewer to repaint the overview minimap (cheap; no store read). */
  requestOverviewRedraw: () => void;
}

export interface AnnotationLayer {
  /** Called after each viewer frame with that frame's geometry. */
  onFrame(geometry: AnnotationGeometry): void;
  /** Called when the viewer's channel marking changed. */
  onSelectionChanged(): void;
  /** Turn annotation mode on/off (also driven by the toolbar toggle). */
  setActive(active: boolean): void;
  isActive(): boolean;
  /** Draw annotation ticks onto the overview minimap's context. */
  drawOverview(
    ctx: CanvasRenderingContext2D,
    cssWidth: number,
    cssHeight: number,
    durationS: number,
  ): void;
  /** Write any pending edits through to storage. Safe to call repeatedly. */
  flush(): Promise<void>;
  destroy(): void;
}

/**
 * Whether this page has a signed-in session, read from the DOM rather than
 * fetched: `Nav.astro` renders `UserMenu` with a `[data-user-menu]` element
 * only when `getSession` returned one, and the marketing host never renders it
 * at all (its cookie is scoped to `app.nemar.org`). So the marker's presence
 * is exactly "there is a session that this page can act on", which is the
 * question the unsaved-work warning is asking.
 *
 * A false negative is the safe direction: it produces an extra confirm on
 * leaving, never a silent loss.
 */
function hasSession(): boolean {
  return typeof document !== "undefined" && document.querySelector("[data-user-menu]") !== null;
}

export function createAnnotationLayer(opts: AnnotationLayerOptions): AnnotationLayer {
  const doc = opts.root.ownerDocument;
  let set: AnnotationSet = emptyAnnotationSet();
  let store: AnnotationStore | null = null;
  let geometry: AnnotationGeometry | null = null;
  let mode = false;
  let destroyed = false;

  let vocab: HedVocab | null = null;
  let vocabIndex: Map<string, HedVocabEntry> | null = null;
  let vocabLoading: Promise<HedVocab> | null = null;
  let vocabError = "";

  // Live drag state, in seconds. `dragStartS` non-null means a press is down.
  let dragStartS: number | null = null;
  let dragCurrentS: number | null = null;
  let dragStartX = 0;
  let dragMoved = false;
  let activePointerId: number | null = null;

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let savePending: Promise<void> | null = null;

  // --- DOM ------------------------------------------------------------------

  const canvas = doc.createElement("canvas");
  canvas.className = "eegv__annot-canvas";
  canvas.setAttribute("aria-hidden", "true");
  opts.scope.append(canvas);

  const popover = el("div", "eegv__annot-pop");
  popover.hidden = true;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-modal", "false");
  popover.setAttribute("aria-label", "Annotation");
  opts.root.append(popover);

  opts.panel.classList.add("eegv__annot-panel");
  opts.panel.hidden = true;

  // --- persistence ----------------------------------------------------------

  /**
   * Load whatever was stored for this recording. Runs on mount, not on
   * entering annotation mode: marks the user made last visit have to be on
   * screen when they arrive, or the feature looks like it lost them.
   */
  async function restore(): Promise<void> {
    try {
      store = await openAnnotationStore();
      const loaded = await store.load(opts.key);
      if (destroyed) return;
      set = loaded;
      // Persisted `status: bad` channels go back into the viewer's own
      // marking, so a restored annotation and a fresh one look identical.
      syncChannelMarks();
      syncAll();
    } catch (err) {
      // openAnnotationStore does not reject, so reaching here means something
      // in revive/setSelectedChannels did. Keep the viewer alive with an empty
      // set rather than taking the mount down with it.
      console.error("[eeg-viewer] annotations: restore failed:", err);
    }
  }

  function scheduleSave(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flush();
    }, SAVE_DEBOUNCE_MS);
  }

  async function flush(): Promise<void> {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!store) return;
    // Serialize saves so a flush during navigation cannot interleave with a
    // debounced one and write the older set last.
    const previous = savePending ?? Promise.resolve();
    const current = previous.then(() => store?.save(opts.key, set)).catch(() => undefined);
    savePending = current;
    await current;
    if (savePending === current) savePending = null;
  }

  /** Push the annotated channels' status into the viewer's montage marking. */
  function syncChannelMarks(): void {
    if (set.channels.length === 0) return;
    opts.setChannelMarks(
      set.channels.filter((c) => c.status === "bad").map((c) => c.channel),
      set.channels.filter((c) => c.status === "good").map((c) => c.channel),
    );
  }

  function mutate(next: AnnotationSet): void {
    set = next;
    scheduleSave();
    syncAll();
  }

  function syncAll(): void {
    renderPanel();
    drawOverlay();
    opts.requestOverviewRedraw();
    syncBeforeUnload();
  }

  // --- unsaved-work warning -------------------------------------------------

  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    event.preventDefault();
    // Legacy form; some browsers still require a truthy returnValue.
    event.returnValue = "";
  };
  let warningArmed = false;

  /**
   * Arm the browser's native "leave site?" confirm when there is work that
   * only exists in this browser and no account behind it — the issue's
   * anonymous case — and also when persistence itself failed, which is the
   * same exposure for a different reason.
   */
  function syncBeforeUnload(): void {
    const atRisk =
      !isAnnotationSetEmpty(set) && (!hasSession() || (store !== null && !store.persistent));
    if (atRisk === warningArmed) return;
    warningArmed = atRisk;
    if (atRisk) globalThis.addEventListener("beforeunload", onBeforeUnload);
    else globalThis.removeEventListener("beforeunload", onBeforeUnload);
  }

  // --- vocabulary -----------------------------------------------------------

  /**
   * Fetch the vocabulary bundle. Called on the first popover open, never on
   * mount: it is ~140 KB in its own chunk, and a reader who never annotates
   * must not pay for it.
   */
  function ensureVocab(): Promise<HedVocab | null> {
    if (vocab) return Promise.resolve(vocab);
    if (!vocabLoading) {
      vocabLoading = loadHedVocab();
      vocabLoading.catch(() => undefined);
    }
    return vocabLoading.then(
      (v) => {
        vocab = v;
        // Built once, not per lookup: `labelForPath` runs for every visible
        // annotation on every overlay repaint, and rebuilding a 500-entry Map
        // each time would put that on the render path.
        vocabIndex = entriesByPath(v);
        vocabError = "";
        return v;
      },
      (err) => {
        console.error("[eeg-viewer] annotations: HED vocabulary failed to load:", err);
        vocabError = "The HED vocabulary could not be loaded. Free-text notes still work.";
        // Let a later open retry rather than caching the failure forever.
        vocabLoading = null;
        return null;
      },
    );
  }

  /**
   * The short tag for a stored long-form path. Falls back to the path itself
   * before the vocabulary has loaded (and for a tag a newer bundle dropped),
   * so a restored annotation is always legible even if it is verbose.
   */
  function labelForPath(path: HedPath): string {
    return vocabIndex?.get(path)?.tag ?? path;
  }

  // --- geometry helpers -----------------------------------------------------

  function timeAtX(x: number, g: AnnotationGeometry): number {
    const span = g.windowEndS - g.windowStartS;
    if (g.plotWidth <= 0 || span <= 0) return g.windowStartS;
    return g.windowStartS + ((x - g.plotLeft) / g.plotWidth) * span;
  }

  function xAtTime(t: number, g: AnnotationGeometry): number {
    const span = g.windowEndS - g.windowStartS;
    if (span <= 0) return g.plotLeft;
    return g.plotLeft + ((t - g.windowStartS) / span) * g.plotWidth;
  }

  /** The topmost annotation whose drawn extent contains `x`, or null. */
  function annotationAtX(x: number, g: AnnotationGeometry): TimeAnnotation | null {
    const visible = timeAnnotationsInWindow(set.time, g.windowStartS, g.windowEndS);
    let best: TimeAnnotation | null = null;
    let bestWidth = Number.POSITIVE_INFINITY;
    for (const a of visible) {
      const x1 = xAtTime(a.onsetS, g);
      const x2 = xAtTime(a.onsetS + a.durationS, g);
      const hit =
        a.durationS === 0 ? Math.abs(x - x1) <= MARKER_HIT_PX : x >= x1 - 1 && x <= x2 + 1;
      // Prefer the narrowest hit so a spike marked inside a seizure span is
      // reachable rather than shadowed by the span around it.
      const width = Math.max(1, x2 - x1);
      if (hit && width < bestWidth) {
        best = a;
        bestWidth = width;
      }
    }
    return best;
  }

  // --- overlay drawing ------------------------------------------------------

  function annotationColor(): string {
    const value = getComputedStyle(opts.root).getPropertyValue("--eegv-annot").trim();
    return value || "#6d28d9";
  }

  function drawOverlay(): void {
    const g = geometry;
    const ctx = canvas.getContext("2d");
    if (!ctx || !g) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const pxW = Math.round(g.cssWidth * dpr);
    const pxH = Math.round(g.cssHeight * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.cssWidth, g.cssHeight);

    const color = annotationColor();
    const top = g.plotTop;
    const bottom = g.plotTop + g.plotHeight;

    // Committed annotations first, so the live drag paints over them.
    const visible = timeAnnotationsInWindow(set.time, g.windowStartS, g.windowEndS);
    const lanes = assignOverlapLanes(set.time);
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    for (const a of visible) {
      const lane = lanes.get(a.id) ?? 0;
      const labelY = Math.min(top + 14 + lane * 11, bottom - 12);
      const x1 = xAtTime(a.onsetS, g);
      if (a.durationS > 0) {
        const x2 = xAtTime(a.onsetS + a.durationS, g);
        // Translucent fill plus solid edges: categorically unlike the dataset's
        // own events, which are hairlines with a rotated code and never a fill.
        ctx.fillStyle = withAlpha(color, 0.14);
        ctx.fillRect(x1, top, Math.max(1, x2 - x1), g.plotHeight);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(Math.round(x1) + 0.5, top);
        ctx.lineTo(Math.round(x1) + 0.5, bottom);
        ctx.moveTo(Math.round(x2) + 0.5, top);
        ctx.lineTo(Math.round(x2) + 0.5, bottom);
        ctx.stroke();
      } else {
        // Point marker: a dashed full-height line with a solid cap, so it does
        // not read as one of the dataset's solid event hairlines.
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(x1) + 0.5, top + 5);
        ctx.lineTo(Math.round(x1) + 0.5, bottom);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x1 - 4, top);
        ctx.lineTo(x1 + 4, top);
        ctx.lineTo(x1, top + 6);
        ctx.closePath();
        ctx.fill();
      }
      const text = annotationLabel(a);
      if (text) {
        ctx.fillStyle = color;
        ctx.fillText(text.slice(0, 24), x1 + 4, labelY);
      }
    }

    // Channel marks: a small square in the gutter beside each annotated
    // channel's label. Stacked mode only — butterfly has no per-slot geometry.
    if (!g.butterfly && set.channels.length > 0) {
      const byChannel = new Map(set.channels.map((c) => [c.channel, c]));
      for (let i = 0; i < g.slots.length; i++) {
        const annotation = byChannel.get(g.channelLabels[i] ?? "");
        if (!annotation) continue;
        const slot = g.slots[i];
        ctx.fillStyle = annotation.status === "bad" ? color : withAlpha(color, 0.45);
        ctx.fillRect(1, slot.baseline - 3, 3, 6);
      }
    }

    // Live drag highlight, drawn last so it is always legible.
    if (dragStartS !== null && dragCurrentS !== null) {
      const { onsetS, durationS } = normalizeRange(dragStartS, dragCurrentS);
      const x1 = xAtTime(onsetS, g);
      const x2 = xAtTime(onsetS + durationS, g);
      ctx.fillStyle = withAlpha(color, 0.22);
      ctx.fillRect(x1, top, Math.max(1, x2 - x1), g.plotHeight);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x1) + 0.5, top + 0.5, Math.max(1, x2 - x1), g.plotHeight - 1);
      ctx.fillStyle = color;
      ctx.fillText(
        durationS > 0 ? `${formatSeconds(durationS)} s` : formatSeconds(onsetS),
        x1 + 4,
        top + 2,
      );
    }
  }

  function annotationLabel(a: TimeAnnotation): string {
    if (a.hedTags.length > 0) {
      const first = labelForPath(a.hedTags[0]);
      return a.hedTags.length > 1 ? `${first} +${a.hedTags.length - 1}` : first;
    }
    return a.description || "note";
  }

  function drawOverview(
    ctx: CanvasRenderingContext2D,
    cssWidth: number,
    cssHeight: number,
    durationS: number,
  ): void {
    if (set.time.length === 0 || durationS <= 0) return;
    const color = annotationColor();
    // A dedicated strip along the top edge, above where the dataset's own
    // event ticks start, so the two layers never have to be told apart by
    // colour alone. Scaled off the minimap height rather than fixed, so it
    // stays a strip if that height is ever tuned.
    const stripHeight = Math.max(2, Math.min(5, Math.round(cssHeight * 0.09)));
    ctx.save();
    ctx.fillStyle = color;
    for (const a of set.time) {
      const x1 = (a.onsetS / durationS) * cssWidth;
      const x2 = ((a.onsetS + a.durationS) / durationS) * cssWidth;
      ctx.fillRect(x1, 0, Math.max(1.5, x2 - x1), stripHeight);
    }
    ctx.restore();
  }

  // --- pointer interaction --------------------------------------------------

  /**
   * Capture-phase so annotation mode gets the gesture before the viewer's own
   * canvas handlers (cursor readout, bad-channel toggle). Only presses inside
   * the plot area are taken: a press in the gutter falls through untouched, so
   * clicking a channel label still marks the channel — which is exactly the
   * selection this layer then annotates.
   */
  function onPointerDown(event: PointerEvent): void {
    const g = geometry;
    if (!mode || !g || event.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < g.plotLeft || x > g.plotLeft + g.plotWidth) return;
    if (y < g.plotTop || y > g.plotTop + g.plotHeight) return;
    event.preventDefault();
    event.stopPropagation();
    dragStartX = x;
    dragMoved = false;
    dragStartS = clampTime(timeAtX(x, g), g);
    dragCurrentS = dragStartS;
    activePointerId = event.pointerId;
    try {
      opts.scope.setPointerCapture(event.pointerId);
    } catch {
      /* capture is an optimization; the document-level listeners still work */
    }
    drawOverlay();
  }

  function onPointerMove(event: PointerEvent): void {
    const g = geometry;
    if (!g || dragStartS === null || event.pointerId !== activePointerId) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (Math.abs(x - dragStartX) > DRAG_THRESHOLD_PX) dragMoved = true;
    dragCurrentS = clampTime(timeAtX(x, g), g);
    event.stopPropagation();
    drawOverlay();
  }

  function onPointerUp(event: PointerEvent): void {
    const g = geometry;
    if (!g || dragStartS === null || event.pointerId !== activePointerId) return;
    event.stopPropagation();
    const startS = dragStartS;
    const endS = dragCurrentS ?? dragStartS;
    const moved = dragMoved;
    dragStartS = null;
    dragCurrentS = null;
    activePointerId = null;
    try {
      opts.scope.releasePointerCapture(event.pointerId);
    } catch {
      /* never captured */
    }
    drawOverlay();

    if (!moved) {
      // A click: either reopen an existing annotation, or drop a marker.
      const rect = canvas.getBoundingClientRect();
      const existing = annotationAtX(event.clientX - rect.left, g);
      if (existing) {
        openTimePopover(existing, false);
        return;
      }
      openTimePopover(createTimeAnnotation({ onsetS: startS, durationS: 0 }), true);
      return;
    }
    const { onsetS, durationS } = normalizeRange(startS, endS);
    openTimePopover(createTimeAnnotation({ onsetS, durationS }), true);
  }

  /** Swallow the click that follows our own pointer sequence. */
  function onClickCapture(event: MouseEvent): void {
    const g = geometry;
    if (!mode || !g) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < g.plotLeft) return; // gutter: the viewer's channel marking owns it
    event.stopPropagation();
  }

  function clampTime(t: number, g: AnnotationGeometry): number {
    return Math.max(g.windowStartS, Math.min(g.windowEndS, t));
  }

  opts.scope.addEventListener("pointerdown", onPointerDown, true);
  opts.scope.addEventListener("pointermove", onPointerMove, true);
  opts.scope.addEventListener("pointerup", onPointerUp, true);
  opts.scope.addEventListener("pointercancel", onPointerUp, true);
  opts.scope.addEventListener("click", onClickCapture, true);

  // --- popover --------------------------------------------------------------

  /**
   * What the popover is currently editing. `null` when closed. `isNew`
   * distinguishes "cancel discards" from "cancel leaves the stored one alone",
   * and decides whether a Delete button is offered.
   *
   * `tags` and `comment` are the *draft*, held here rather than read off the
   * DOM at save time, because the popover re-renders when the vocabulary chunk
   * lands. Anything typed before that arrives has to survive the re-render.
   */
  type PopoverDraft = { tags: HedPath[]; comment: string };
  type PopoverState =
    | ({ kind: "time"; annotation: TimeAnnotation; isNew: boolean } & PopoverDraft)
    | ({ kind: "channels"; channels: string[]; existing: ChannelAnnotation | null } & PopoverDraft);
  let popState: PopoverState | null = null;
  let restoreFocusTo: HTMLElement | null = null;

  function openTimePopover(annotation: TimeAnnotation, isNew: boolean): void {
    popState = {
      kind: "time",
      annotation,
      isNew,
      tags: [...annotation.hedTags],
      comment: annotation.description,
    };
    restoreFocusTo = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    void ensureVocab().then(() => {
      if (popState?.kind === "time") renderPopover();
    });
    renderPopover();
    positionPopover(annotation.onsetS);
    // The live preview of an unconfirmed annotation: draw it as if it existed
    // so the popover is visibly about a specific piece of the trace.
    dragStartS = annotation.onsetS;
    dragCurrentS = annotation.onsetS + annotation.durationS;
    drawOverlay();
  }

  function openChannelPopover(channels: string[], existing: ChannelAnnotation | null): void {
    if (channels.length === 0) return;
    popState = {
      kind: "channels",
      channels,
      existing,
      tags: existing ? [...existing.hedTags] : [],
      comment: existing?.description ?? "",
    };
    restoreFocusTo = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    void ensureVocab().then(() => {
      if (popState?.kind === "channels") renderPopover();
    });
    renderPopover();
    positionPopover(null);
  }

  function closePopover(): void {
    popState = null;
    popover.hidden = true;
    popover.replaceChildren();
    dragStartS = null;
    dragCurrentS = null;
    drawOverlay();
    // `preventScroll` matters: the element focus returns to is usually the tree
    // row button well above the viewer, and a default focus() would scroll it
    // back into view — jumping the trace out from under the annotator the
    // instant they save.
    restoreFocusTo?.focus({ preventScroll: true });
    restoreFocusTo = null;
  }

  /**
   * Park the popover under the toolbar, horizontally near the annotation it is
   * about. Offsets are measured against the viewer root's own box rather than
   * `offsetLeft`, because the scope's offset parent is the plot wrapper (also
   * positioned), not the root the popover is absolutely placed in.
   */
  const POPOVER_WIDTH_PX = 320;

  function positionPopover(atTimeS: number | null): void {
    const g = geometry;
    popover.style.insetBlockStart = `${(g?.plotTop ?? 4) + 44}px`;
    if (!g || atTimeS === null) {
      popover.style.insetInlineStart = "";
      popover.style.insetInlineEnd = "12px";
      return;
    }
    const scopeLeft =
      opts.scope.getBoundingClientRect().left - opts.root.getBoundingClientRect().left;
    const raw = scopeLeft + xAtTime(atTimeS, g) - POPOVER_WIDTH_PX / 2;
    const maxLeft = Math.max(8, opts.root.clientWidth - POPOVER_WIDTH_PX - 8);
    popover.style.insetInlineEnd = "";
    popover.style.insetInlineStart = `${Math.max(8, Math.min(raw, maxLeft))}px`;
  }

  function renderPopover(): void {
    const state = popState;
    if (!state) return;
    popover.hidden = false;
    popover.replaceChildren();

    const heading = el("div", "eegv__annot-pop-title");
    const body = el("div", "eegv__annot-pop-body");
    const footer = el("div", "eegv__annot-pop-foot");

    let onsetInput: HTMLInputElement | null = null;
    let durationInput: HTMLInputElement | null = null;
    let statusSelect: HTMLSelectElement | null = null;

    if (state.kind === "time") {
      heading.textContent = state.isNew
        ? state.annotation.durationS > 0
          ? "New event"
          : "New event marker"
        : "Edit event";
      onsetInput = numberInput(formatSeconds(state.annotation.onsetS), 0);
      durationInput = numberInput(formatSeconds(state.annotation.durationS), 0);
      const row = el("div", "eegv__annot-row");
      row.append(field("Onset (s)", onsetInput), field("Duration (s)", durationInput));
      body.append(row);
    } else {
      const n = state.channels.length;
      heading.textContent = state.existing
        ? `Edit channel ${state.existing.channel}`
        : `Annotate ${n} channel${n === 1 ? "" : "s"}`;
      const list = el("p", "eegv__annot-chanlist");
      list.textContent = state.channels.join(", ");
      statusSelect = doc.createElement("select");
      statusSelect.className = "eegv__sel";
      for (const [value, text] of [
        ["bad", "bad"],
        ["good", "good"],
      ] as Array<[string, string]>) {
        const option = doc.createElement("option");
        option.value = value;
        option.textContent = text;
        if (value === (state.existing?.status ?? "bad")) option.selected = true;
        statusSelect.append(option);
      }
      body.append(list, field("Status", statusSelect));
    }

    // Selected tags.
    const chosen = el("div", "eegv__annot-chosen");
    function renderChosen(): void {
      chosen.replaceChildren();
      if (!popState) return;
      for (const path of popState.tags) {
        const chip = el("span", "eegv__annot-tag");
        chip.append(doc.createTextNode(labelForPath(path)));
        const remove = doc.createElement("button");
        remove.type = "button";
        remove.className = "eegv__annot-tag-x";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove ${labelForPath(path)}`);
        remove.addEventListener("click", () => {
          if (!popState) return;
          popState.tags = popState.tags.filter((p) => p !== path);
          renderChosen();
        });
        chip.append(remove);
        chosen.append(chip);
      }
      if (popState.tags.length === 0) {
        const empty = el("span", "eegv__annot-hint");
        empty.textContent = "No HED tags yet — search or pick one below.";
        chosen.append(empty);
      }
    }
    function addTag(path: HedPath): void {
      if (!popState || popState.tags.includes(path)) return;
      popState.tags = [...popState.tags, path];
      renderChosen();
    }
    renderChosen();
    body.append(chosen);

    // Search.
    const search = doc.createElement("input");
    search.type = "search";
    search.className = "eegv__annot-search";
    search.placeholder = vocab ? "Search HED and SCORE terms…" : "Loading vocabulary…";
    search.disabled = !vocab;
    search.setAttribute("aria-label", "Search HED vocabulary");
    const results = el("div", "eegv__annot-results");
    results.setAttribute("role", "listbox");
    search.addEventListener("input", () => renderResults(search.value));
    function renderResults(query: string): void {
      results.replaceChildren();
      if (!vocab || query.trim() === "") return;
      const hits = searchVocab(vocab.entries, query, SEARCH_RESULT_LIMIT);
      if (hits.length === 0) {
        const none = el("p", "eegv__annot-hint");
        none.textContent = "No matching term.";
        results.append(none);
        return;
      }
      for (const { entry } of hits) results.append(resultButton(entry, addTag));
    }
    body.append(search, results);
    if (vocabError) {
      const warn = el("p", "eegv__annot-hint");
      warn.textContent = vocabError;
      body.append(warn);
    }

    // Quick picks.
    if (vocab && vocabIndex) {
      const byPath = vocabIndex;
      for (const group of vocab.quickPicks) {
        const wrap = el("div", "eegv__annot-quick");
        const label = el("span", "eegv__annot-quick-label");
        label.textContent = group.group;
        wrap.append(label);
        for (const path of group.paths) {
          const entry = byPath.get(path);
          if (!entry) continue;
          const chip = doc.createElement("button");
          chip.type = "button";
          chip.className = "eegv__annot-pick";
          chip.textContent = entry.tag;
          chip.title = entry.description || entry.path;
          chip.addEventListener("click", () => addTag(path));
          wrap.append(chip);
        }
        body.append(wrap);
      }
    }

    // Free text. Written back into the draft on every keystroke, so the
    // re-render that follows the vocabulary chunk landing cannot discard it.
    const comment = doc.createElement("textarea");
    comment.className = "eegv__annot-comment";
    comment.rows = 2;
    comment.value = state.comment;
    comment.setAttribute(
      "aria-label",
      state.kind === "time" ? "Comment" : "Channel status description",
    );
    comment.placeholder = "Optional note";
    comment.addEventListener("input", () => {
      if (popState) popState.comment = comment.value;
    });
    body.append(field(state.kind === "time" ? "Comment" : "Status description", comment));

    // Footer.
    const save = actionButton("Save", "eegv__annot-primary");
    save.addEventListener("click", () => {
      const current = popState;
      if (!current) return;
      if (current.kind === "time") {
        const onsetS = Number(onsetInput?.value ?? current.annotation.onsetS);
        const durationS = Number(durationInput?.value ?? current.annotation.durationS);
        mutate({
          ...set,
          time: upsertTimeAnnotation(
            set.time,
            createTimeAnnotation({
              id: current.annotation.id,
              createdAt: current.annotation.createdAt,
              onsetS: Number.isFinite(onsetS) ? onsetS : current.annotation.onsetS,
              durationS: Number.isFinite(durationS) ? durationS : current.annotation.durationS,
              hedTags: current.tags,
              description: current.comment,
            }),
          ),
        });
      } else {
        mutate({
          ...set,
          channels: upsertChannelAnnotations(set.channels, current.channels, {
            status: statusSelect?.value === "good" ? "good" : "bad",
            hedTags: current.tags,
            description: current.comment,
          }),
        });
        // The annotation is now the source of truth for these channels'
        // status, so bring the montage marking into line with it.
        syncChannelMarks();
      }
      closePopover();
    });
    footer.append(save);

    const removable =
      (state.kind === "time" && !state.isNew) || (state.kind === "channels" && state.existing);
    if (removable) {
      const remove = actionButton("Delete", "eegv__annot-danger");
      remove.addEventListener("click", () => {
        const current = popState;
        if (!current) return;
        if (current.kind === "time") {
          mutate({ ...set, time: removeTimeAnnotation(set.time, current.annotation.id) });
        } else if (current.existing) {
          mutate({ ...set, channels: removeChannelAnnotation(set.channels, current.existing.id) });
        }
        closePopover();
      });
      footer.append(remove);
    }

    const cancel = actionButton("Cancel", "");
    cancel.addEventListener("click", () => closePopover());
    footer.append(cancel);

    popover.append(heading, body, footer);
    // Focus the first useful control, not the dialog: an annotator's next act
    // is almost always to type a term.
    (vocab ? search : (onsetInput ?? save)).focus();
  }

  function resultButton(entry: HedVocabEntry, onPick: (path: HedPath) => void): HTMLElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "eegv__annot-result";
    button.setAttribute("role", "option");
    const name = el("span", "eegv__annot-result-tag");
    name.textContent = entry.tag;
    const schema = el("span", "eegv__annot-result-schema");
    schema.textContent = entry.schema === "SCORE2.1.0" ? "SCORE" : "HED";
    button.append(name, schema);
    if (entry.description) {
      const desc = el("span", "eegv__annot-result-desc");
      desc.textContent = entry.description;
      button.append(desc);
    }
    button.title = entry.path;
    button.addEventListener("click", () => onPick(entry.path));
    return button;
  }

  /**
   * The popover owns every key while it is open. Without the stopPropagation
   * the viewer's root keydown handler would read a typed "d" as "toggle DC
   * removal" and an arrow as "scroll time", both of which also call
   * preventDefault and would break the caret.
   */
  function onPopoverKeyDown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closePopover();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...popover.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (node) => !node.hasAttribute("disabled") && node.offsetParent !== null,
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  popover.addEventListener("keydown", onPopoverKeyDown);

  // --- panel ----------------------------------------------------------------

  function renderPanel(): void {
    opts.panel.hidden = !mode && isAnnotationSetEmpty(set);
    if (opts.panel.hidden) {
      opts.panel.replaceChildren();
      return;
    }
    opts.panel.replaceChildren();

    const bar = el("div", "eegv__annot-bar");
    const count = el("span", "eegv__annot-count");
    count.textContent = `${set.time.length} event${set.time.length === 1 ? "" : "s"} · ${
      set.channels.length
    } channel mark${set.channels.length === 1 ? "" : "s"}`;
    bar.append(count);

    // Downloads: each appears only when its kind has something to write.
    if (set.time.length > 0) {
      const button = actionButton("Download events.tsv", "");
      button.addEventListener("click", () =>
        download(eventsTsvFilename(opts.key.filePath), serializeEventsTsv(set.time)),
      );
      bar.append(button);
    }
    if (set.channels.length > 0) {
      const button = actionButton("Download channels.tsv", "");
      button.addEventListener("click", () =>
        download(channelsTsvFilename(opts.key.filePath), serializeChannelsTsv(set.channels)),
      );
      bar.append(button);
    }

    const selected = opts.getSelectedChannels();
    if (mode) {
      const button = actionButton(
        selected.length > 0
          ? `Annotate ${selected.length} marked channel${selected.length === 1 ? "" : "s"}`
          : "Annotate marked channels",
        "",
      );
      button.disabled = selected.length === 0;
      button.title =
        selected.length > 0
          ? "Describe the channels currently marked in the montage"
          : "Click a channel label in the montage to mark it first";
      button.addEventListener("click", () => openChannelPopover(selected, null));
      bar.append(button);
    }
    opts.panel.append(bar);

    if (mode) {
      const hint = el("p", "eegv__annot-hint");
      hint.textContent =
        "Click the trace for a marker, drag for a span. Click a channel label to mark it.";
      opts.panel.append(hint);
    }

    if (!isAnnotationSetEmpty(set)) {
      const list = el("ul", "eegv__annot-list");
      for (const a of set.time) {
        list.append(
          listRow(
            a.durationS > 0
              ? `${formatSeconds(a.onsetS)}–${formatSeconds(a.onsetS + a.durationS)} s`
              : `${formatSeconds(a.onsetS)} s`,
            annotationLabel(a),
            () => openTimePopover(a, false),
          ),
        );
      }
      for (const c of set.channels) {
        list.append(
          listRow(
            c.channel,
            c.hedTags.length > 0
              ? `${c.status} · ${c.hedTags.map(labelForPath).join(", ")}`
              : c.status,
            () => openChannelPopover([c.channel], c),
          ),
        );
      }
      opts.panel.append(list);
    }

    // The exposure notice. Two separate reasons, one line, because the fix is
    // the same either way: get the file out of the browser.
    const risk: string[] = [];
    if (store && !store.persistent) risk.push("they are not being saved in this browser");
    if (!hasSession()) risk.push("you are not signed in");
    if (!isAnnotationSetEmpty(set) && risk.length > 0) {
      const warn = el("p", "eegv__annot-warn");
      warn.setAttribute("role", "status");
      warn.textContent = `These annotations live only on this device — ${risk.join(
        " and ",
      )}. Download them before you leave.`;
      opts.panel.append(warn);
    }

    if (vocab) {
      const provenance = el("p", "eegv__annot-hint");
      provenance.textContent = `Tags from ${hedVersionSpec(vocab).join(", ")} — add these to the dataset's HEDVersion to validate the export.`;
      opts.panel.append(provenance);
    }
  }

  function listRow(primary: string, secondary: string, onEdit: () => void): HTMLElement {
    const row = doc.createElement("li");
    row.className = "eegv__annot-item";
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "eegv__annot-item-btn";
    const when = el("span", "eegv__annot-item-when");
    when.textContent = primary;
    const what = el("span", "eegv__annot-item-what");
    what.textContent = secondary;
    button.append(when, what);
    button.addEventListener("click", onEdit);
    row.append(button);
    return row;
  }

  function download(filename: string, text: string): void {
    const blob = new Blob([text], { type: "text/tab-separated-values;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = doc.createElement("a");
    link.href = url;
    link.download = filename;
    doc.body.append(link);
    link.click();
    link.remove();
    // Give the navigation a tick to start before the blob goes away.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --- mode toggle ----------------------------------------------------------

  function setMode(next: boolean): void {
    mode = next;
    opts.toggleBtn.setAttribute("aria-pressed", String(mode));
    opts.toggleBtn.classList.toggle("eegv__btn--active", mode);
    opts.root.classList.toggle("eegv--annotating", mode);
    if (!mode) closePopover();
    else void ensureVocab().then(() => renderPanel());
    renderPanel();
    drawOverlay();
  }

  opts.toggleBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    setMode(!mode);
  });

  void restore();
  syncBeforeUnload();

  return {
    onFrame(next) {
      geometry = next;
      drawOverlay();
    },
    onSelectionChanged() {
      renderPanel();
    },
    setActive(active) {
      if (active !== mode) setMode(active);
    },
    isActive() {
      return mode;
    },
    drawOverview,
    flush,
    destroy() {
      destroyed = true;
      // Fire-and-forget: the caller may be tearing down synchronously (a
      // recording swap), and the write is already queued behind whatever else
      // was pending. Losing it would only ever cost the last few hundred ms.
      void flush().then(() => store?.close());
      if (warningArmed) globalThis.removeEventListener("beforeunload", onBeforeUnload);
      warningArmed = false;
      opts.scope.removeEventListener("pointerdown", onPointerDown, true);
      opts.scope.removeEventListener("pointermove", onPointerMove, true);
      opts.scope.removeEventListener("pointerup", onPointerUp, true);
      opts.scope.removeEventListener("pointercancel", onPointerUp, true);
      opts.scope.removeEventListener("click", onClickCapture, true);
      popover.removeEventListener("keydown", onPopoverKeyDown);
      popover.remove();
      canvas.remove();
      opts.panel.replaceChildren();
      opts.panel.hidden = true;
    },
  };
}

// --- small DOM helpers -----------------------------------------------------

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "eegv__annot-field";
  const text = el("span", "eegv__annot-field-label");
  text.textContent = label;
  wrap.append(text, control);
  return wrap;
}

function numberInput(value: string, min: number): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "eegv__annot-num";
  input.step = "0.001";
  input.min = String(min);
  input.value = value;
  return input;
}

function actionButton(label: string, extraClass: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `eegv__annot-btn ${extraClass}`.trim();
  button.textContent = label;
  return button;
}

/** Blend a hex colour with an alpha, for the translucent span fills. */
function withAlpha(hex: string, alpha: number): string {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (clean.length !== 6) return hex;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Inline pencil icon for the annotation-mode toggle. */
export function annotateGlyph(): string {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
}
