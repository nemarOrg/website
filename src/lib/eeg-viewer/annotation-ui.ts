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
  hedShortForm,
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
  artifactQuickPicks,
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
/** Breathing room between the popover and the selection, and the viewer edge. */
const POPOVER_GAP_PX = 8;
/** The popover never shrinks below this, even in a very short viewer. */
const POPOVER_MIN_HEIGHT_PX = 180;
/**
 * How long after the popover has swallowed an Escape a `cancel` on the
 * surrounding dialog is still assumed to belong to that same keypress.
 *
 * Whether `preventDefault()` on the popover's keydown suppresses the dialog's
 * own close request is engine-dependent (the Close Watcher spec leaves the
 * ordering to the user agent), so the guard cannot rely on the popover still
 * being open when `cancel` arrives. Short enough that a deliberate second
 * Escape still closes the dialog.
 */
const ESCAPE_GUARD_MS = 200;
/** Marks the popover while it is being flashed at a blocked navigation. */
const FLASH_CLASS = "eegv__annot-pop--flash";
/** Must outlast the `eegv-annot-flash` keyframes in `BidsTree.astro`. */
const FLASH_DURATION_MS = 950;

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

/** A box in viewer-root coordinates. */
export interface AnnotationRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// --- pure geometry ---------------------------------------------------------
// Module level rather than closed over a layer instance so they can be unit
// tested without a DOM; the layer passes its current frame geometry in.

/** The time under an x offset inside the scope. */
export function timeAtX(x: number, g: AnnotationGeometry): number {
  const span = g.windowEndS - g.windowStartS;
  if (g.plotWidth <= 0 || span <= 0) return g.windowStartS;
  return g.windowStartS + ((x - g.plotLeft) / g.plotWidth) * span;
}

/** The x offset inside the scope at which a time is drawn. */
export function xAtTime(t: number, g: AnnotationGeometry): number {
  const span = g.windowEndS - g.windowStartS;
  if (span <= 0) return g.plotLeft;
  return g.plotLeft + ((t - g.windowStartS) / span) * g.plotWidth;
}

/** A time confined to the window currently on screen. */
export function clampTime(t: number, g: AnnotationGeometry): number {
  return Math.max(g.windowStartS, Math.min(g.windowEndS, t));
}

export interface PopoverPlacementInput {
  /** What is being annotated: the span, the marker, or the channel rows. */
  selection: AnnotationRect;
  /** The popover's measured box. */
  popover: { width: number; height: number };
  /**
   * The area the popover may occupy: the *visible* part of the viewer, which
   * inside the enlarge dialog is smaller than the viewer root itself.
   */
  bounds: AnnotationRect;
  /** The trace area, for the last-resort placement. */
  plot: AnnotationRect;
  gap: number;
}

export interface PopoverPlacement {
  left: number;
  top: number;
  /** Which candidate won; "fallback" is the only one that may overlap. */
  side: "right" | "left" | "below" | "above" | "fallback";
}

/**
 * Place the popover **beside the thing it is about**, never over it.
 *
 * The first version parked it under the toolbar at a fixed offset, which put
 * it on top of the very span the annotator had just dragged out — they were
 * describing a piece of signal they could no longer see. So the candidates are
 * tried in the order that keeps the selection visible and the popover whole:
 *
 *  1. right of the selection, then left of it, vertically centred on it;
 *  2. below it, then above it, horizontally centred on it — for a selection so
 *     wide that neither flank has room;
 *  3. right-centre of the trace area, which may overlap. Only reached when the
 *     selection is wider *and* taller than everything around it, i.e. when
 *     there is nowhere left that does not overlap something.
 *
 * Coordinates are relative to the viewer root, which is the popover's
 * containing block, so this is the same arithmetic inline and enlarged — only
 * the numbers differ.
 */
export function placeAnnotationPopover(input: PopoverPlacementInput): PopoverPlacement {
  const { selection: sel, popover: pop, bounds, plot, gap } = input;
  const minLeft = bounds.left + gap;
  const minTop = bounds.top + gap;
  const limitRight = bounds.left + bounds.width;
  const limitBottom = bounds.top + bounds.height;
  const clampLeft = (x: number): number =>
    Math.max(minLeft, Math.min(x, Math.max(minLeft, limitRight - pop.width - gap)));
  const clampTop = (y: number): number =>
    Math.max(minTop, Math.min(y, Math.max(minTop, limitBottom - pop.height - gap)));

  // Beside: vertically centred on the selection, clamped into the viewer. The
  // clamp cannot cause an overlap — the popover is off to one side either way.
  const besideTop = clampTop(sel.top + sel.height / 2 - pop.height / 2);
  const rightLeft = sel.left + sel.width + gap;
  if (rightLeft + pop.width + gap <= limitRight) {
    return { left: rightLeft, top: besideTop, side: "right" };
  }
  const leftLeft = sel.left - gap - pop.width;
  if (leftLeft >= minLeft) return { left: leftLeft, top: besideTop, side: "left" };

  // Stacked: horizontally centred on the selection, fully clear of its band.
  const stackedLeft = clampLeft(sel.left + sel.width / 2 - pop.width / 2);
  const belowTop = sel.top + sel.height + gap;
  if (belowTop + pop.height + gap <= limitBottom) {
    return { left: stackedLeft, top: belowTop, side: "below" };
  }
  const aboveTop = sel.top - gap - pop.height;
  if (aboveTop >= minTop) return { left: stackedLeft, top: aboveTop, side: "above" };

  return {
    left: clampLeft(plot.left + plot.width - pop.width - gap),
    top: clampTop(plot.top + plot.height / 2 - pop.height / 2),
    side: "fallback",
  };
}

/** Whether a draft carries anything worth storing (Enter-to-save's gate). */
export function hasAnnotationContent(draft: { tags: string[]; comment: string }): boolean {
  return draft.tags.length > 0 || draft.comment.trim() !== "";
}

/**
 * Whether leaving the page should be confirmed: there is work, and it lives
 * only in this browser — either because nobody is signed in to claim it, or
 * because persistence itself has failed. `storePersistent` is null while the
 * store is still opening, which is not yet a known failure.
 */
export function shouldWarnBeforeUnload(input: {
  hasWork: boolean;
  signedIn: boolean;
  storePersistent: boolean | null;
}): boolean {
  if (!input.hasWork) return false;
  return !input.signedIn || input.storePersistent === false;
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
  /**
   * Offer a channel-label click to annotation mode. Returns true when the tool
   * took it — the caller must then leave its own bad-channel toggle alone,
   * because the popover's status field is about to decide that channel's mark.
   */
  onChannelClick(label: string): boolean;
  /** Turn annotation mode on/off (also driven by the toolbar toggle). */
  setActive(active: boolean): void;
  isActive(): boolean;
  /**
   * Whether the annotation popover is open. The surrounding `<dialog>` needs
   * this to tell an Escape aimed at the popover from one aimed at itself, and
   * the page uses it to refuse a recording swap that would silently discard
   * the draft inside it.
   */
  isPopoverOpen(): boolean;
  /**
   * Draw attention to the open popover and put focus back in it. No-op when
   * closed. Called when something outside the viewer refuses to act because
   * the draft is open — the refusal has to point at what is blocking it.
   */
  focusPopover(): void;
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
  /** Set when an export download failed; shown beside the export buttons. */
  let exportError = "";

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
      const opened = await openAnnotationStore();
      // The mount can be torn down while the open is in flight (a recording
      // swap, a dialog close). Nothing else will ever see this connection —
      // `flush` reads `store`, which is still null — so close it here or the
      // IndexedDB handle leaks for the life of the page.
      if (destroyed) {
        opened.close();
        return;
      }
      store = opened;
      // Subscribed before the first read, so a degrade during `load` is caught
      // too. `mutate` runs `syncAll()` synchronously and only *then* schedules
      // the debounced write, so by the time a write fails the UI has already
      // decided there is nothing to warn about — this is the only thing that
      // re-arms the unload guard and repaints the "not being saved" notice for
      // the annotation that actually broke persistence.
      opened.onPersistenceChange(() => {
        if (destroyed) return;
        syncBeforeUnload();
        renderPanel();
      });
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
    const atRisk = shouldWarnBeforeUnload({
      hasWork: !isAnnotationSetEmpty(set),
      signedIn: hasSession(),
      storePersistent: store ? store.persistent : null,
    });
    if (atRisk === warningArmed) return;
    warningArmed = atRisk;
    if (atRisk) globalThis.addEventListener("beforeunload", onBeforeUnload);
    else globalThis.removeEventListener("beforeunload", onBeforeUnload);
  }

  // --- vocabulary -----------------------------------------------------------

  /**
   * Fetch the vocabulary bundle. Called on the first popover open, never on
   * mount: it is ~341 KB in its own chunk, and a reader who never annotates
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
        // annotation on every overlay repaint, and rebuilding a Map over the
        // whole bundle (1525 entries) each time would put that on the render
        // path.
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
   * The short tag for a stored long-form path. Falls back to the short form
   * derived from the path before the vocabulary has loaded (and for a tag a
   * newer bundle dropped), so a restored annotation is always legible.
   */
  function labelForPath(path: HedPath): string {
    // Falls back to the derived short form, NOT the raw path: the vocab chunk
    // loads lazily with the popover, and restored annotations render in the
    // panel before anyone opens it (how long-form paths leaked into the UI).
    return vocabIndex?.get(path)?.tag ?? hedShortForm(path);
  }

  // --- derived state --------------------------------------------------------

  /**
   * Everything the overlay needs that is a function of the *set* rather than
   * of the frame, cached on the set's identity. `drawOverlay` runs on every
   * pointer move of a drag; rebuilding the lane assignment (a sort plus a
   * first-fit pass) and the channel index there would put an O(n log n) walk of
   * every annotation in the recording on the drag path.
   *
   * Keyed on the reference, not invalidated by hand: `set` is only ever
   * replaced, never mutated in place, so a stale cache is impossible.
   */
  let derivedCache: {
    source: AnnotationSet;
    lanes: Map<string, number>;
    byChannel: Map<string, ChannelAnnotation>;
  } | null = null;

  function derived(): { lanes: Map<string, number>; byChannel: Map<string, ChannelAnnotation> } {
    if (!derivedCache || derivedCache.source !== set) {
      derivedCache = {
        source: set,
        lanes: assignOverlapLanes(set.time),
        byChannel: new Map(set.channels.map((c) => [c.channel, c])),
      };
    }
    return derivedCache;
  }

  /** The visible-window filter, shared by the draw pass and the hit test. */
  let visibleCache: {
    source: AnnotationSet;
    startS: number;
    endS: number;
    list: TimeAnnotation[];
  } | null = null;

  function visibleAnnotations(g: AnnotationGeometry): TimeAnnotation[] {
    if (
      !visibleCache ||
      visibleCache.source !== set ||
      visibleCache.startS !== g.windowStartS ||
      visibleCache.endS !== g.windowEndS
    ) {
      visibleCache = {
        source: set,
        startS: g.windowStartS,
        endS: g.windowEndS,
        list: timeAnnotationsInWindow(set.time, g.windowStartS, g.windowEndS),
      };
    }
    return visibleCache.list;
  }

  // --- geometry helpers -----------------------------------------------------

  /** The topmost annotation whose drawn extent contains `x`, or null. */
  function annotationAtX(x: number, g: AnnotationGeometry): TimeAnnotation | null {
    const visible = visibleAnnotations(g);
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
    const visible = visibleAnnotations(g);
    const { lanes, byChannel } = derived();
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
    // Coalesced to one repaint per frame: a pointer can deliver moves faster
    // than the display refreshes, and each one repaints the whole overlay.
    requestOverlayDraw();
  }

  let drawRaf = 0;
  function requestOverlayDraw(): void {
    if (drawRaf !== 0 || typeof requestAnimationFrame !== "function") {
      if (drawRaf === 0) drawOverlay();
      return;
    }
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0;
      drawOverlay();
    });
  }

  function cancelOverlayDraw(): void {
    if (drawRaf !== 0) cancelAnimationFrame(drawRaf);
    drawRaf = 0;
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
  /** Commit the popover as it currently stands; set by `renderPopover`. */
  let submitPopover: (() => void) | null = null;

  function openTimePopover(annotation: TimeAnnotation, isNew: boolean): void {
    popState = {
      kind: "time",
      annotation,
      isNew,
      tags: [...annotation.hedTags],
      comment: annotation.description,
    };
    restoreFocusTo = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    syncDialogGuard();
    void ensureVocab().then(() => {
      if (popState?.kind === "time") renderPopover();
    });
    // The live preview of an unconfirmed annotation: draw it as if it existed
    // so the popover is visibly about a specific piece of the trace. Set before
    // the render so the placement below measures against the drawn selection.
    dragStartS = annotation.onsetS;
    dragCurrentS = annotation.onsetS + annotation.durationS;
    renderPopover();
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
    syncDialogGuard();
    void ensureVocab().then(() => {
      if (popState?.kind === "channels") renderPopover();
    });
    renderPopover();
  }

  /**
   * Make the open popover findable when something outside the viewer refused
   * to act because of it: two pulses of its own accent ring, then focus into
   * it so Enter (save) or Escape (cancel) works straight away.
   *
   * The class is taken off again on a timer rather than left on the element —
   * under `prefers-reduced-motion` the rule is a static ring with no animation
   * to end, and a permanent ring would read as a state rather than a cue.
   */
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  function clearFlash(): void {
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = null;
    popover.classList.remove(FLASH_CLASS);
  }
  function focusPopover(): void {
    if (!popState || popover.hidden) return;
    // Removed and re-added even when it is already on, so a second blocked
    // click is as visible as the first; reading `offsetWidth` forces the
    // reflow that makes the browser treat it as a new animation.
    clearFlash();
    void popover.offsetWidth;
    popover.classList.add(FLASH_CLASS);
    flashTimer = setTimeout(clearFlash, FLASH_DURATION_MS);
    // The first real control, not the popover box: the point is to let the
    // annotator finish or abandon the draft immediately, and both keys are
    // bound on the popover's own keydown.
    popover.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
  }

  function closePopover(): void {
    popState = null;
    submitPopover = null;
    clearFlash();
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
   * The scope's offset inside the viewer root. Measured rather than read off
   * `offsetLeft`, because the scope's offset parent is the plot wrapper (also
   * positioned), not the root the popover is absolutely placed in.
   */
  function scopeOffset(): { x: number; y: number } {
    const scope = opts.scope.getBoundingClientRect();
    const root = opts.root.getBoundingClientRect();
    return { x: scope.left - root.left, y: scope.top - root.top };
  }

  /**
   * The box the open popover is about, in viewer-root coordinates: the span or
   * marker on the trace, or the marked channels' rows in the gutter. Null when
   * there is no frame yet, or in butterfly mode for a channel annotation
   * (no per-slot geometry to point at).
   */
  function selectionRect(): AnnotationRect | null {
    const g = geometry;
    const state = popState;
    if (!g || !state) return null;
    const { x, y } = scopeOffset();
    if (state.kind === "time") {
      const a = state.annotation;
      const x1 = xAtTime(a.onsetS, g);
      const x2 = xAtTime(a.onsetS + a.durationS, g);
      return {
        left: x + Math.min(x1, x2),
        top: y + g.plotTop,
        // A zero-duration marker is drawn as a line; give it a couple of pixels
        // so "beside it" means beside the line, not exactly on it.
        width: Math.max(2, Math.abs(x2 - x1)),
        height: g.plotHeight,
      };
    }
    if (g.butterfly) return null;
    const wanted = new Set(state.channels);
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < g.slots.length; i++) {
      if (!wanted.has(g.channelLabels[i] ?? "")) continue;
      const slot = g.slots[i];
      top = Math.min(top, slot.baseline - slot.halfHeight);
      bottom = Math.max(bottom, slot.baseline + slot.halfHeight);
    }
    if (!Number.isFinite(top)) return null;
    // The gutter strip carrying those labels: the popover goes beside it, so
    // the channel names it is about stay readable.
    return { left: x, top: y + top, width: g.plotLeft, height: Math.max(2, bottom - top) };
  }

  /**
   * The part of the viewer that is actually on screen, in root coordinates:
   * the root's own box, intersected with the viewport and with every clipping
   * ancestor.
   *
   * The enlarge dialog is why this is load-bearing rather than defensive. The
   * viewer root inside it is *taller than the dialog*, which clips it, so
   * "inside the root" and "visible" are different boxes — placing against the
   * root's own height puts the popover's footer below the dialog's edge, which
   * is precisely what pinning the footer is meant to prevent.
   */
  function visibleBounds(): AnnotationRect {
    const rootBox = opts.root.getBoundingClientRect();
    let left = rootBox.left;
    let top = rootBox.top;
    let right = rootBox.right;
    let bottom = rootBox.bottom;
    const view = doc.defaultView;
    if (view) {
      left = Math.max(left, 0);
      top = Math.max(top, 0);
      right = Math.min(right, view.innerWidth);
      bottom = Math.min(bottom, view.innerHeight);
      // Stops at <body>: overflow on the root element (and on body, when the
      // root's is visible) is *propagated to the viewport* rather than
      // clipping a box, and `documentElement.getBoundingClientRect()` on a
      // scrolled page returns a box far above the viewport. Intersecting with
      // it would shrink the bounds to nothing — the dataset page sets
      // `overflow-x: clip` on <html>, so this is the common case, not a
      // theoretical one.
      for (
        let node = opts.root.parentElement;
        node && node !== doc.body && node !== doc.documentElement;
        node = node.parentElement
      ) {
        const style = view.getComputedStyle(node);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const box = node.getBoundingClientRect();
        left = Math.max(left, box.left);
        top = Math.max(top, box.top);
        right = Math.min(right, box.right);
        bottom = Math.min(bottom, box.bottom);
      }
    }
    return {
      left: left - rootBox.left,
      top: top - rootBox.top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  /** The trace area in viewer-root coordinates, for the last-resort placement. */
  function plotRect(): AnnotationRect {
    const g = geometry;
    if (!g)
      return { left: 0, top: 0, width: opts.root.clientWidth, height: opts.root.clientHeight };
    const { x, y } = scopeOffset();
    return { left: x + g.plotLeft, top: y + g.plotTop, width: g.plotWidth, height: g.plotHeight };
  }

  /**
   * Put the popover where `placeAnnotationPopover` says, after capping its
   * height to the viewer so a long vocabulary list cannot push the footer out
   * of the frame. Re-run on every render and every frame the popover survives,
   * which is what makes it follow a resize and a time scrub.
   */
  function positionPopover(): void {
    if (!popState || popover.hidden) return;
    const bounds = visibleBounds();
    popover.style.maxBlockSize = `${Math.max(
      POPOVER_MIN_HEIGHT_PX,
      bounds.height - POPOVER_GAP_PX * 2,
    )}px`;
    const box = popover.getBoundingClientRect();
    const plot = plotRect();
    const selection = selectionRect();
    const placement = placeAnnotationPopover({
      // With no selection to avoid (no frame yet, or butterfly), a zero-size
      // box at the trace's right edge lands the popover in the fallback spot
      // without a special case.
      selection: selection ?? {
        left: plot.left + plot.width,
        top: plot.top + plot.height / 2,
        width: 0,
        height: 0,
      },
      popover: { width: box.width, height: box.height },
      bounds,
      plot,
      gap: POPOVER_GAP_PX,
    });
    popover.style.left = `${Math.round(placement.left)}px`;
    popover.style.top = `${Math.round(placement.top)}px`;
    popover.dataset.side = placement.side;
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
        chip.title = path;
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
      // While a query is live the results ARE the vocabulary view; leaving
      // the quick-pick groups stacked under them reads as more results and
      // buries the real ones (Yahya's QA). Clearing the box brings them back.
      quickBox.hidden = !!vocab && query.trim() !== "";
      if (!vocab || query.trim() === "") return;
      const hits = searchVocab(vocab.entries, query, SEARCH_RESULT_LIMIT);
      if (hits.length === 0) {
        const none = el("p", "eegv__annot-hint");
        none.textContent = "No matching term.";
        results.append(none);
        return;
      }
      for (const { entry } of hits)
        results.append(
          resultButton(entry, (path, viaMouse) => {
            addTag(path);
            // Same focus hand-back as the quick-pick chips: a mouse pick must
            // not leave Enter meaning "re-pick this result".
            if (viaMouse) search.focus();
          }),
        );
    }
    body.append(search, results);
    if (vocabError) {
      const warn = el("p", "eegv__annot-hint");
      warn.textContent = vocabError;
      body.append(warn);
    }

    // Quick picks. A channel annotation gets the artifact vocabulary instead of
    // the general one: the flow the pencil now offers is click a channel, pick
    // the noise it carries, save.
    const quickBox = el("div", "eegv__annot-quickbox");
    if (vocab && vocabIndex) {
      const byPath = vocabIndex;
      const picks = state.kind === "channels" ? artifactQuickPicks(vocab) : vocab.quickPicks;
      for (const group of picks) {
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
          chip.addEventListener("click", (ev) => {
            addTag(path);
            // A mouse click (detail > 0) leaves focus stranded on the chip,
            // where Enter re-activates the chip instead of saving (BUTTON is
            // in ENTER_OWNING_TAGS, deliberately, for keyboard users — whose
            // activation arrives with detail 0 and must keep focus). Hand
            // focus back to the search box so Return means save again.
            if (ev.detail > 0) search.focus();
          });
          wrap.append(chip);
        }
        quickBox.append(wrap);
      }
    }
    body.append(quickBox);

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

    // Footer. Pinned: it never scrolls with the body above it, so Save and
    // Cancel are on screen whatever the vocabulary list is doing.
    const save = actionButton("Save", "eegv__annot-primary");
    // Hoisted out of the click handler so Enter can commit the same draft
    // without synthesising a click on a button that may not have focus.
    submitPopover = (): void => {
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
        // status, so bring the montage marking into line with it. The panel is
        // rendered again afterwards because `mutate` drew it *before* the
        // marking changed, and the bulk "annotate marked channels" entry
        // point keys off exactly that marking.
        syncChannelMarks();
        renderPanel();
      }
      closePopover();
    };
    save.addEventListener("click", () => submitPopover?.());

    const shortcut = el("span", "eegv__annot-foot-hint");
    shortcut.textContent = "Enter saves · Esc cancels";
    footer.append(shortcut, save);

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
    // Placed only once the content is in: the height decides which side has
    // room, so measuring before this point would place an empty box.
    positionPopover();
    // Focus the first useful control, not the dialog: an annotator's next act
    // is almost always to type a term.
    (vocab ? search : (onsetInput ?? save)).focus({ preventScroll: true });
  }

  function resultButton(
    entry: HedVocabEntry,
    onPick: (path: HedPath, viaMouse: boolean) => void,
  ): HTMLElement {
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
    button.addEventListener("click", (ev) => onPick(entry.path, ev.detail > 0));
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
      // Remembered because the enlarge dialog's own Escape handling may run
      // *after* this, by which time the popover is already gone — see
      // `onDialogCancel`.
      escapeConsumedAt = Date.now();
      closePopover();
      return;
    }
    if (event.key === "Enter") {
      const target = event.target;
      const composing = event.isComposing || event.keyCode === 229;
      if (
        !enterMeansSubmit({
          composing,
          shiftKey: event.shiftKey,
          tagName: target instanceof Element ? target.tagName : "",
        })
      ) {
        return;
      }
      // Only once there is something to save. Enter on an empty draft would
      // otherwise store a nameless marker the annotator never described.
      if (!popState || !hasAnnotationContent(popState)) return;
      event.preventDefault();
      submitPopover?.();
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

  // --- Escape and the enlarge dialog ----------------------------------------

  /**
   * The viewer's host is *moved* into the page's `<dialog>` when enlarged
   * (website#199), so the dialog around this layer changes over its life and
   * is looked up whenever the popover opens rather than once at mount.
   *
   * Why a `cancel` listener at all, when the popover's own keydown already
   * calls `preventDefault()`: a modal dialog closes on Escape through the
   * close-watcher machinery, and whether a cancelled keydown suppresses that
   * is not something the spec pins down per engine. Without this guard one
   * Escape could close the popover *and* the enlarged viewer behind it,
   * throwing away the annotator's place in the recording along with a
   * half-written annotation.
   */
  let guardedDialog: HTMLDialogElement | null = null;
  let escapeConsumedAt = 0;

  const onDialogCancel = (event: Event): void => {
    if (popState !== null || Date.now() - escapeConsumedAt < ESCAPE_GUARD_MS) {
      event.preventDefault();
    }
  };

  function syncDialogGuard(): void {
    const dialog = opts.root.closest("dialog");
    if (dialog === guardedDialog) return;
    guardedDialog?.removeEventListener("cancel", onDialogCancel);
    guardedDialog = dialog;
    guardedDialog?.addEventListener("cancel", onDialogCancel);
  }

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
      const button = actionButton("Download channel annotations", "");
      button.title =
        "A channels.tsv-shaped file listing only the channels you marked — merge it into the dataset's own channels.tsv";
      button.addEventListener("click", () =>
        download(channelsTsvFilename(opts.key.filePath), serializeChannelsTsv(set.channels)),
      );
      bar.append(button);
    }

    const selected = opts.getSelectedChannels();
    // Bulk entry point, for channels already marked in the montage (annotation
    // mode's own channel click annotates one at a time). Offered only when
    // there is a marking to act on, so it never advertises a dead control.
    if (mode && selected.length > 0) {
      const button = actionButton(
        `Annotate ${selected.length} marked channel${selected.length === 1 ? "" : "s"}`,
        "",
      );
      button.title = "Describe the channels currently marked in the montage as one set";
      button.addEventListener("click", () => {
        // Mirror the gutter click's edit-not-replace behavior: a single marked
        // channel that already carries an annotation opens prefilled (tags,
        // status, comment) instead of a blank draft that would silently
        // overwrite it on save. A multi-channel set stays a fresh draft — its
        // save intentionally describes the whole set as one.
        const existing =
          selected.length === 1
            ? (set.channels.find((c) => c.channel === selected[0]) ?? null)
            : null;
        openChannelPopover(selected, existing);
      });
      bar.append(button);
    }
    opts.panel.append(bar);

    // Immediately under the export buttons, because that is the control it is
    // about. `role="alert"` rather than the notice's "status": this one is the
    // result of something the annotator just did.
    if (exportError !== "") {
      const failed = el("p", "eegv__annot-warn");
      failed.setAttribute("role", "alert");
      failed.textContent = exportError;
      opts.panel.append(failed);
    }

    // The channels file is deliberately partial: it names only what somebody
    // marked and omits the type/units columns that belong to the dataset. Say
    // so beside the button rather than only in the serializer's docstring —
    // a bare `channels.tsv` name would invite dropping it into a dataset as-is.
    if (set.channels.length > 0) {
      const caveat = el("p", "eegv__annot-hint");
      caveat.textContent =
        "The channel file covers only the channels you annotated; merge it into the dataset's channels.tsv rather than using it as one.";
      opts.panel.append(caveat);
    }

    if (mode) {
      const hint = el("p", "eegv__annot-hint");
      hint.textContent =
        "Click the trace for a marker, drag for a span. Click a channel label to annotate that channel.";
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
            a.hedTags.join(", "),
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
            c.hedTags.join(", "),
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

  function listRow(
    primary: string,
    secondary: string,
    onEdit: () => void,
    titleText = "",
  ): HTMLElement {
    const row = doc.createElement("li");
    row.className = "eegv__annot-item";
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "eegv__annot-item-btn";
    // Short form in the row, long form on hover (HED's default reading order).
    if (titleText) button.title = titleText;
    const when = el("span", "eegv__annot-item-when");
    when.textContent = primary;
    const what = el("span", "eegv__annot-item-what");
    what.textContent = secondary;
    button.append(when, what);
    button.addEventListener("click", onEdit);
    row.append(button);
    return row;
  }

  /**
   * Wrapped because the download IS the escape hatch. Annotations live only in
   * this browser, and the panel's own notice tells the annotator to get the
   * file out before they leave — so a `createObjectURL`/`click` that throws (a
   * sandboxed frame, an exhausted blob-URL budget, a policy blocking
   * programmatic downloads) must not look like a button that does nothing.
   */
  function download(filename: string, text: string): void {
    try {
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
      if (exportError !== "") {
        exportError = "";
        renderPanel();
      }
    } catch (err) {
      console.error("[eeg-viewer] annotations: export download failed:", err);
      exportError = `Couldn't start the download of ${filename}. Check that this browser allows downloads from this page, then try again.`;
      renderPanel();
    }
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

  /**
   * A viewport resize moves the viewer without necessarily re-rendering it
   * (the viewer's own ResizeObserver only repaints on a *width* change), so
   * the popover needs its own hook to stay beside its selection.
   */
  let resizeRaf = 0;
  const onWindowResize = (): void => {
    if (!popState) return;
    // Twice on purpose. Once now, so the popover is placed even where frame
    // callbacks never arrive; and once on the next frame, because a resize can
    // be delivered before the new viewport metrics have settled and the first
    // placement would then be sized for the window that just went away. The
    // pending frame is cancelled rather than skipped, so a callback the browser
    // never ran (a backgrounded tab mid-resize) cannot wedge the later ones.
    positionPopover();
    if (typeof requestAnimationFrame !== "function") return;
    if (resizeRaf !== 0) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (popState) positionPopover();
    });
  };
  globalThis.addEventListener("resize", onWindowResize);

  void restore();
  syncBeforeUnload();

  return {
    onFrame(next) {
      geometry = next;
      drawOverlay();
      // The selection has moved with the frame — scrubbing time, zooming
      // channels, the dialog opening. Follow it.
      if (popState) positionPopover();
    },
    onSelectionChanged() {
      renderPanel();
    },
    onChannelClick(label) {
      if (!mode) return false;
      // Editing rather than adding when this channel already has a mark, so a
      // second click on the same label reopens what is there instead of
      // silently replacing it.
      const existing = set.channels.find((c) => c.channel === label) ?? null;
      openChannelPopover([label], existing);
      return true;
    },
    setActive(active) {
      if (active !== mode) setMode(active);
    },
    isActive() {
      return mode;
    },
    isPopoverOpen() {
      return popState !== null;
    },
    focusPopover,
    drawOverview,
    flush,
    destroy() {
      destroyed = true;
      clearFlash();
      cancelOverlayDraw();
      if (resizeRaf !== 0) cancelAnimationFrame(resizeRaf);
      resizeRaf = 0;
      guardedDialog?.removeEventListener("cancel", onDialogCancel);
      guardedDialog = null;
      globalThis.removeEventListener("resize", onWindowResize);
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

/**
 * Controls whose own meaning for Enter outranks "save": a textarea's newline,
 * and the activation of a button, link or select. Stealing Enter from a
 * quick-pick chip would make the whole vocabulary keyboard-unreachable.
 */
const ENTER_OWNING_TAGS = new Set(["TEXTAREA", "BUTTON", "A", "SELECT"]);

/** Whether an Enter pressed inside the popover means "save this annotation". */
export function enterMeansSubmit(input: {
  /** Mid-IME-composition: the Enter is committing a candidate, not a form. */
  composing: boolean;
  shiftKey: boolean;
  /** The focused element's tag name, upper case; "" when there is none. */
  tagName: string;
}): boolean {
  if (input.composing || input.shiftKey) return false;
  return !ENTER_OWNING_TAGS.has(input.tagName);
}

/** Blend a hex colour with an alpha, for the translucent span fills. */
export function withAlpha(hex: string, alpha: number): string {
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
