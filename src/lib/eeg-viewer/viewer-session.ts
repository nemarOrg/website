/**
 * The signal viewer's session: the one live instance, the recording it shows,
 * and the chrome that navigates between recordings (website#253, #326, #410).
 *
 * Two surfaces drive it, and that is the reason it exists as a module:
 *
 * - the dataset page's enlarge dialog (`src/pages/dataset/[id].astro`, inside
 *   `EegViewerDialog.astro`), and
 * - the chrome-free embed route (`src/pages/dataset/[id]/embed.astro`), which
 *   partner sites put in an iframe.
 *
 * Until website#410 this orchestration lived inline in the dataset page's
 * script. Lifting it here, rather than giving the embed a second copy, means a
 * viewer feature (a new nav control, a fix to the draft guard, a change to
 * how `?view=` resolves) is written once and lands on both surfaces. What
 * differs between them arrives as hooks (`ViewerSessionHooks`), never as a
 * branch on "is this the embed": how the host is presented, whether the chrome
 * is on screen, the extra mount options, and how share links are built.
 *
 * What this module owns:
 * - the live instance and the `seq` supersession counter, so a fast
 *   next/next/next cannot strand a mount, a store fetch, or a WebGL context
 *   (website#208);
 * - opening a recording, navigating to another, and the prev/next and
 *   subject/task controls in `EegViewerNav.astro`;
 * - the unsaved-annotation draft guard, the settings carried across a swap,
 *   neighbour prefetch, and the units notice;
 * - `?view=` resolution on load and keeping `?view=` in the address bar;
 * - the Copy link and Embed controls.
 *
 * What it does not own: anything about the BIDS tree (the dataset page's
 * inline row, its Enlarge control, handing the instance back on close). The
 * page drives those itself through the lower-level `claim`/`mount`/`release`
 * calls below, so the tree never leaks into the embed.
 *
 * The chrome is static markup found by its `data-eegv-*` attributes with
 * `document.querySelector`, exactly as the page script found it before the
 * move; each page renders one instance of each control.
 */

import { isDirRecordingName } from "../bids-tree";
import { fileDownloadUrl } from "../dir-listing";
import { type ZarrIndexStore, prefetchZarrStoreMetadata, unitsNoticeText } from "../zarr-index";
import {
  NAV_ORDER_CHANGED_EVENT,
  type NavOrder,
  type RecordingEntry,
  VIEW_PARAM,
  buildRecordingList,
  firstRecording,
  formatViewSpec,
  orderedRecordings,
  readNavOrder,
  recordingPosition,
  resolveViewParam,
  selectRecording,
  stepRecording,
  subjectValues,
  taskValues,
} from "./recording-nav";
// Type-only, so importing this module does not pull the (WebGL-carrying)
// viewer into a page bundle; the mount stays behind the dynamic import below.
import type { ViewerAnnotationHandle, ViewerOptions, ViewerTransferState } from "./viewer";

/** The slice of a dataset's Zarr index state the session reads and warms. */
export interface SessionZarr {
  stores: Map<string, ZarrIndexStore>;
  /** Shared with whoever else prefetches (the tree rows), so no store is warmed twice. */
  prefetched: Set<string>;
  /** Cache-busting token for this conversion (index `updated_utc`; #240). */
  token: string;
}

/** The dataset a recording is opened in. */
export interface SessionContext {
  datasetId: string;
  version: string;
  /** Every viewable recording in this dataset, in Zarr index order. */
  recordings: RecordingEntry[];
  zarrToken: string;
  zarr: SessionZarr | null;
}

/** A dataset's Zarr state as a page holds it: the session's slice plus the
 *  viewable paths the recording list is built from. */
export interface SessionZarrState extends SessionZarr {
  /** Every path with a served store (`zarrAvailablePaths`), in index order. */
  paths: Iterable<string>;
}

/**
 * The {@link SessionContext} for a dataset, built in one place for every page
 * that opens a recording (the dataset page's inline row, its View data button
 * and `?view=` link, and the embed).
 *
 * The recording list comes from the index, not from the DOM: the tree only
 * holds the directories the user has expanded, while the index lists every
 * viewable recording (website#253). `zarr` is passed through as is, so its
 * `prefetched` set stays shared with whatever else warms stores (the tree
 * rows). With no index the list is empty and the cache token "", which opens
 * stores with the un-busted URL rather than not at all (#240).
 */
export function sessionContext(
  datasetId: string,
  version: string,
  zarr: SessionZarrState | null,
): SessionContext {
  return {
    datasetId,
    version,
    recordings: zarr ? buildRecordingList(zarr.paths) : [],
    zarrToken: zarr?.token ?? "",
    zarr,
  };
}

/**
 * The live instance. Held here rather than re-read from the DOM, because a
 * navigation remounts the viewer into the same host, and the recording it
 * swaps to may have no row in the tree at all (directories load lazily).
 */
export interface LiveViewer extends SessionContext {
  /** The element `mountEegViewer` owns. The dataset page moves it between its
   *  tree row and the dialog; the session never moves it. */
  host: HTMLElement;
  fileName: string;
  destroy: (() => void) | null;
  /** BIDS path of the recording on screen; changes on every navigation. */
  path: string;
  /**
   * The recording that last finished mounting live in `host`. Differs from
   * `path` while a navigation is in flight, and is what a failed navigation
   * puts the chrome back on: after A, next (B in flight), next (C throws), the
   * one recording the visitor actually saw is A, not B.
   */
  shownPath: string;
  shownName: string;
  /**
   * False while the instance is still tied to wherever the page opened it
   * (the dataset page's inline tree row). The first navigation calls
   * `hooks.onDetach` and sets it: the viewer no longer shows that row's
   * recording, so the page lets go of the row.
   */
  detached: boolean;
  /** Settings to carry into the next recording (website#253). */
  snapshot: (() => ViewerTransferState) | null;
  /**
   * The instance's annotation layer, for asking whether an unsaved draft is
   * open before a navigation destroys it. Null until the mount reports one
   * (and for a mount that produced no viewer, which has no drafts to lose).
   */
  annotations: ViewerAnnotationHandle | null;
}

/** Mount options a page adds to every mount the session makes. */
export type SessionMountOptions = Pick<
  ViewerOptions,
  "fitHeight" | "scopeOverlay" | "unavailableLink"
>;

/** Where the session is opening or navigating, for hooks that need to say so. */
export type SessionPhase = "open" | "navigate";

export interface ViewerSessionHooks {
  /**
   * Whether the session's chrome is on screen. The dialog answers with
   * `dialog.open`; the embed is always showing. Navigation is refused while
   * it is false, and `?view=` is only written while it is true.
   */
  isShowing(): boolean;
  /** Name the recording the chrome describes. */
  setTitle(name: string): void;
  /**
   * Put the host `openRecording` just built where it is seen, and reveal it
   * (the dialog fills its slot and calls `showModal`). Returns false, having
   * changed nothing, when it cannot (its markup is missing); `openRecording`
   * then stops before releasing the current viewer or mounting anything,
   * rather than tear down what is on screen to mount into a detached host.
   */
  present(host: HTMLElement): boolean;
  /** After `release` tore the previous instance down: page-side cleanup. */
  onRelease?(released: LiveViewer | null): void;
  /** The first navigation away from an instance that was not yet detached. */
  onDetach?(live: LiveViewer): void;
  /** A mount through `openRecording` or `mount` produced a live viewer. */
  onViewerOpen?(host: HTMLElement): void;
  /**
   * Extra options for every mount, decided per recording (the embed's
   * `fitHeight`, its NEMAR mark as `scopeOverlay`, and an `unavailableLink`
   * back to the dataset page). The dataset page passes none.
   */
  mountOptions?(recording: { path: string; fileName: string }): SessionMountOptions;
  /**
   * The action a "couldn't open" message offers when a mount threw, as HTML,
   * phrased to complete "Couldn't open NAME. … instead.".
   */
  fallbackActionHtml(target: RecordingEntry, ctx: SessionContext, phase: SessionPhase): string;
  /** A `?view=` value resolved to nothing; say so where the visitor can see it. */
  onViewParamMiss?(raw: string, reason: string): void;
  /**
   * The recording on screen changed (or none is). Called on every link-state
   * sync with the `?view=` value now in the address bar, so chrome that links
   * to the recording (the embed's "Open on NEMAR") can follow it.
   */
  onRecordingShown?(live: LiveViewer | null, viewSpec: string | null): void;
  /** The Copy link control's link for a `?view=` value. Absent: no-op control. */
  shareLink?(viewSpec: string): string;
  /** The Embed control's snippet for the recording on screen. Absent: no-op control. */
  embedSnippet?(live: LiveViewer, entry: RecordingEntry | null, viewSpec: string): string;
}

/** What `mount` produced, with the sequence number it claimed. */
export interface MountOutcome {
  seq: number;
  kind: "live" | "unavailable" | "failed" | "superseded";
  /**
   * With `kind: "failed"`: the viewer's own code failed to load. Chromium and
   * WebKit remember a failed dynamic `import()` for the life of the document and
   * answer the next one from that failure without asking the network, so
   * re-running the open cannot recover from it; only a reload can.
   */
  moduleFailed?: boolean;
}

export interface MountRequest {
  host: HTMLElement;
  path: string;
  fileName: string;
  ctx: SessionContext;
  detached: boolean;
  dirRecording: boolean;
  downloadUrl: string;
  /** Console prefix for a mount that threw. */
  logLabel: string;
  /** What Try again does on the viewer's own "could not load" message (website#416). */
  onRetry?: () => void;
  /** Runs after the session claimed the instance, before the mount starts. */
  afterClaim?(): void;
}

export interface ViewerSession {
  /** The live instance, or null. */
  readonly live: LiveViewer | null;
  /** Bump the sequence and return the claim, superseding anything in flight. */
  claim(): number;
  /** Whether `seq` is still the newest claim. */
  isCurrent(seq: number): boolean;
  /** Tear the live instance down (if any), then `hooks.onRelease`. */
  release(): void;
  /**
   * End the live instance where a navigate may be mid-mount: disposes through
   * the host's own cleanup when the session holds no disposer yet.
   */
  end(): void;
  /** Mount a recording into `host` as the new live instance (lower level). */
  mount(req: MountRequest): Promise<MountOutcome>;
  /** Open a recording in a fresh host that `hooks.present` places. */
  openRecording(target: RecordingEntry, ctx: SessionContext): Promise<void>;
  /** Open the first recording in the visitor's nav order. False when there is none. */
  openFirst(ctx: SessionContext): Promise<boolean>;
  /** Resolve and open a `?view=` value. False (after `onViewParamMiss`) on a miss. */
  openViewParam(raw: string, ctx: SessionContext | null): Promise<boolean>;
  navigate(target: RecordingEntry): Promise<void>;
  step(delta: number): void;
  /** Reflect the live instance in the nav controls (and the URL). */
  syncNav(): void;
  /** Reflect the live instance in `?view=` and the share controls. */
  syncLinkState(): void;
  prefetchAdjacent(): void;
  /** Refuse (and point at the popover) while an unsaved annotation draft is open. */
  draftBlocksNavigation(): boolean;
  /** Bind the nav and share controls. Call once; the markup is static. */
  wire(): void;
}

/** The `?view=` value naming `path`: its BIDS entities, or the path itself. */
export function viewSpecForPath(recordings: RecordingEntry[], path: string): string {
  const entry = recordings.find((e) => e.path === path);
  // `formatViewSpec` falls back to the path itself for a recording that names
  // no entities, so a non-BIDS dataset still gets a working link.
  return entry ? formatViewSpec(entry) : path;
}

/** Everything the nav controls show for one position, computed without a DOM. */
export interface NavControlState {
  current: RecordingEntry | null;
  subjects: string[];
  /** Scoped to the subject on screen, so every option resolves to a real recording. */
  tasks: string[];
  position: string;
  before: RecordingEntry | null;
  after: RecordingEntry | null;
  prevLabel: string;
  nextLabel: string;
}

/**
 * What `syncNav` writes into the controls for the recording at `path`. Pure
 * and exported so the counter and label wording are unit tested; the DOM
 * half, including the focus hand-off, is covered by the browser
 * characterization of the dialog.
 */
export function navControlState(
  recordings: RecordingEntry[],
  path: string,
  order: NavOrder,
): NavControlState {
  const current = recordings.find((e) => e.path === path) ?? null;
  const subjects = subjectValues(recordings);
  const tasks = taskValues(recordings, current?.sub ?? null);
  const ordered = orderedRecordings(recordings, order);
  const at = recordingPosition(ordered, path);
  const position = at >= 0 ? `${at + 1} of ${ordered.length}` : `${ordered.length} recordings`;
  const before = at > 0 ? ordered[at - 1] : null;
  const after = at >= 0 ? (ordered[at + 1] ?? null) : null;
  return {
    current,
    subjects,
    tasks,
    position,
    before,
    after,
    prevLabel: before ? `Previous recording: ${before.name}` : "No previous recording",
    nextLabel: after ? `Next recording: ${after.name}` : "No next recording",
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The class of the retry button, so the page that styles it and the session that wires it agree. */
export const RETRY_CLASS = "preview__retry";
const FAILURE_TEXT_ID = "eegv-open-failure";

/**
 * The message a first open that threw leaves in its host. `fallbackHtml`
 * completes "Couldn't open NAME. … instead." and is trusted markup from the
 * page's hook; the name is a file name and is escaped. The button sits inside
 * the alert so it wraps with the sentence at any width, and is described by the
 * sentence so focus landing on it still reads the error aloud.
 *
 * The button says "Try again" when pressing it re-runs the open, and "Reload
 * page" when the viewer's code did not load (`MountOutcome.moduleFailed`),
 * which only a reload can fix. `again` marks a message shown after a retry
 * failed, so a click that changed nothing else on screen still reads as having
 * done something.
 */
export function openFailureHtml(
  name: string,
  fallbackHtml: string,
  state: { reload?: boolean; again?: boolean } = {},
): string {
  const label = state.reload ? "Reload page" : "Try again";
  const lead = state.again ? "Still couldn't open" : "Couldn't open";
  return `<p class="preview__error" role="alert"><span id="${FAILURE_TEXT_ID}">${lead} ${escapeHtml(name)}. ${fallbackHtml} instead.</span> <button type="button" class="${RETRY_CLASS}" aria-describedby="${FAILURE_TEXT_ID}">${label}</button></p>`;
}

/**
 * Where Reload goes: the current address with `?view=` naming the recording
 * that failed. By the time the button is on screen the session has already
 * stripped `?view=` (nothing is live), so a bare reload would land the visitor
 * on a different recording, or none, without a word.
 */
export function reloadUrl(href: string, viewSpec: string | null): string {
  const url = new URL(href);
  if (viewSpec !== null) url.searchParams.set(VIEW_PARAM, viewSpec);
  return url.toString();
}

function navEl<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

/**
 * Append the units notice (website#277 decision 4) as the last child of a
 * just-mounted viewer host. Safe at every mount site: `host` is either freshly
 * created or `mountEegViewer` tore down and rebuilt its own contents as its
 * first act before this runs, so there is never a stale notice to clear first.
 * No-ops when `unitsNoticeText` has nothing to say (v1 stores, or a store with
 * nothing to flag).
 */
function applyUnitsNotice(host: HTMLElement, store: ZarrIndexStore | undefined): void {
  const text = unitsNoticeText(store);
  if (!text) return;
  const p = document.createElement("p");
  p.className = "eegv-units-notice";
  p.setAttribute("role", "note");
  p.textContent = text;
  host.appendChild(p);
}

/**
 * Fill one of the entity dropdowns. A current value that is not among the
 * options (the recording on screen has no `task` while its siblings do) gets a
 * leading placeholder entry rather than silently displaying some other
 * recording's label.
 */
function fillNavSelect(
  sel: HTMLSelectElement,
  values: string[],
  prefix: string,
  current: string | null,
): void {
  sel.replaceChildren();
  if (current === null) {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "—";
    sel.append(none);
  }
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${prefix}${value}`;
    sel.append(option);
  }
  sel.value = current ?? "";
}

export function createViewerSession(hooks: ViewerSessionHooks): ViewerSession {
  // `seq` is bumped on every open *and* every release; a mount attempt whose
  // captured value no longer matches by the time it resolves was superseded
  // and tears itself down instead of touching the DOM. At most one viewer is
  // live per page: each mount holds a WebGL context and browsers cap those
  // (~16), so opening another recording releases the first.
  let seq = 0;
  let live: LiveViewer | null = null;
  /** Pending reset of the copy confirmation. */
  let copyStatusTimer = 0;

  function mountOptionsFor(path: string, fileName: string): SessionMountOptions {
    return hooks.mountOptions?.({ path, fileName }) ?? {};
  }

  /**
   * Dispose whatever viewer `host` holds: the session's handle on it, or, for
   * a mount that threw before handing one back, the host's own cleanup
   * (`mountEegViewer` registers one before its first await). Clears both, so
   * nothing can dispose the same instance twice, and a throw from the
   * teardown itself is logged rather than allowed to mask the failure that
   * led here.
   */
  function disposeHost(record: LiveViewer | null, host: HTMLElement): void {
    const owned = host as HTMLElement & { _eegvCleanup?: () => void };
    const cleanup = record?.destroy ?? owned._eegvCleanup;
    if (record) record.destroy = null;
    owned._eegvCleanup = undefined;
    try {
      cleanup?.();
    } catch (err) {
      console.error("[eeg-viewer] teardown threw:", err);
    }
  }

  /**
   * Run a side effect of a mount that has already succeeded (the units
   * notice, analytics, neighbour prefetch). Logged, never rethrown: a failure
   * here must not turn a working viewer into a "couldn't open" message while
   * the viewer keeps running unowned underneath it.
   */
  function bestEffort(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`[eeg-viewer] ${what} failed; the viewer is unaffected:`, err);
    }
  }

  function release(): void {
    seq++; // invalidate any mount still in flight
    const released = live;
    live = null;
    released?.destroy?.();
    hooks.onRelease?.(released);
  }

  function end(): void {
    const ended = live;
    if (!ended) return;
    // Bump first so any mount still in flight stands down instead of writing
    // into a host that is about to be discarded.
    seq++;
    live = null;
    // `navigate` nulls `live.destroy` before awaiting the new mount, so between
    // the mount publishing its own `_eegvCleanup` on the host and returning the
    // disposer there is a window where the session has no handle to call; the
    // instance would keep its observers, GL context and background reads alive
    // until the post-await staleness check happened to run. The host's own
    // cleanup is the backstop for exactly that window; taking whichever handle
    // exists (and clearing the host's) keeps this down to one teardown. What
    // makes "never twice" true overall is `mountEegViewer`'s own `disposed`
    // guard: the superseded branch of `navigate` can still call the same
    // disposer after this has, and only the closure can see that.
    disposeHost(ended, ended.host);
  }

  async function mount(req: MountRequest): Promise<MountOutcome> {
    const { host, path, fileName, ctx } = req;
    const mySeq = ++seq;
    live = {
      host,
      fileName,
      destroy: null,
      datasetId: ctx.datasetId,
      version: ctx.version,
      zarrToken: ctx.zarrToken,
      path,
      shownPath: path,
      shownName: fileName,
      recordings: ctx.recordings,
      zarr: ctx.zarr,
      detached: req.detached,
      snapshot: null,
      annotations: null,
    };
    let destroy: (() => void) | undefined;
    let moduleFailed = false;
    try {
      // Inside the try: a throwing hook must end in the same "failed" outcome
      // (and the same explicit message) as a throwing mount, not escape it.
      req.afterClaim?.();
      const { mountEegViewer } = await import("./viewer").catch((err) => {
        moduleFailed = true;
        throw err;
      });
      if (mySeq !== seq || !live) return { seq: mySeq, kind: "superseded" };
      destroy = await mountEegViewer(host, {
        datasetId: ctx.datasetId,
        version: ctx.version,
        filePath: path,
        zarrToken: ctx.zarrToken,
        downloadUrl: req.downloadUrl,
        dirRecording: req.dirRecording,
        // Checked *inside* the mount, right after its own async gap, so a
        // superseded attempt returns before it writes into the host. The check
        // below only runs once the mount has already written its DOM, too late
        // to protect whatever got there first.
        isStale: () => mySeq !== seq,
        onRetry: req.onRetry,
        onTransfer: (snapshot) => {
          if (mySeq === seq && live) live.snapshot = snapshot;
        },
        onAnnotations: (handle) => {
          if (mySeq === seq && live) live.annotations = handle;
        },
        ...mountOptionsFor(path, fileName),
      });
    } catch (err) {
      console.error(req.logLabel, { datasetId: ctx.datasetId, path }, err);
      if (mySeq !== seq) return { seq: mySeq, kind: "superseded" };
      // A mount that threw part-way may already hold observers, a store fetch
      // and a GL context; dispose it before letting go of the only handle.
      disposeHost(live, host);
      live = null;
      return { seq: mySeq, kind: "failed", moduleFailed };
    }
    if (mySeq !== seq) {
      // Superseded mid-mount by a faster click elsewhere; whoever superseded
      // us owns the host now, so this instance only cleans up after itself.
      destroy?.();
      return { seq: mySeq, kind: "superseded" };
    }
    if (!destroy) {
      // `mountEegViewer` returns no disposer precisely when it mounted no
      // viewer (the store wouldn't open, it has no channel groups, or there
      // is no canvas context) and left a static "unavailable" message in the
      // host instead. Nothing to release, so it must stop counting as the
      // live instance, or the next open would "release" a viewer that never
      // existed.
      live = null;
      return { seq: mySeq, kind: "unavailable" };
    }
    if (live) {
      live.destroy = destroy;
      live.shownPath = path;
      live.shownName = fileName;
    }
    // After the try, so neither can turn this live viewer into a failure.
    bestEffort("units notice", () => applyUnitsNotice(host, ctx.zarr?.stores.get(path)));
    bestEffort("viewer-open hook", () => hooks.onViewerOpen?.(host));
    return { seq: mySeq, kind: "live" };
  }

  /**
   * An explicit error, never a blank host (website#260), with a way to try
   * again: `live` is null, so the nav controls hide and nothing else would
   * recover this open short of a reload (website#416). Try again is the same
   * open, through the same claim and supersession as any other; Reload (the
   * viewer's code did not load) goes back to the page with `?view=` naming this
   * recording. `again` is true when this message follows a failed retry.
   */
  function showOpenFailure(
    host: HTMLElement,
    target: RecordingEntry,
    ctx: SessionContext,
    reload: boolean,
    again: boolean,
  ): void {
    host.innerHTML = openFailureHtml(target.name, hooks.fallbackActionHtml(target, ctx, "open"), {
      reload,
      again,
    });
    const button = host.querySelector<HTMLButtonElement>(`.${RETRY_CLASS}`);
    if (!button) {
      console.error("[eeg-viewer] the open-failure message has no retry button", {
        datasetId: ctx.datasetId,
        path: target.path,
      });
      return;
    }
    button.addEventListener("click", () => {
      if (reload) {
        const viewSpec = hooks.isShowing() ? viewSpecForPath(ctx.recordings, target.path) : null;
        window.location.replace(reloadUrl(window.location.href, viewSpec));
        return;
      }
      button.disabled = true;
      openRecordingFrom(target, ctx, true)
        .catch((err) => console.error("[eeg-viewer] retry failed:", err))
        // A retry that did not replace this message (the page could not present
        // the new host) leaves the button pressable; one that did replaced it.
        .finally(() => {
          button.disabled = false;
        });
    });
    if (again) refocusRetry(host);
  }

  /**
   * The pressed button left with its message, so focus fell to the body: put it
   * on the new retry button, unless the visitor has since moved it elsewhere.
   */
  function refocusRetry(host: HTMLElement): void {
    const active = document.activeElement;
    if (active && active !== document.body && !host.contains(active)) return;
    host.querySelector<HTMLButtonElement>(`.${RETRY_CLASS}`)?.focus();
  }

  /**
   * Open a recording in a fresh host, with no originating tree row: the
   * dataset page's "View data" button (website#260), a `?view=` deep link, and
   * the embed.
   *
   * Starts `detached: true` from birth (ADR 0012): there is nothing to hand
   * the viewer back to, so ending the session ends the instance.
   */
  function openRecording(target: RecordingEntry, ctx: SessionContext): Promise<void> {
    return openRecordingFrom(target, ctx, false);
  }

  /**
   * `retry` is true when the visitor pressed Try again on this recording's
   * failed open: if it fails again the new message takes the keyboard focus
   * the pressed button just lost, so a keyboard visitor is not dropped on the
   * page body between attempts.
   */
  async function openRecordingFrom(
    target: RecordingEntry,
    ctx: SessionContext,
    retry: boolean,
  ): Promise<void> {
    const fileUrl = fileDownloadUrl(ctx.datasetId, ctx.version, target.path);
    const host = document.createElement("div");
    host.setAttribute("data-eegv-host", "");
    host.innerHTML = `<p class="preview__loading" role="status">Loading viewer…</p>`;
    host.setAttribute("aria-busy", "true");
    // Presented first, so a page that cannot show the new host keeps whatever
    // it was showing: nothing is released, nothing mounts, and the title still
    // names what is on screen.
    if (!hooks.present(host)) {
      console.error("[eeg-viewer] open aborted: the page could not present a viewer", {
        datasetId: ctx.datasetId,
        path: target.path,
      });
      return;
    }
    hooks.setTitle(target.name);
    // At most one viewer instance is ever live (website#199). Not a no-op on
    // the dataset page: "View data" sits outside the dialog and outside the
    // tree, so it is clickable while an INLINE viewer is open in a row below.
    release();

    const outcome = await mount({
      host,
      path: target.path,
      fileName: target.name,
      ctx,
      detached: true,
      dirRecording: isDirRecordingName(target.name),
      downloadUrl: fileUrl,
      logLabel: "[eeg-viewer] open failed:",
      // The viewer's own "could not load" message (an outage reading the store)
      // offers the same retry as a failed mount.
      onRetry: () => {
        openRecordingFrom(target, ctx, true).catch((err) =>
          console.error("[eeg-viewer] retry failed:", err),
        );
      },
      afterClaim: () => {
        // The target itself has had no chance to warm (unlike a tree-row
        // open, which prefetches on hover/focus before the click), so warm it
        // the way a row would and the mount hits a warm cache.
        if (ctx.zarr && !ctx.zarr.prefetched.has(target.path)) {
          ctx.zarr.prefetched.add(target.path);
          prefetchZarrStoreMetadata(
            ctx.datasetId,
            target.path,
            ctx.zarr.stores.get(target.path),
            ctx.zarrToken,
          );
        }
        // Nav controls and neighbour prefetch depend only on `recordings` and
        // `path`, both already final: populate them now rather than waiting on
        // the mount, the same as `navigate` does for an in-place swap.
        syncNav();
        prefetchAdjacent();
      },
    });
    // Not busy before the message arrives: a live region that is still marked
    // busy may be announced late or not at all.
    if (outcome.seq === seq) host.removeAttribute("aria-busy");
    if (outcome.kind === "unavailable") {
      // The mount rendered its own explanation (with its own Try again, for an
      // outage); nothing to navigate from.
      if (retry) refocusRetry(host);
      syncNav();
    } else if (outcome.kind === "failed") {
      showOpenFailure(host, target, ctx, outcome.moduleFailed === true, retry);
      syncNav(); // nothing to navigate from; hide the now-dead controls
    }
  }

  async function openFirst(ctx: SessionContext): Promise<boolean> {
    const target = firstRecording(ctx.recordings, readNavOrder());
    if (!target) return false;
    await openRecording(target, ctx);
    return true;
  }

  /**
   * Honour a `?view=` value by opening the recording it names. Resolution (and
   * its deliberate refusal to relax down to "somebody else's recording") lives
   * in `resolveViewParam`; a miss is reported through `onViewParamMiss` rather
   * than only the console, because a partner-facing link that silently no-ops
   * is the worst outcome here: the visitor cannot tell a dataset that lacks the
   * subject from a viewer that failed to load.
   */
  async function openViewParam(raw: string, ctx: SessionContext | null): Promise<boolean> {
    if (!ctx || ctx.recordings.length === 0) {
      hooks.onViewParamMiss?.(raw, "this dataset has no recordings the viewer can open yet.");
      return false;
    }
    const target = resolveViewParam(ctx.recordings, raw, readNavOrder());
    if (!target) {
      hooks.onViewParamMiss?.(raw, "no recording in this dataset matches it.");
      return false;
    }
    await openRecording(target, ctx);
    return true;
  }

  /**
   * Refuse a recording swap while the live viewer holds an unsaved annotation
   * draft, and point at the thing doing the refusing.
   *
   * Deliberately NOT a `window.confirm`. A confirm blocks the whole page on a
   * dialog that cannot be styled or dismissed by Escape-then-save, and it asks
   * a question ("discard your half-written annotation?") whose answer is almost
   * always no, so it costs every annotator a modal in exchange for a mistake
   * they were not going to make. Refusing the navigation and flashing the
   * popover already on screen says the same thing without stealing control:
   * Escape or Save, then the same click works.
   *
   * Every caller returns on true; each is responsible for re-syncing its own
   * chrome (the dropdowns in particular, which have already moved to the value
   * the user picked).
   */
  function draftBlocksNavigation(): boolean {
    const handle = live?.annotations;
    if (!handle) return false;
    let open: boolean;
    try {
      open = handle.isPopoverOpen();
    } catch (err) {
      // Fail OPEN, deliberately, and only here. A guard that throws while
      // answering "is there a draft?" would otherwise refuse every prev/next
      // and every dropdown for the rest of the session, with the selects
      // re-syncing away from whatever the user picked and no gesture that
      // recovers. Losing at most one unsaved draft is much the smaller failure.
      console.error("[eeg-viewer] annotation draft guard failed; allowing navigation:", err);
      return false;
    }
    if (!open) return false;
    // A draft IS open, so the navigation is refused whatever happens next.
    // Pointing at the popover is a courtesy; failing to is no reason to let
    // the navigation through and lose the draft it exists to protect.
    try {
      handle.focusPopover();
    } catch (err) {
      console.error("[eeg-viewer] could not focus the open annotation popover:", err);
    }
    return true;
  }

  /** The entry for the recording currently on screen, if it parsed. */
  function currentRecording(): RecordingEntry | null {
    const current = live;
    if (!current) return null;
    return current.recordings.find((e) => e.path === current.path) ?? null;
  }

  /**
   * Reflect the live instance's position in the navigation controls. Safe to
   * call at any time: with no live viewer, fewer than two recordings, or a
   * dataset whose paths do not parse into entities, it just hides what cannot
   * be driven.
   */
  function syncNav(): void {
    // First, and outside every early return below: the URL has to track the
    // recording even for a dataset with too few of them to show any controls.
    syncLinkState();
    clearCopyStatus();
    hideEmbedCode();
    const nav = navEl("[data-eegv-nav]");
    const subSel = navEl<HTMLSelectElement>("[data-eegv-nav-sub]");
    const taskSel = navEl<HTMLSelectElement>("[data-eegv-nav-task]");
    const subField = navEl("[data-eegv-nav-sub-field]");
    const taskField = navEl("[data-eegv-nav-task-field]");
    const pos = navEl("[data-eegv-nav-pos]");
    const prev = navEl<HTMLButtonElement>("[data-eegv-nav-prev]");
    const next = navEl<HTMLButtonElement>("[data-eegv-nav-next]");
    if (!nav || !subSel || !taskSel || !subField || !taskField || !pos || !prev || !next) {
      // EegViewerNav.astro and this module ship together; a mismatch means the
      // component was edited without its driver.
      console.warn("[eeg-viewer] navigation controls missing from the page");
      return;
    }
    const current = live;
    if (!current || current.recordings.length < 2) {
      nav.hidden = true;
      return;
    }
    const state = navControlState(current.recordings, current.path, readNavOrder());
    fillNavSelect(subSel, state.subjects, "sub-", state.current?.sub ?? null);
    fillNavSelect(taskSel, state.tasks, "task-", state.current?.task ?? null);
    // A dataset that names no subjects (or no tasks) gets no dropdown for them
    // rather than an empty one; prev/next still walks every recording.
    subField.hidden = state.subjects.length === 0;
    taskField.hidden = state.tasks.length === 0;
    pos.textContent = state.position;
    // Stepping onto the last recording disables the button the user is holding
    // focus on, which would drop focus to the document body mid-task. Hand it
    // to the opposite button instead, which by construction is now enabled.
    const focused = document.activeElement;
    prev.disabled = !state.before;
    next.disabled = !state.after;
    if (focused === next && next.disabled && !prev.disabled) prev.focus();
    else if (focused === prev && prev.disabled && !next.disabled) next.focus();
    // `aria-label`, not just `title`: an element with both takes its accessible
    // name from the label, so a screen reader would otherwise be stuck with the
    // markup's generic "Next recording" and never hear which recording that is.
    prev.title = state.prevLabel;
    next.title = state.nextLabel;
    prev.setAttribute("aria-label", state.prevLabel);
    next.setAttribute("aria-label", state.nextLabel);
    nav.hidden = false;
  }

  /**
   * Reflect the live instance in the URL and in the share controls, both of
   * which follow one condition: the chrome is showing a live viewer.
   *
   * `?view=` names the recording on screen and disappears when nothing is on
   * screen. `replaceState`, not `pushState`: stepping through twelve runs
   * should not leave twelve entries for the back button to walk out through.
   *
   * On the dataset page only the dialog counts. An inline viewer under a tree
   * row is a glance rather than a destination, and a link that reopened it as
   * a modal would describe something other than what the sharer was looking
   * at; `hooks.isShowing` is what says so.
   *
   * The URL ends up naming what is actually **shown**, which for a relaxed
   * match is not what the incoming link asked for: arriving on
   * `?view=sub-01_task-nope` rewrites the parameter to the recording that
   * resolved. That is the honest form, and it means a visitor can pass on a
   * link that lands where theirs did not.
   */
  function syncLinkState(): void {
    const share = navEl("[data-eegv-share]");
    const current = live;
    const showing = Boolean(hooks.isShowing() && current);
    if (share) share.hidden = !showing;
    const url = new URL(window.location.href);
    const viewSpec = showing && current ? viewSpecForPath(current.recordings, current.path) : null;
    if (viewSpec !== null) url.searchParams.set(VIEW_PARAM, viewSpec);
    else url.searchParams.delete(VIEW_PARAM);
    // Guarded: this runs on every nav sync, and an unchanged `replaceState`
    // still rewrites the history entry for no reason.
    if (url.toString() !== window.location.href) {
      history.replaceState(history.state, "", url.toString());
    }
    hooks.onRecordingShown?.(showing ? current : null, viewSpec);
  }

  /** Drop the copy confirmation. Called on every nav sync as well as on the
   *  timer, so a "Copied" left over from the previous recording can never
   *  appear to describe the current one. */
  function clearCopyStatus(): void {
    window.clearTimeout(copyStatusTimer);
    const status = navEl("[data-eegv-copy-status]");
    if (status) status.textContent = "";
  }

  /** Hide the embed-code fallback. On nav sync only, never on the status
   *  timer: it holds the code someone is about to copy by hand, and it would
   *  describe the previous recording once the viewer has moved on. */
  function hideEmbedCode(): void {
    const code = navEl<HTMLTextAreaElement>("[data-eegv-embed-code]");
    if (code && !code.hidden) {
      code.hidden = true;
      code.value = "";
    }
  }

  function setCopyStatus(message: string): void {
    const status = navEl("[data-eegv-copy-status]");
    if (!status) return;
    window.clearTimeout(copyStatusTimer);
    status.textContent = message;
    copyStatusTimer = window.setTimeout(clearCopyStatus, 5000);
  }

  /**
   * Put the current recording's deep link on the clipboard.
   *
   * The failure path is not an error state: `navigator.clipboard` is absent in
   * an insecure context and can reject on a permission policy, and in both
   * cases `syncLinkState` has already put the identical link in the address
   * bar, so the message points there rather than apologizing.
   */
  async function copyLink(): Promise<void> {
    const current = live;
    const status = navEl("[data-eegv-copy-status]");
    if (!current || !status || !hooks.shareLink) return;
    // Captured before the await: the visitor can navigate while the clipboard
    // decides, and a "Link copied" landing after that would describe a
    // recording no longer on screen.
    const path = current.path;
    const link = hooks.shareLink(viewSpecForPath(current.recordings, path));
    let message = "Link copied";
    try {
      await navigator.clipboard.writeText(link);
    } catch (err) {
      console.warn("[eeg-viewer] clipboard write failed", err);
      message = "Couldn't copy — the link is in the address bar";
    }
    if (live?.path !== path) return;
    setCopyStatus(message);
  }

  /**
   * Put an `<iframe>` snippet for the current recording on the clipboard
   * (website#410).
   *
   * Unlike Copy link there is no address-bar fallback (the snippet is not the
   * page URL), so a refused clipboard reveals the code in a read-only,
   * pre-selected textarea instead: one Ctrl or Cmd+C from done, and never a
   * dead end.
   */
  async function copySnippet(): Promise<void> {
    const current = live;
    const status = navEl("[data-eegv-copy-status]");
    if (!current || !status || !hooks.embedSnippet) return;
    // Captured before the await, as in `copyLink`: neither the status nor the
    // fallback textarea may describe a recording the visitor has since left.
    const path = current.path;
    const entry = currentRecording();
    const snippet = hooks.embedSnippet(current, entry, viewSpecForPath(current.recordings, path));
    const code = navEl<HTMLTextAreaElement>("[data-eegv-embed-code]");
    let message = "Embed code copied";
    let copied = true;
    try {
      await navigator.clipboard.writeText(snippet);
    } catch (err) {
      console.warn("[eeg-viewer] clipboard write failed", err);
      copied = false;
    }
    if (live?.path !== path) return;
    if (copied) {
      if (code) code.hidden = true;
    } else {
      if (code) {
        code.value = snippet;
        code.hidden = false;
        code.focus();
        code.select();
        message = "Couldn't copy. The embed code is selected below.";
      } else {
        message = "Couldn't copy the embed code";
      }
    }
    setCopyStatus(message);
  }

  /** Warm the neighbours' store metadata, the same warmup a hovered tree row
   *  gets. Best-effort: a miss costs one extra request at navigation time. */
  function prefetchAdjacent(): void {
    const current = live;
    if (!current?.zarr) return;
    const order = readNavOrder();
    for (const delta of [1, -1]) {
      const target = stepRecording(current.recordings, current.path, order, delta);
      if (!target || current.zarr.prefetched.has(target.path)) continue;
      current.zarr.prefetched.add(target.path);
      prefetchZarrStoreMetadata(
        current.datasetId,
        target.path,
        current.zarr.stores.get(target.path),
        current.zarr.token,
      );
    }
  }

  /**
   * Swap the viewer to another recording, in place.
   *
   * The first navigation from an instance that is not yet detached calls
   * `hooks.onDetach` (the dataset page collapses the tree row the viewer was
   * opened from) and hands ownership to the session. Re-anchoring the viewer
   * under the new recording's row cannot be done honestly: the recording list
   * comes from the Zarr index, so the target may sit in a directory the user
   * never expanded and therefore have no row to anchor to (ADR 0012).
   */
  async function navigate(target: RecordingEntry): Promise<void> {
    const current = live;
    if (!current || !hooks.isShowing()) return;
    if (target.path === current.path) {
      // The pick resolved to what is already on screen; nothing to swap, but
      // the dropdowns may be showing the request rather than the reality.
      syncNav();
      return;
    }
    // The swap destroys this instance, and an open annotation popover holds a
    // draft that exists nowhere else yet. Refuse rather than discard it.
    if (draftBlocksNavigation()) return;

    if (!current.detached) {
      hooks.onDetach?.(current);
      current.detached = true;
    }

    // Read the outgoing instance's settings BEFORE anything supersedes it;
    // `mountEegViewer` tears down whatever is in the host as its first act, so
    // there is no later chance to ask.
    const transfer = current.snapshot?.();
    const mySeq = ++seq;
    current.path = target.path;
    current.fileName = target.name;
    current.snapshot = null;
    current.annotations = null; // belongs to the instance the mount below replaces
    // The title and controls move immediately: the mount can take a moment,
    // and chrome that still names the previous recording reads as a no-op.
    hooks.setTitle(target.name);
    syncNav();
    const host = current.host;
    host.setAttribute("aria-busy", "true");
    let destroy: (() => void) | undefined;
    try {
      const { mountEegViewer } = await import("./viewer");
      if (mySeq !== seq || !live) return;
      // The mount disposes the instance currently in this host, so drop our
      // handle to it rather than risk destroying it twice. Done here and not
      // before the await: until the mount actually starts, the old instance is
      // still the one on screen and ending the session must still release it.
      live.destroy = null;
      destroy = await mountEegViewer(host, {
        datasetId: current.datasetId,
        version: current.version,
        filePath: target.path,
        zarrToken: current.zarrToken,
        downloadUrl: fileDownloadUrl(current.datasetId, current.version, target.path),
        // The target may be a `.mefd`/`.ds`/BTi directory recording
        // (website#252) with no tree row to read `data-dir-recording` from, so
        // it is decided from the name; see `isDirRecordingName`.
        dirRecording: isDirRecordingName(target.name),
        isStale: () => mySeq !== seq,
        transfer,
        onTransfer: (snapshot) => {
          if (mySeq === seq && live) live.snapshot = snapshot;
        },
        onAnnotations: (handle) => {
          if (mySeq === seq && live) live.annotations = handle;
        },
        ...mountOptionsFor(target.path, target.name),
      });
    } catch (err) {
      // Reaching here means the mount threw somewhere its own try/catch does
      // not cover (that only wraps `openRecording`), so a failure in the DOM
      // build, the WebGL setup or the transfer lands here. By then the previous
      // instance has been torn down (the mount's first act), and whatever the
      // failed mount built is disposed below, so there is nothing on screen to
      // keep: without this branch the host would hold a half-built viewer and
      // no explanation.
      console.error(
        "[eeg-viewer] navigation failed:",
        { datasetId: current.datasetId, path: target.path },
        err,
      );
      if (mySeq !== seq || !live) return;
      disposeHost(live, host);
      host.innerHTML = `<p class="preview__error" role="alert">Couldn't open ${escapeHtml(target.name)}. ${hooks.fallbackActionHtml(target, current, "navigate")} instead.</p>`;
      // Put the chrome back on the last recording that actually finished
      // mounting: it is the one the visitor saw and can still navigate
      // relative to, and the message above already names the one that failed.
      // Not the previous target, which may itself have been mid-mount.
      live.path = live.shownPath;
      live.fileName = live.shownName;
      hooks.setTitle(live.shownName);
      syncNav();
      host.removeAttribute("aria-busy");
      return;
    }
    if (mySeq !== seq) {
      // Superseded mid-mount by a faster click: whoever superseded us owns the
      // host now, so this instance only has itself to clean up.
      destroy?.();
      return;
    }
    host.removeAttribute("aria-busy");
    if (live) live.destroy = destroy ?? null;
    if (destroy) {
      if (live) {
        live.shownPath = target.path;
        live.shownName = target.name;
      }
      // Only after a live mount: a falsy `destroy` means the mount rendered its
      // own "unavailable" message in `host`, and the notice must never be
      // appended after that text.
      bestEffort("units notice", () =>
        applyUnitsNotice(host, current.zarr?.stores.get(target.path)),
      );
    }
    bestEffort("neighbour prefetch", () => prefetchAdjacent());
  }

  function step(delta: number): void {
    const current = live;
    if (!current) return;
    // Checked here as well as inside `navigate` so prev/next refuses without
    // any of the chrome having moved first.
    if (draftBlocksNavigation()) return;
    const target = stepRecording(current.recordings, current.path, readNavOrder(), delta);
    if (target) void navigate(target);
    else syncNav(); // at an end; make sure the button reads disabled
  }

  function wire(): void {
    navEl<HTMLButtonElement>("[data-eegv-nav-prev]")?.addEventListener("click", () => step(-1));
    navEl<HTMLButtonElement>("[data-eegv-nav-next]")?.addEventListener("click", () => step(1));
    navEl<HTMLSelectElement>("[data-eegv-nav-sub]")?.addEventListener("change", (event) => {
      const current = live;
      const sel = event.currentTarget as HTMLSelectElement;
      if (!current) return;
      // The `<select>` has already moved to the picked value, so a refusal has
      // to put it back; otherwise the dropdown names a subject the viewer is
      // not on.
      if (draftBlocksNavigation()) {
        syncNav();
        return;
      }
      // `prefer: "sub"` keeps the subject the user just picked when it has no
      // recording of the current task.
      const target = selectRecording(
        current.recordings,
        { sub: sel.value || null, task: currentRecording()?.task ?? null },
        readNavOrder(),
        "sub",
      );
      // `navigate` re-syncs the controls itself; the else branch covers a pick
      // that resolved to nothing, which must not leave the dropdown displaying
      // a subject the viewer is not on.
      if (target) void navigate(target);
      else syncNav();
    });
    navEl<HTMLSelectElement>("[data-eegv-nav-task]")?.addEventListener("change", (event) => {
      const current = live;
      const sel = event.currentTarget as HTMLSelectElement;
      if (!current) return;
      // As above: the dropdown has moved, so a refusal has to move it back.
      if (draftBlocksNavigation()) {
        syncNav();
        return;
      }
      const target = selectRecording(
        current.recordings,
        { sub: currentRecording()?.sub ?? null, task: sel.value || null },
        readNavOrder(),
        "task",
      );
      if (target) void navigate(target);
      else syncNav();
    });
    navEl<HTMLButtonElement>("[data-eegv-copy-link]")?.addEventListener("click", () => {
      void copyLink();
    });
    navEl<HTMLButtonElement>("[data-eegv-copy-embed]")?.addEventListener("click", () => {
      void copySnippet();
    });
    // The gear setting lives inside the viewer instance; it announces a change
    // rather than reaching into this chrome (the two are separately mounted).
    document.addEventListener(NAV_ORDER_CHANGED_EVENT, () => syncNav());
  }

  return {
    get live() {
      return live;
    },
    claim: () => ++seq,
    isCurrent: (claimed) => claimed === seq,
    release,
    end,
    mount,
    openRecording,
    openFirst,
    openViewParam,
    navigate,
    step,
    syncNav,
    syncLinkState,
    prefetchAdjacent,
    draftBlocksNavigation,
    wire,
  };
}
