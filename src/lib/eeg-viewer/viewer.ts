import { zarrStoreUrl } from "../zarr-base";
/**
 * Signal-viewer orchestration (website#99). `mountEegViewer` builds a compact
 * "clinical oscilloscope" panel into a slot, opens the recording's Zarr store,
 * and drives the render loop: pick the pyramid level for the window, dequantize
 * only the visible channel rows, optional DC removal, overlay events, draw.
 *
 * The slot is normally a per-row host inside the BIDS file tree, and the
 * caller may reparent it into the page-level dialog when the user asks to
 * enlarge (website#217). Neither is this module's concern: it measures and
 * fills whatever slot it is given, and keeps working across a move because it
 * holds the element itself rather than re-querying for it. Between #199 and
 * #217 the slot was the dialog's body and nothing else.
 *
 * Design intent:
 * - The scope has a FIXED height. Channels share it, so "show all" squeezes the
 *   montage rather than growing the box (stable embed boundary).
 * - Two zoom axes mirror MNE/EEGLAB: a time window (horizontal) with a time
 *   scrubber, and a channel zoom (vertical magnifier). The vertical scrollbar
 *   only appears once you zoom past the full montage into a portion — so the
 *   128-channel "see all" and "inspect a slice" use cases both work.
 * - The canvas reads the page design tokens, so it matches light/dark exactly.
 */
import { type AnnotationLayer, annotateGlyph, createAnnotationLayer } from "./annotation-ui";
import {
  type Modality,
  autoscaleGain,
  channelColor,
  defaultScaling,
  estimateSignalAmplitude,
  formatClock,
  formatSi,
  removeBandDc,
  removeDcInPlace,
} from "./dsp";
import { type EventType, buildEventTypes, eventsInWindow } from "./events";
import { type FilterSpec, designFilters, filtfilt, hasFilters } from "./filters";
import { type GlTraceRenderer, createGlTraceRenderer } from "./gl-trace";
import {
  ByteCappedLRUCache,
  PrefetchController,
  type PrefetchTransport,
  prefetchCacheKey,
  segmentIndexForTime,
  writeThroughKey,
} from "./prefetch";
import {
  DEFAULT_NAV_ORDER,
  NAV_ORDERS,
  NAV_ORDER_CHANGED_EVENT,
  NAV_ORDER_LABELS,
  normalizeNavOrder,
  readNavOrder,
  writeNavOrder,
} from "./recording-nav";
import {
  DEFAULT_RENDER,
  type FrameChannel,
  type ViewerFrame,
  renderChrome,
  renderFrame,
  renderMessage,
  traceLayout,
} from "./render";
import { standardMontageFor } from "./standard-montage";
import {
  type ChannelWindow,
  type GroupHandle,
  type RecordingStore,
  type WindowData,
  chooseWindowLevel,
  openRecording,
  readLevel0,
  readOverview,
  readViewLevel,
  readWindow,
  windowDataBytes,
} from "./store";
import { type TopoChannel, VIRIDIS_CSS, type Vec3, projectPositions, renderTopomap } from "./topo";

export interface ViewerOptions {
  datasetId: string;
  version: string | null;
  filePath: string;
  /**
   * Per-conversion cache-busting token for the store URL (the Zarr index's
   * `updated_utc`; #240). Omit for a store whose index predates the field —
   * that just restores the previous, un-busted URL.
   */
  zarrToken?: string;
  /** Data-plane URL for the "download instead" fallback when no store exists. */
  downloadUrl?: string;
  /**
   * True when this recording is a DIRECTORY (`.mefd`/`.ds`/BTi, website#252).
   * Such a recording has no single file to offer, so the "unavailable"
   * fallback points at the tree row's expand arrow instead of a download link
   * that would resolve to raw directory listing JSON.
   */
  dirRecording?: boolean;
  /**
   * Producer-supplied reason this recording has no viewer (from the Zarr index
   * `failures`): a trial-averaged/epoched derivative, a corrupt file, etc. When
   * set, it replaces the generic "still generating" message. Absent for a
   * recording that is simply still being converted.
   */
  failureReason?: string;
  /**
   * True when this mount attempt has been superseded and must not touch the
   * slot any more.
   *
   * The teardown at the top of this function only sees whatever was in the
   * slot when *this* call started. It cannot see an instance mounted by a
   * later call that began — and finished — while this one was still awaiting
   * `openRecording`. Without this predicate, a slow first file resolving after
   * a fast second file already rendered would blow away the second viewer's
   * DOM via `slot.innerHTML = ""` and rebuild itself in its place, leaving the
   * second instance's observers, listeners and WebGL context alive and
   * detached for the rest of the page's life, still streaming on every theme
   * toggle. The caller owns the sequencing, so it supplies the check.
   */
  isStale?: () => boolean;
  /**
   * View settings carried over from the recording the user just navigated away
   * from (website#253). Absent for a fresh open, and every field is applied
   * defensively — a seeded value is a preference, not a guarantee the new
   * recording can honour it.
   */
  transfer?: ViewerTransferState;
  /**
   * Receives a snapshot getter once the instance is live, so the caller can
   * carry the current settings into the next recording. Called at most once,
   * and never for a mount that produced no viewer.
   */
  onTransfer?: (snapshot: () => ViewerTransferState) => void;
}

/**
 * The slice of viewer state that survives a recording swap (website#253).
 *
 * Deliberately a flat, plain-data record rather than a handle on the live
 * instance: the snapshot is read just before the old instance is destroyed and
 * applied to a new one, so sharing a mutable object (the `FilterSpec`, in
 * particular) would let the new mount write back into the old mount's closure.
 *
 * What is left out is as considered as what is in:
 * - **Window position** resets to the start of the new recording. Second 400
 *   of a 10-minute rest run is not second 400 of a 90-second oddball run, and
 *   landing past the end of a shorter recording reads as a broken viewer.
 * - **Bad channels** are per-recording labels. Carrying "T7 is bad" from one
 *   subject to another asserts something about data nobody has looked at.
 * - **Group index** — channel groups differ per recording, so the new store's
 *   first group is the only safe default.
 */
export interface ViewerTransferState {
  windowLengthS: number;
  /** Only honoured when `gainManuallySet`; otherwise auto-scale (website#109)
   *  runs against the new recording's own amplitude, a better estimate than
   *  whatever suited the previous one. */
  gain: number;
  gainManuallySet: boolean;
  /** Visible channel count, or null for "the whole montage" — the default,
   *  which must not travel as a literal number or a 64-channel view would clip
   *  a 128-channel recording to its first half. */
  chanCount: number | null;
  hp: number | null;
  lp: number | null;
  notch: number | null;
  /** Whether the user chose the notch themselves. When false, the new
   *  recording's own PowerLineFrequency default wins. */
  notchUserSet: boolean;
  dcRemove: boolean;
  showEvents: boolean;
  butterfly: boolean;
  timeClock: boolean;
  hideBad: boolean;
  showTopo: boolean;
  /**
   * Whether annotation mode was on (website#255). Optional so a transfer
   * record written before this field existed still type-checks; absent means
   * "off", which is also the default for a fresh open.
   *
   * The annotations themselves never travel — they are per-recording, keyed in
   * IndexedDB, and the new mount loads the target's own. Only the *mode*
   * carries, so someone stepping through twenty runs marking artifacts does
   * not re-arm the tool twenty times.
   */
  annotating?: boolean;
}

const WINDOW_CHOICES = [2, 5, 10, 20, 30];
const HP_CHOICES: Array<[string, string]> = [
  ["0", "off"],
  ["0.1", "0.1"],
  ["0.5", "0.5"],
  ["1", "1"],
  ["2", "2"],
];
const LP_CHOICES: Array<[string, string]> = [
  ["0", "off"],
  ["15", "15"],
  ["30", "30"],
  ["45", "45"],
  ["70", "70"],
];
const NOTCH_CHOICES: Array<[string, string]> = [
  ["0", "off"],
  ["50", "50"],
  ["60", "60"],
];
const ELECTRIC = new Set<Modality>(["EEG", "EMG", "IEEG", "MISC"]);
/** Scope height cap (CSS px). The height fits the embed (tracks width, capped by
 * this and the viewport) but never varies with channel count. */
const MAX_PLOT_HEIGHT = 540;
const MIN_VISIBLE_CHANNELS = 4;
/** Fraction of a channel slot's half-height the auto-scale estimator targets
 *  (website#109) -- the midpoint of the issue's "60-80% of the slot" goal. */
const AUTOSCALE_TARGET_FRACTION = 0.7;

// --- Background preload (website#254) --------------------------------------
// Off by default; a gear toggle persists the choice client-side (localStorage
// alongside the viewer's other set-once preferences -- no server state, and a
// cookie would needlessly ride every request per the issue).
const PRELOAD_ENABLED_KEY = "nemar:eeg-preload";
const PRELOAD_CAP_KEY = "nemar:eeg-preload-cap-mb";
const DEFAULT_PRELOAD_CAP_MB = 500;
const PRELOAD_CAP_CHOICES: Array<[string, string]> = [
  ["250", "250 MB"],
  ["500", "500 MB"],
  ["1000", "1 GB"],
];

/** True when the browser signals the user wants reduced data usage
 *  (`Save-Data: on` / Chromium's Data Saver). Progressive enhancement:
 *  `navigator.connection` is Chromium-only, so absence just means "no
 *  signal" and changes nothing. Exported for unit tests. */
export function saveDataRequested(): boolean {
  try {
    // Hardened/privacy browsers can make the `navigator.connection` accessor
    // itself throw (fingerprinting countermeasures). That must degrade to
    // "no signal", not take down the whole viewer mount.
    if (typeof navigator === "undefined") return false;
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    return conn?.saveData === true;
  } catch {
    return false;
  }
}

/** Exported for unit tests (Save-Data precedence over the stored opt-in). */
export function loadPreloadEnabled(): boolean {
  // A browser-level "reduce data" preference outranks a stored opt-in from a
  // previous session: background-preloading a whole recording (potentially
  // hundreds of MB) is exactly what Save-Data asks sites not to do. The gear
  // toggle still works for the current mount if the user insists.
  if (saveDataRequested()) return false;
  try {
    return localStorage.getItem(PRELOAD_ENABLED_KEY) === "1";
  } catch {
    return false; // localStorage unavailable (privacy mode, SSR); default off is safe
  }
}

function savePreloadEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(PRELOAD_ENABLED_KEY, "1");
    else localStorage.removeItem(PRELOAD_ENABLED_KEY);
  } catch {
    /* localStorage unavailable; the choice applies this session only */
  }
}

function loadPreloadCapMB(): number {
  try {
    const raw = Number(localStorage.getItem(PRELOAD_CAP_KEY));
    return PRELOAD_CAP_CHOICES.some(([v]) => Number(v) === raw) ? raw : DEFAULT_PRELOAD_CAP_MB;
  } catch {
    return DEFAULT_PRELOAD_CAP_MB;
  }
}

function savePreloadCapMB(mb: number): void {
  try {
    localStorage.setItem(PRELOAD_CAP_KEY, String(mb));
  } catch {
    /* localStorage unavailable; the choice applies this session only */
  }
}

/**
 * Per-channel magnitude arrays for the auto-scale amplitude estimate, built
 * from an already-read window. DC-removed to match what the default trace view
 * actually shows (a channel's baseline offset must not inflate its estimate).
 * Line channels use the dequantized samples directly; band (pyramid) channels
 * use max(|min|, |max|) per column as the per-sample magnitude proxy. New
 * arrays only -- the caller's `WindowData.channels` is reused later to build
 * the render frame and must not be mutated here.
 */
function windowChannelMagnitudes(channels: ChannelWindow[]): Float32Array[] {
  return channels.map((cw) => {
    if (cw.kind === "line") return removeDcInPlace(cw.line.slice());
    const { min, max } = removeBandDc(cw.min, cw.max);
    const out = new Float32Array(min.length);
    for (let i = 0; i < min.length; i++) out[i] = Math.max(Math.abs(min[i]), Math.abs(max[i]));
    return out;
  });
}

/**
 * Mounts the viewer into `slot`, tearing down whatever instance was
 * previously mounted there first (so re-opening on a new file, or on a
 * failed re-open, never leaves the prior instance's ResizeObserver /
 * MutationObserver / WebGL context running under replaced DOM). Returns a
 * disposer the caller should invoke once the instance is genuinely finished
 * with — its preview collapsed, or another recording opened — so it stops
 * rendering and releases its listeners and GL context. Note that merely
 * moving the slot (inline panel to dialog and back, website#217) is not
 * that: the instance survives a move and must not be disposed on one.
 * Returns `undefined` when
 * nothing was actually mounted (the store failed to open, has no channel
 * groups, or the canvas context is unavailable) — those paths already
 * degrade to a static "unavailable" message with no listeners to tear down.
 */
export async function mountEegViewer(
  slot: HTMLElement,
  opts: ViewerOptions,
): Promise<(() => void) | undefined> {
  // Tear down any previous mount into this slot *before* doing anything
  // else, not just on the happy path below — otherwise a re-open that fails
  // early (store won't open, no channel groups, no 2D context) would strand
  // the previous instance's observers/listeners under the DOM this function
  // is about to overwrite.
  (slot as HTMLElement & { _eegvCleanup?: () => void })._eegvCleanup?.();
  (slot as HTMLElement & { _eegvCleanup?: () => void })._eegvCleanup = undefined;

  slot.innerHTML = `<div class="eegv"><p class="eegv__msg">Loading viewer…</p></div>`;
  const url = zarrStoreUrl(opts.datasetId, opts.filePath, { token: opts.zarrToken });

  let store: RecordingStore;
  try {
    store = await openRecording(url);
  } catch (err) {
    // Even the error path must respect staleness: a superseded attempt writing
    // "viewer unavailable" would replace a working viewer that a later mount
    // put in this slot.
    if (opts.isStale?.()) return undefined;
    renderUnavailable(slot, opts, err);
    return undefined;
  }
  // Past the await, so a newer mount may already own this slot. Return before
  // writing anything — see `isStale` on ViewerOptions. Nothing needs releasing
  // here: no DOM was built yet, and the store holds no handle to close.
  if (opts.isStale?.()) return undefined;
  if (store.groups.length === 0) {
    renderUnavailable(slot, opts, new Error("store has no channel groups"));
    return undefined;
  }

  let eventTypes: EventType[] = [];

  // --- state ---------------------------------------------------------------
  let groupIndex = 0;
  let windowStartS = 0;
  let windowLengthS = 10;
  let gain = 1;
  // Auto-scale (website#109): `gain` above is only the pre-data fallback (the
  // modality DEFAULT_SCALINGS at 1x). `autoscalePending` marks that the next
  // successful window read should set the INITIAL gain from the recording's
  // own amplitude; it is consumed once and re-armed on a group switch (a new
  // modality/montage needs its own estimate) but never once the user has
  // touched Scale +/- themselves -- auto-scale must not fight a manual
  // adjustment.
  let autoscalePending = true;
  let gainManuallySet = false;
  let dcRemove = true;
  let showEvents = true;
  let chanStart = 0;
  let chanCount = store.groups[0].nChannels; // default: whole montage (overview)
  const filters: FilterSpec = { hp: null, lp: null, notch: null };
  // Tracks whether the notch came from the user or from the recording's own
  // PowerLineFrequency, so a recording swap re-defaults it only in the latter
  // case (website#253).
  let notchUserSet = false;
  let renderSeq = 0;
  let renderInFlight = false;
  let renderQueued = false;
  let firstPaint = true;
  let timeClock = false;
  let butterfly = false;
  let hideBad = false;
  const badChannels = new Set<string>();

  // Background preload (website#254): a byte-capped cache of decoded windows
  // ("segments" -- fixed-width slices of the recording, currently the window
  // length) fed by a low-priority scheduler that walks outward from the
  // playhead. `lastWinLevel` mirrors the pyramid level the interactive path
  // actually rendered last, which is what the preloader targets ("the current
  // view level", per the issue) instead of re-deriving the pixel-width
  // heuristic for windows that are not on screen. `prefetchSignature` guards
  // against restarting the walk on every render tick -- only an actual change
  // to (group, level, channel rows, segment width) or enabling the feature
  // should reset it.
  let preloadEnabled = loadPreloadEnabled();
  let preloadCapMB = loadPreloadCapMB();
  const prefetchCache = new ByteCappedLRUCache<WindowData>(preloadCapMB * 1024 * 1024);
  let lastWinLevel: number | null = null;
  let bufferedSegments = new Set<number>();
  let bufferedSegmentS = 0; // segment width the current bufferedSegments indices are relative to
  let prefetchSignature = "";
  const prefetchController = new PrefetchController<WindowData>({
    cache: prefetchCache,
    transport: { fetchSegment: () => Promise.reject(new Error("prefetch not targeted yet")) },
    keyFor: () => "",
    onProgress: (covered) => {
      bufferedSegments = new Set(covered);
      drawOverview();
    },
  });

  /** (Re)targets and, when the target actually changed, restarts the
   *  background walk. Called after every render (cheap no-op when nothing
   *  about the target changed) and from the gear controls that affect it. */
  function updatePrefetchTarget(): void {
    if (!preloadEnabled || lastWinLevel === null) {
      prefetchController.stop();
      prefetchSignature = ""; // force a real restart next time preload is enabled
      return;
    }
    const g = group();
    const level = lastWinLevel;
    const r0 = chanStart;
    const r1 = Math.min(g.nChannels, chanStart + chanCount);
    const segS = Math.max(0.5, windowLengthS);
    const signature = `${groupIndex}|${level}|${r0}-${r1}|${segS}`;
    if (signature === prefetchSignature) return;
    prefetchSignature = signature;
    const transport: PrefetchTransport<WindowData> = {
      async fetchSegment(seg, signal) {
        const start = seg * segS;
        const end = Math.min(g.durationS, start + segS);
        const view = level > 0 ? g.viewLevels[level - 1] : undefined;
        const win = view
          ? await readViewLevel(g, view, start, end, r0, r1, signal)
          : await readLevel0(g, start, end, r0, r1, signal);
        return { value: win, bytes: windowDataBytes(win) };
      },
    };
    prefetchController.retarget({
      transport,
      keyFor: (seg) => prefetchCacheKey(g.name, level, r0, r1, segS, seg),
    });
    bufferedSegments = new Set();
    bufferedSegmentS = segS;
    const total = Math.max(1, Math.ceil(g.durationS / segS));
    const center = Math.max(0, Math.min(total - 1, Math.floor(windowStartS / segS)));
    prefetchController.start(total, center);
  }
  // Topomap state. The projection is computed once (positions are fixed per
  // recording); topoTime tracks the cursor (null -> window center).
  let showTopo = false;
  let topoTime: number | null = null;
  // Only build the scalp layout for EEG/MEG; non-scalp modalities (iEEG/EMG/fNIRS/
  // unknown) get no topomap so we don't render a wrong head map. Real electrodes.tsv
  // positions win; datasets that ship none but name standard 10-20 labels fall back to
  // a standard montage (resolveScalpPositions). A bad-geometry projection is caught here
  // so it just disables the topo, not the viewer.
  // topoScratch is this viewer's private offscreen grid buffer (never shared).
  const topoScratch =
    typeof document !== "undefined" ? document.createElement("canvas") : undefined;
  let topoLayout: ReturnType<typeof projectPositions> | null = null;
  const scalpPositions = resolveScalpPositions(store);
  try {
    if (scalpPositions) {
      topoLayout = projectPositions(scalpPositions.positions, scalpPositions.system);
    }
  } catch (err) {
    console.warn("[eeg-viewer] electrode projection failed; topomap disabled:", err);
  }

  // Cursor readout state: the last rendered frame and layout geometry.
  let lastFrame: ViewerFrame | null = null;
  let lastPlotLeft = DEFAULT_RENDER.gutter;
  let lastPlotTop = 4;
  let lastPlotWidth = 0;
  let lastPlotHeight = 0;
  // Trace slot geometry for the last frame, cached so the per-pointer click/move
  // hit-tests reuse it instead of recomputing the (pure) layout on every event.
  let lastSlots: ReturnType<typeof traceLayout> = [];

  // Overview minimap state (one coarse read, cached).
  let overviewData: Float32Array | null = null;
  let overviewLoaded = false;
  let overviewSeq = 0; // guards a fire-and-forget overview load against group switches

  // True once this mount's destroy() has run, so the fire-and-forget callbacks
  // below (view-level discovery settling) stop touching DOM they no longer own.
  let disposed = false;

  // Safe to claim the slot: the previous instance was torn down at the top of
  // this function, and the `isStale` check after the await ruled out a newer
  // mount having taken ownership in the meantime.
  slot.innerHTML = "";
  const ui = buildDom(slot, store, eventTypes, preloadEnabled, preloadCapMB);
  const cleanups: Array<() => void> = [];
  // Default the notch filter from the recording's PowerLineFrequency (the converter
  // embeds it in the store attrs; the Notch select already reflects it). Datasets
  // without the sidecar field stay unfiltered. The declared line frequency can
  // still sit above this recording's Nyquist (60 Hz on a 100 Hz store), so it
  // goes through the same honesty check a transferred cutoff does.
  filters.notch = usableCutoff(Number(ui.notch.value) || null);
  ui.notch.value = String(filters.notch ?? 0);
  applyTransfer(opts.transfer);
  const maybeCtx = ui.canvas.getContext("2d");
  if (!maybeCtx) {
    renderUnavailable(slot, opts, new Error("canvas 2D unavailable"));
    return undefined;
  }
  const ctx = maybeCtx; // non-null for the closures below

  // WebGL trace layer: the signal polylines (the per-frame hot path) are
  // GPU-rasterized on a canvas behind the 2D one, which then carries only the
  // transparent chrome (labels/axis/events). null => WebGL unavailable, so the 2D
  // `renderFrame` path draws everything on the single canvas (glCanvas hidden).
  const glRenderer: GlTraceRenderer | null = createGlTraceRenderer(ui.glCanvas);
  if (!glRenderer) ui.glCanvas.style.display = "none";

  // HED annotation layer (website#255). Self-contained: it owns an overlay
  // canvas above the chrome canvas, a popover and the panel under the scope,
  // and reads this instance's geometry rather than reaching into its render
  // loop. Created here (not on first use) because annotations already made for
  // this recording have to be restored and drawn even when the tool is off.
  const annotations: AnnotationLayer = createAnnotationLayer({
    root: ui.root,
    scope: ui.scope,
    panel: ui.annotPanel,
    toggleBtn: ui.annotateBtn,
    key: { datasetId: opts.datasetId, version: opts.version, filePath: opts.filePath },
    getSelectedChannels: () => [...badChannels],
    setChannelMarks: (bad, good) => {
      for (const label of bad) badChannels.add(label);
      for (const label of good) badChannels.delete(label);
      render();
    },
    // Only the minimap needs redrawing when an annotation changes; the trace
    // overlay is the layer's own canvas and it repaints that itself. A full
    // render() here would re-read the window from the store for nothing.
    requestOverviewRedraw: () => drawOverview(),
  });
  cleanups.push(() => annotations.destroy());
  if (opts.transfer?.annotating) annotations.setActive(true);

  function group(): GroupHandle {
    return store.groups[groupIndex];
  }

  // --- degraded view pyramid ------------------------------------------------
  // `GroupHandle.viewLevelsDegraded` is the store's way of saying "the pyramid
  // in `viewLevels` is truncated because discovery hit a real failure", as
  // opposed to "this recording genuinely has that few levels". Only the first
  // is worth telling anyone about, and only the first is actionable (retry the
  // connection), so it gets a standing note rather than a console warning
  // nobody reads. Without this the overview minimap and wide windows silently
  // draw from a partial pyramid and look like a short recording.

  /** Status-line suffix for a degraded group; "" when the pyramid is intact. */
  function degradedNote(g: GroupHandle): string {
    return g.viewLevelsDegraded ? " · overview incomplete (connection problem)" : "";
  }

  /**
   * The composed status line. Held as a base string so the degradation suffix
   * can be re-applied when discovery settles *after* the frame that wrote it —
   * see `watchViewLevels`. Empty base means the line currently carries a
   * transient message (loading, or a read failure) that must not be rewritten.
   */
  let statusBase = "";
  function renderStatus(): void {
    if (!statusBase) return;
    ui.status.textContent = statusBase + degradedNote(group());
  }

  function syncDegradedNote(): void {
    if (disposed) return;
    const degraded = group().viewLevelsDegraded;
    ui.overviewNote.hidden = !degraded;
    ui.overviewNote.textContent = degraded
      ? "Overview incomplete — some zoom levels failed to load. That is a connection problem, not a short recording; reload to try again."
      : "";
  }

  /**
   * Re-check a group once its view-level discovery settles. First paint
   * deliberately does not wait for `viewLevelsReady`, so a group can flip to
   * degraded well after a frame is already on screen; without this hook the
   * note would only appear on the user's next interaction, if ever. Attached
   * once per group (a group switch brings its own handle).
   */
  const degradeWatched = new Set<GroupHandle>();
  function watchViewLevels(g: GroupHandle): void {
    if (degradeWatched.has(g)) return;
    degradeWatched.add(g);
    // `viewLevelsReady` never rejects — discovery failures resolve to the
    // partial level list and set the flag — so there is nothing to catch.
    void g.viewLevelsReady.then(() => {
      if (disposed || group() !== g) return;
      syncDegradedNote();
      renderStatus();
    });
  }

  function clamp(): void {
    const g = group();
    chanCount = Math.min(Math.max(MIN_VISIBLE_CHANNELS, chanCount), g.nChannels);
    chanStart = Math.max(0, Math.min(chanStart, g.nChannels - chanCount));
    windowStartS = Math.min(Math.max(0, windowStartS), Math.max(0, g.durationS - windowLengthS));
  }

  /**
   * A cutoff this recording can actually apply, or null.
   *
   * `designFilters` drops anything at or above the Nyquist, which is correct
   * signal processing and a terrible UI on its own: the select would still
   * read "30" while nothing filtered. Every cutoff that reaches `filters`
   * passes through here, so what the gear shows is what runs — a 30 Hz
   * low-pass on a 40 Hz recording becomes an honest "off" instead.
   */
  function usableCutoff(hz: number | null): number | null {
    return hz !== null && hz > 0 && hz < store.groups[0].rate / 2 ? hz : null;
  }

  /**
   * Seed this instance from the settings the user had on the previous
   * recording (website#253). Every field is optional in effect: a value the
   * new recording cannot honour (a channel count it does not have, a window
   * length that is not one of the choices) is dropped or clamped rather than
   * forced, because the alternative is a viewer that opens in a state its own
   * controls could not have produced.
   */
  function applyTransfer(t: ViewerTransferState | undefined): void {
    if (!t) return;
    if (WINDOW_CHOICES.includes(t.windowLengthS)) {
      windowLengthS = t.windowLengthS;
      ui.win.value = String(t.windowLengthS);
    }
    if (t.gainManuallySet && Number.isFinite(t.gain) && t.gain > 0) {
      // The user overrode auto-scale on the previous recording; respect that
      // here too rather than re-estimating and appearing to undo their work.
      gain = t.gain;
      gainManuallySet = true;
      autoscalePending = false;
    }
    // `clamp()` bounds this against the new montage on the first render, so a
    // 32-channel zoom into a 16-channel recording simply shows all 16.
    if (t.chanCount !== null && t.chanCount > 0) chanCount = t.chanCount;
    // Cutoffs go through `usableCutoff`: one the new recording cannot apply is
    // carried over as "off" rather than as a setting the gear shows active and
    // `designFilters` silently drops.
    filters.hp = usableCutoff(t.hp);
    filters.lp = usableCutoff(t.lp);
    ui.hp.value = String(filters.hp ?? 0);
    ui.lp.value = String(filters.lp ?? 0);
    if (t.notchUserSet) {
      filters.notch = usableCutoff(t.notch);
      ui.notch.value = String(filters.notch ?? 0);
      notchUserSet = true;
    }
    dcRemove = t.dcRemove;
    showEvents = t.showEvents;
    butterfly = t.butterfly;
    timeClock = t.timeClock;
    hideBad = t.hideBad;
    ui.dc.checked = dcRemove;
    ui.events.checked = showEvents;
    ui.butterflyCheck.checked = butterfly;
    ui.clockCheck.checked = timeClock;
    ui.hideBadCheck.checked = hideBad;
    // Only reopen the topomap when this recording actually has a scalp layout;
    // a montage-less or intracranial recording keeps the panel closed.
    if (t.showTopo && topoLayout && !ui.topoBtn.disabled) {
      showTopo = true;
      ui.topo.style.display = "flex";
      ui.topoBtn.setAttribute("aria-pressed", "true");
      ui.topoBtn.classList.add("eegv__btn--active");
    }
  }

  /** Current transferable settings, read at swap time (website#253). */
  function snapshotTransfer(): ViewerTransferState {
    return {
      windowLengthS,
      gain,
      gainManuallySet,
      // Normalize "the whole montage" to null so it stays whole-montage on a
      // recording with a different channel count.
      chanCount: chanCount >= group().nChannels ? null : chanCount,
      // `FilterSpec`'s fields are optional; the transfer record is not, so
      // normalize "unset" to the null the selects already use for "off".
      hp: filters.hp ?? null,
      lp: filters.lp ?? null,
      notch: filters.notch ?? null,
      notchUserSet,
      dcRemove,
      showEvents,
      butterfly,
      timeClock,
      hideBad,
      showTopo,
      annotating: annotations.isActive(),
    };
  }

  function sizeCanvas(): { w: number; h: number } {
    // The scope is the positioned frame; both canvases fill it (CSS inset:0). Its
    // width comes from flex (shrinks when the topo panel opens); we set its height.
    const rectW = ui.scope.getBoundingClientRect().width || ui.root.getBoundingClientRect().width;
    const cssW = Math.max(320, Math.round(rectW) || 800);
    // Fit the area the modal opens into: height tracks width (a ~2:1 scope) and
    // is capped by MAX_PLOT_HEIGHT and 70% of the viewport, so it never overflows.
    // It does NOT vary with channel count (stable embed boundary).
    const vpCap = Math.round((globalThis.innerHeight || 900) * 0.7);
    const cssH = Math.max(280, Math.min(Math.round(cssW * 0.5), MAX_PLOT_HEIGHT, vpCap));
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    ui.scope.style.height = `${cssH}px`;
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    // Assigning canvas.width/height clears the bitmap. Only do it on an actual size
    // change so a re-render triggered by something other than a resize (e.g. the
    // cursor readout toggling the layout height) repaints over the prior frame
    // instead of flashing white.
    if (ui.canvas.width !== pxW || ui.canvas.height !== pxH) {
      ui.canvas.width = pxW;
      ui.canvas.height = pxH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    glRenderer?.resize(pxW, pxH);
    return { w: cssW, h: cssH };
  }

  function syncControls(): void {
    const g = group();
    ui.hscroll.min = "0";
    ui.hscroll.max = String(Math.max(0.001, g.durationS - windowLengthS));
    ui.hscroll.step = String(Math.max(0.01, windowLengthS / 50));
    ui.hscroll.value = String(windowStartS);
    const zoomed = g.nChannels > chanCount;
    ui.vscroll.min = "0";
    ui.vscroll.max = String(Math.max(0, g.nChannels - chanCount));
    ui.vscroll.step = "1";
    ui.vscroll.value = String(chanStart);
    ui.plot.classList.toggle("eegv__plot--scroll", zoomed);
  }

  // Read the window for rendering. With filters on we read level-0 (the actual
  // samples; filtering the min/max envelope would be wrong) for a slightly padded
  // span, apply the zero-phase filtfilt cascade, then crop the filter-transient
  // pad back off. If the window is too wide for level-0 the read falls back to the
  // pyramid band and filtering is skipped (the caller greys the indicator).
  async function readFrame(
    g: GroupHandle,
    start: number,
    end: number,
    plotWidth: number,
  ): Promise<{ win: WindowData; filtered: boolean }> {
    if (!hasFilters(filters)) {
      // Opportunistic cache hit (website#254): when this window falls exactly
      // on the preloader's segment grid at the level it last rendered, serve
      // it from the cache instead of a network read. This is what makes
      // "paging" (Page back/forward, Home/End) instant once the background
      // walk has reached that segment -- an arbitrary scrub position rarely
      // lands on a grid line, so it falls through to the normal read below,
      // same as preload being off.
      //
      // `lastWinLevel` is the level the *previous* frame rendered, not
      // necessarily what this frame's own geometry calls for -- an Enlarge
      // resize (or any other plotWidth change without a remount) can move
      // the two out of sync. Re-derive the level readWindow would actually
      // choose for the CURRENT plotWidth and only trust the cache when it
      // agrees; otherwise fall through to a real read (which also corrects
      // lastWinLevel for next time, so this is self-healing, not a permanent
      // miss). This guard only applies to this unfiltered branch -- the
      // filtered path below always calls readWindow directly and never
      // consults the cache, since preload only ever stores unfiltered
      // windows.
      if (preloadEnabled && lastWinLevel !== null) {
        const seg = segmentIndexForTime(start, windowLengthS);
        const expectedLevel = chooseWindowLevel(g, start, end, plotWidth, false);
        if (
          seg !== null &&
          Math.abs(end - start - windowLengthS) < 1e-6 &&
          expectedLevel === lastWinLevel
        ) {
          const r1 = Math.min(g.nChannels, chanStart + chanCount);
          const key = prefetchCacheKey(g.name, lastWinLevel, chanStart, r1, windowLengthS, seg);
          const cached = prefetchCache.get(key);
          if (cached) return { win: cached, filtered: false };
        }
      }
      // Capture every geometry input BEFORE the await: chanStart/chanCount/
      // windowLengthS are live closure state that user input (the channel
      // scrollbar, a window-length change) can mutate while the read is in
      // flight. The write-through key below must describe the read that
      // actually happened, not the state at completion time -- keying by the
      // live values would store this window's data under the new state's key,
      // and a later cache hit would render the wrong traces.
      const readChanStart = chanStart;
      const readChanCount = chanCount;
      const readWindowLengthS = windowLengthS;
      const readPreloadEnabled = preloadEnabled;
      const win = await readWindow(g, start, end, plotWidth, readChanStart, readChanCount, false);
      // Write-through: an interactive read that landed on the segment grid IS
      // the segment the background walk would fetch for that index -- store it
      // under the walk's own key (writeThroughKey shares prefetchCacheKey with
      // the controller's keyFor) so the walk's `cache.has` skips it instead of
      // re-transferring the identical bytes. Without this, enabling preload
      // re-fetched the window the user was already looking at on every
      // (re)target (~430 KB per 10 s level-0 page on a 129-channel store).
      // `put` (evicting), not `putIfRoom`: the user has actively looked at this
      // window, which is exactly the recency signal the LRU exists to keep.
      const wtKey = writeThroughKey({
        enabled: readPreloadEnabled,
        groupName: g.name,
        level: win.level,
        startS: start,
        endS: end,
        segmentSeconds: readWindowLengthS,
        rowStart: readChanStart,
        rowEnd: Math.min(g.nChannels, readChanStart + readChanCount),
      });
      if (wtKey !== null && !prefetchCache.put(wtKey, win, windowDataBytes(win))) {
        // put() only refuses when this single window exceeds the whole cache
        // cap -- that means the write-through (and the preloader itself) can
        // no longer cache anything at this geometry. Say so instead of letting
        // the optimization die silently under a future geometry change.
        console.warn(
          `[eeg-viewer] preload write-through skipped: window (${windowDataBytes(win)} bytes) exceeds the cache cap (${prefetchCache.capacityBytes} bytes)`,
        );
      }
      return { win, filtered: false };
    }
    const padS = Math.min(2, (end - start) * 0.5);
    const pStart = Math.max(0, start - padS);
    const pEnd = Math.min(g.durationS, end + padS);
    const w = await readWindow(g, pStart, pEnd, plotWidth, chanStart, chanCount, true);
    if (w.channels.length === 0 || w.channels[0].kind !== "line") {
      // Window too wide for level-0: the read fell back to the pyramid band, which
      // filtfilt cannot touch. Re-read the *visible* (unpadded) window so its nCols
      // and time span line up with the axis -- returning the padded band would shift
      // every trace left by padS.
      const band =
        w.channels.length === 0
          ? w
          : await readWindow(g, start, end, plotWidth, chanStart, chanCount, false);
      return { win: band, filtered: false };
    }
    const biquads = designFilters(filters, g.rate);
    const apply = biquads.length > 0; // empty when every requested cutoff is >= Nyquist
    const padCols = Math.round((start - pStart) * g.rate);
    const visCols = Math.max(1, Math.round((end - start) * g.rate));
    const channels: ChannelWindow[] = w.channels.map((cw) =>
      cw.kind === "line"
        ? {
            kind: "line",
            line: (apply ? filtfilt(cw.line, biquads) : cw.line).subarray(
              padCols,
              padCols + visCols,
            ),
          }
        : cw,
    );
    // `filtered` reflects whether a cascade was actually applied so the status note
    // does not claim "filtered" when the cutoffs were all suppressed at Nyquist.
    return { win: { level: w.level, nCols: visCols, channels }, filtered: apply };
  }

  async function render(): Promise<void> {
    // Coalesce scroll/slider/key bursts. The stale-frame guard below still
    // prevents old reads from painting, but without this gate each input event
    // can start its own Zarr request before the prior one returns.
    renderSeq++;
    if (renderInFlight) {
      renderQueued = true;
      return;
    }
    renderInFlight = true;
    try {
      do {
        renderQueued = false;
        const seq = renderSeq;
        try {
          await renderImpl(seq);
        } catch (err) {
          console.error("[eeg-viewer] render failed:", err);
        }
      } while (renderQueued);
    } finally {
      renderInFlight = false;
    }
  }

  async function renderImpl(seq: number): Promise<void> {
    clamp();
    const g = group();
    const { w, h } = sizeCanvas();
    syncControls();
    const plotWidth = Math.max(64, w - DEFAULT_RENDER.gutter - 8);
    const start = windowStartS;
    const end = Math.min(g.durationS, start + windowLengthS);
    const visEnd = Math.min(g.nChannels, chanStart + chanCount);

    // Store geometry for cursor readout.
    lastPlotLeft = DEFAULT_RENDER.gutter;
    lastPlotTop = 4;
    lastPlotWidth = plotWidth;
    lastPlotHeight = Math.max(1, h - DEFAULT_RENDER.axisHeight - lastPlotTop);

    if (timeClock) {
      ui.time.textContent = `${formatClock(start)}–${formatClock(end)}`;
    } else {
      ui.time.textContent = `${start.toFixed(1)}–${end.toFixed(1)} s`;
    }
    ui.chanInfo.textContent =
      visEnd - chanStart >= g.nChannels
        ? `all ${g.nChannels}`
        : `${chanStart + 1}–${visEnd}/${g.nChannels}`;

    // Paint a "loading" state immediately so the scope never sits blank while a
    // read (or its retries) is in flight; the first paint also covers the gap
    // before any frame exists. Subsequent scrolls keep the prior frame.
    if (firstPaint) {
      const tc = themeColors(ui.root);
      glRenderer?.clear(tc.background); // wipe any stale GL frame under the overlay
      renderMessage(ctx, w, h, tc, "Signal loading…");
    }
    ui.status.textContent = "Signal loading…";

    let win: WindowData;
    let filtered = false;
    // The background walk yields for the duration of every interactive read
    // (website#254 "always yields priority to interactive fetches"), not just
    // while one happens to be in flight when the walk checks -- depth-counted
    // so back-to-back renders (a fast scrub) keep it held the whole time.
    prefetchController.notifyInteractiveStart();
    try {
      ({ win, filtered } = await readFrame(g, start, end, plotWidth));
    } catch (err) {
      if (seq === renderSeq) {
        firstPaint = false;
        const msg = err instanceof Error ? err.message : String(err);
        const tc = themeColors(ui.root);
        glRenderer?.clear(tc.background); // wipe any stale GL frame under the overlay
        renderMessage(ctx, w, h, tc, `Signal unavailable: ${msg}`);
        statusBase = ""; // a late `watchViewLevels` must not overwrite this
        ui.status.textContent = `signal unavailable: ${msg}`;
      }
      return;
    } finally {
      prefetchController.notifyInteractiveEnd();
    }
    if (seq !== renderSeq) return; // a newer render superseded this one
    firstPaint = false;
    // Track the level actually rendered and (re)target the preloader at it --
    // a no-op when nothing about the target changed (see updatePrefetchTarget).
    lastWinLevel = win.level;
    updatePrefetchTarget();
    const modality = (g.modality as Modality) ?? "MISC";

    // Auto-scale (website#109): set the INITIAL gain from this recording's own
    // amplitude the first time we have real data for it (first load, or after a
    // group switch that re-armed this) -- unless the user already touched
    // Scale +/-, in which case their choice wins and auto-scale never fires
    // again for this mount. A zero estimate (silent/all-bad channels) leaves
    // `gain` at its current value, i.e. the modality DEFAULT_SCALINGS fallback.
    if (autoscalePending) {
      autoscalePending = false;
      if (!gainManuallySet) {
        const amplitude = estimateSignalAmplitude(windowChannelMagnitudes(win.channels));
        if (amplitude > 0) {
          gain = autoscaleGain(amplitude, defaultScaling(modality), AUTOSCALE_TARGET_FRACTION);
        }
      }
    }

    const visible = g.channelsByRow.slice(chanStart, visEnd);
    const n = Math.min(visible.length, win.channels.length);
    let channels: FrameChannel[] = visible.slice(0, n).map((ch, i) => {
      const color =
        ch.channelType && ch.channelType !== "OTHER"
          ? channelColor(ch.channelType)
          : channelColor(ch.modality);
      const cw = win.channels[i];
      const dim = badChannels.has(ch.label);
      if (cw.kind === "line") {
        const line = dcRemove ? removeDcInPlace(cw.line.slice()) : cw.line;
        return { label: ch.label, color, kind: "line" as const, line, dim };
      }
      let { min, max } = cw;
      if (dcRemove) ({ min, max } = removeBandDc(min, max));
      return { label: ch.label, color, kind: "band" as const, min, max, dim };
    });

    // Reject mode: drop bad channels from the montage entirely (the survivors take
    // the full height) rather than only dimming them in place. Never blank the scope
    // if every visible channel is marked bad.
    if (hideBad && badChannels.size > 0) {
      const kept = channels.filter((c) => !badChannels.has(c.label));
      const hidden = channels.length - kept.length;
      if (kept.length > 0) {
        channels = kept;
        if (hidden > 0) ui.chanInfo.textContent += ` · ${hidden} hidden`;
      }
    }

    const frame: ViewerFrame = {
      channels,
      nCols: win.nCols,
      windowStartS: start,
      windowEndS: end,
      events:
        showEvents && store.events ? eventsInWindow(store.events, eventTypes, start, end) : [],
      physPerDiv: defaultScaling(modality),
      unitBase: ELECTRIC.has(modality) ? "V" : "T",
      timeClock,
    };
    lastFrame = frame;
    lastSlots = traceLayout(frame.channels.length, lastPlotTop, lastPlotHeight);
    const renderOpts = {
      ...DEFAULT_RENDER,
      ...themeColors(ui.root),
      width: w,
      height: h,
      gain,
      butterfly,
    };
    if (glRenderer) {
      // GPU draws background + traces; the 2D canvas adds transparent chrome on top.
      glRenderer.draw(frame, renderOpts, w, h);
      renderChrome(ctx, frame, renderOpts);
    } else {
      renderFrame(ctx, frame, renderOpts);
    }

    const filterNote = hasFilters(filters)
      ? filtered
        ? " · filtered"
        : " · filters need zoom-in"
      : "";
    statusBase =
      `${g.name} · ${g.nChannels} ch @ ${g.rate} Hz (orig ${g.originalRate}) · ` +
      `${g.durationS.toFixed(0)} s · level ${win.level === 0 ? "0 (full)" : `view/${win.level}`}${filterNote} · ` +
      `${eventTypes.length} event type(s)`;
    renderStatus();
    // Discovery may already have failed (a fast failure beats first paint) or
    // may still be running; the note covers the first case and the watcher the
    // second.
    syncDegradedNote();
    watchViewLevels(g);

    // Hand the annotation layer this frame's geometry so its overlay lines up
    // with the traces (website#255). Read-only: it never writes back here.
    annotations.onFrame({
      cssWidth: w,
      cssHeight: h,
      plotLeft: lastPlotLeft,
      plotTop: lastPlotTop,
      plotWidth: lastPlotWidth,
      plotHeight: lastPlotHeight,
      windowStartS: start,
      windowEndS: end,
      channelLabels: frame.channels.map((c) => c.label),
      slots: lastSlots,
      butterfly,
    });

    // Load and draw the overview minimap once.
    if (!overviewLoaded) {
      overviewLoaded = true;
      loadOverview(g);
    } else {
      drawOverview();
    }

    if (showTopo) drawTopo();
  }

  // --- Overview minimap ----------------------------------------------------

  async function loadOverview(g: GroupHandle): Promise<void> {
    const seq = ++overviewSeq;
    let data: Float32Array | null = null;
    try {
      data = await readOverview(g);
    } catch (err) {
      console.error("[eeg-viewer] loadOverview failed:", err);
    }
    if (seq !== overviewSeq) return; // a group switch superseded this load
    overviewData = data;
    ui.minimap.style.display = data && data.length > 0 ? "block" : "none";
    drawOverview();
  }

  function drawOverview(): void {
    const canvas = ui.minimap;
    if (!overviewData || overviewData.length === 0) return;
    const g = group();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cssW =
      canvas.getBoundingClientRect().width || ui.root.getBoundingClientRect().width || 600;
    const cssH = 44;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const mctx = canvas.getContext("2d");
    if (!mctx) return;
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const colors = themeColors(ui.root);
    mctx.fillStyle = colors.background;
    mctx.fillRect(0, 0, cssW, cssH);

    // Layout: events own the prominent upper band; the activity envelope is a faint
    // strip along the bottom. The envelope alone says little, so events are the focus
    // (the minimap is mainly an event-distribution indicator).
    const actBand = 11; // bottom px for the (subtle) activity envelope
    const evTop = 3;
    const evBottom = cssH - actBand - 2;

    // Subtle activity envelope along the bottom.
    const data = overviewData;
    let maxVal = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] > maxVal) maxVal = data[i];
    }
    if (maxVal <= 0) maxVal = 1;
    const colW = cssW / data.length;
    mctx.globalAlpha = 0.45;
    mctx.fillStyle = colors.grid;
    for (let i = 0; i < data.length; i++) {
      const barH = Math.max(1, Math.round((data[i] / maxVal) * actBand));
      mctx.fillRect(i * colW, cssH - barH - 1, Math.max(1, colW - 0.5), barH);
    }
    mctx.globalAlpha = 1;

    // The whole-recording time axis, shared by the event ticks and the window box.
    const dur = g.durationS || 1;

    // Buffered-region indicator (website#254): a thin strip along the very
    // bottom, like a video player's buffered bar, shading the segments the
    // background preloader has already cached at the current view level.
    // `bufferedSegmentS` is the segment width those indices are relative to
    // (reset together whenever the preloader retargets), so this always
    // matches what `bufferedSegments` actually means even if the window
    // length changed since the last progress update.
    if (preloadEnabled && bufferedSegments.size > 0 && bufferedSegmentS > 0) {
      const total = Math.max(1, Math.ceil(dur / bufferedSegmentS));
      const barH = 3;
      const barY = cssH - barH;
      mctx.fillStyle = "rgba(0,114,178,0.35)";
      for (const seg of bufferedSegments) {
        const bx1 = (seg / total) * cssW;
        const bx2 = ((seg + 1) / total) * cssW;
        mctx.fillRect(bx1, barY, Math.max(1, bx2 - bx1), barH);
      }
    }

    // Prominent event ticks spanning the upper band; some alpha so dense clusters
    // read as density rather than a solid wall.
    if (store.events && eventTypes.length > 0) {
      const colorByCode = new Map(eventTypes.map((t) => [t.code, t.color]));
      mctx.lineWidth = 1.25;
      mctx.globalAlpha = 0.8;
      for (let i = 0; i < store.events.onsetS.length; i++) {
        const x = (store.events.onsetS[i] / dur) * cssW;
        mctx.strokeStyle = colorByCode.get(store.events.code[i]) ?? "#888888";
        mctx.beginPath();
        mctx.moveTo(Math.round(x) + 0.5, evTop);
        mctx.lineTo(Math.round(x) + 0.5, evBottom);
        mctx.stroke();
      }
      mctx.globalAlpha = 1;
    }

    // The user's own annotations (website#255), in a dedicated strip along the
    // top edge so they are never mistaken for the dataset's event ticks below.
    annotations.drawOverview(mctx, cssW, cssH, dur);

    // Current window box.
    const wStart = windowStartS;
    const wEnd = Math.min(dur, windowStartS + windowLengthS);
    const x1 = (wStart / dur) * cssW;
    const x2 = (wEnd / dur) * cssW;
    mctx.fillStyle = "rgba(0,114,178,0.18)";
    mctx.fillRect(x1, 0, x2 - x1, cssH);
    mctx.strokeStyle = "#0072B2";
    mctx.lineWidth = 1.5;
    mctx.strokeRect(x1, 0, x2 - x1, cssH);
  }

  // --- Topomap -------------------------------------------------------------
  // Scalp field at the cursor time (window centre until the pointer moves). Bad
  // (rejected) channels drop out of the interpolation, so hiding a channel removes
  // its contribution. Reads from the already-loaded frame (no extra fetch).
  function drawTopo(): void {
    if (!showTopo || !topoLayout) return;
    const canvas = ui.topoCanvas;
    const availW = Math.max(80, ui.topo.clientWidth - 8);
    const availH = Math.max(80, lastPlotTop + lastPlotHeight);
    const cssSize = Math.min(availW, availH, 360);
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    const pxW = Math.round(cssSize * dpr);
    if (canvas.width !== pxW) {
      canvas.width = pxW;
      canvas.height = pxW;
    }
    const tctx = canvas.getContext("2d");
    if (!tctx) return;
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const frame = lastFrame;
    if (!frame || frame.nCols <= 0) {
      tctx.clearRect(0, 0, cssSize, cssSize);
      return;
    }
    const span = frame.windowEndS - frame.windowStartS;
    const t = Math.max(
      frame.windowStartS,
      Math.min(frame.windowEndS, topoTime ?? frame.windowStartS + span / 2),
    );
    const col = Math.max(
      0,
      Math.min(
        frame.nCols - 1,
        Math.round(((t - frame.windowStartS) / Math.max(1e-6, span)) * (frame.nCols - 1)),
      ),
    );
    const channels: TopoChannel[] = [];
    for (const ch of frame.channels) {
      if (ch.dim) continue; // rejected -> no contribution
      const pos = topoLayout.get(ch.label);
      if (!pos) continue;
      const value =
        ch.kind === "line" ? (ch.line[col] ?? 0) : ((ch.min[col] ?? 0) + (ch.max[col] ?? 0)) / 2;
      channels.push({ label: ch.label, pos, value });
    }
    const { vmax } = renderTopomap(tctx, cssSize, channels, themeColors(ui.root), topoScratch);
    if (channels.length >= 3) {
      const rng = formatSi(vmax, frame.unitBase);
      ui.topoMin.textContent = `−${rng}`;
      ui.topoMax.textContent = `+${rng}`;
      ui.topoInfo.textContent = timeClock ? formatClock(t) : `${t.toFixed(2)} s`;
    } else {
      ui.topoMin.textContent = "";
      ui.topoMax.textContent = "";
      ui.topoInfo.textContent = `${channels.length} located ch`;
    }
  }

  // --- controls ------------------------------------------------------------
  const timeStep = () => windowLengthS * 0.2;
  const scroll = (dt: number) => {
    windowStartS += dt;
    render();
  };
  const scrollChan = (dc: number) => {
    chanStart += dc;
    render();
  };
  const zoomChan = (factor: number) => {
    const g = group();
    const center = chanStart + chanCount / 2;
    chanCount = Math.max(
      MIN_VISIBLE_CHANNELS,
      Math.min(g.nChannels, Math.round(chanCount * factor)),
    );
    chanStart = Math.round(center - chanCount / 2);
    render();
  };
  ui.on("page-back", () => scroll(-windowLengthS));
  ui.on("step-back", () => scroll(-timeStep()));
  ui.on("step-fwd", () => scroll(timeStep()));
  ui.on("page-fwd", () => scroll(windowLengthS));
  ui.on("gain-up", () => {
    gain *= 1.5;
    gainManuallySet = true;
    render();
  });
  ui.on("gain-down", () => {
    gain /= 1.5;
    gainManuallySet = true;
    render();
  });
  ui.on("chan-zoom-in", () => zoomChan(0.5));
  ui.on("chan-zoom-out", () => zoomChan(2));
  ui.win.addEventListener("change", () => {
    windowLengthS = Number(ui.win.value) || 10;
    render();
  });
  ui.dc.addEventListener("change", () => {
    dcRemove = ui.dc.checked;
    render();
  });
  ui.events.addEventListener("change", () => {
    showEvents = ui.events.checked;
    render();
  });
  ui.butterflyCheck.addEventListener("change", () => {
    butterfly = ui.butterflyCheck.checked;
    render();
  });
  ui.clockCheck.addEventListener("change", () => {
    timeClock = ui.clockCheck.checked;
    render();
  });
  ui.hideBadCheck.addEventListener("change", () => {
    hideBad = ui.hideBadCheck.checked;
    render();
  });
  ui.topoBtn.addEventListener("click", () => {
    if (ui.topoBtn.disabled) return;
    showTopo = !showTopo && !!topoLayout;
    ui.topo.style.display = showTopo ? "flex" : "none";
    ui.topoBtn.setAttribute("aria-pressed", String(showTopo));
    ui.topoBtn.classList.toggle("eegv__btn--active", showTopo);
    render(); // re-sizes the scope (the topo panel takes width); drawTopo runs in render
  });

  // --- Settings (gear) popover --------------------------------------------
  let menuOpen = false;
  function setMenu(open: boolean): void {
    menuOpen = open;
    ui.menu.style.display = open ? "flex" : "none";
    ui.gearBtn.setAttribute("aria-expanded", String(open));
    ui.gearBtn.classList.toggle("eegv__gear--open", open);
  }
  function syncGear(): void {
    // A dot on the gear marks an active filter so it is clear the trace is filtered
    // even while the menu is closed.
    ui.gearBtn.classList.toggle("eegv__gear--active", hasFilters(filters));
  }
  ui.gearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setMenu(!menuOpen);
  });
  ui.menu.addEventListener("click", (e) => e.stopPropagation());
  const onDocClick = (): void => {
    if (menuOpen) setMenu(false);
  };
  document.addEventListener("click", onDocClick);
  cleanups.push(() => document.removeEventListener("click", onDocClick));
  syncGear(); // reflect the PowerLineFrequency notch default

  ui.hp.addEventListener("change", () => {
    filters.hp = Number(ui.hp.value) || null;
    syncGear();
    render();
  });
  ui.lp.addEventListener("change", () => {
    filters.lp = Number(ui.lp.value) || null;
    syncGear();
    render();
  });
  ui.notch.addEventListener("change", () => {
    filters.notch = Number(ui.notch.value) || null;
    notchUserSet = true;
    syncGear();
    render();
  });
  ui.preloadCheck.addEventListener("change", () => {
    preloadEnabled = ui.preloadCheck.checked;
    savePreloadEnabled(preloadEnabled);
    ui.preloadCap.disabled = !preloadEnabled;
    updatePrefetchTarget();
  });
  ui.preloadCap.addEventListener("change", () => {
    preloadCapMB = Number(ui.preloadCap.value) || DEFAULT_PRELOAD_CAP_MB;
    savePreloadCapMB(preloadCapMB);
    prefetchCache.setCapacity(preloadCapMB * 1024 * 1024);
    // A larger cap may let a walk that had halted (cache full) continue; force
    // a restart even though the target signature itself did not change. A
    // smaller cap just evicts down in setCapacity above -- no restart needed,
    // but forcing one is harmless (the walk quickly re-marks resident segments
    // as covered via the cache.has() short-circuit and resumes from there).
    prefetchSignature = "";
    updatePrefetchTarget();
  });
  // "Next moves through" (website#253). The prev/next controls it governs live
  // in the page's dialog chrome, not in this instance, so the choice is
  // persisted and announced rather than applied here. Announced on the root so
  // the page can re-label its controls without polling storage.
  ui.navOrder.addEventListener("change", () => {
    const order = normalizeNavOrder(ui.navOrder.value) ?? DEFAULT_NAV_ORDER;
    writeNavOrder(order);
    ui.root.dispatchEvent(
      new CustomEvent(NAV_ORDER_CHANGED_EVENT, { bubbles: true, detail: { order } }),
    );
  });
  ui.hscroll.addEventListener("input", () => {
    windowStartS = Number(ui.hscroll.value);
    render();
  });
  ui.vscroll.addEventListener("input", () => {
    chanStart = Math.round(Number(ui.vscroll.value));
    render();
  });
  if (ui.groupSel) {
    ui.groupSel.addEventListener("change", () => {
      groupIndex = Number(ui.groupSel?.value) || 0;
      windowStartS = 0;
      chanStart = 0;
      chanCount = group().nChannels;
      overviewLoaded = false;
      overviewData = null;
      overviewSeq++; // invalidate any in-flight overview load from the prior group
      // Stop the background walk immediately rather than let it keep fetching
      // the prior group in the background until the next render's level is
      // known; updatePrefetchTarget() re-starts it against the new group as
      // soon as renderImpl below picks a level for it.
      lastWinLevel = null;
      bufferedSegments = new Set();
      updatePrefetchTarget();
      // Re-arm auto-scale for the new group's own amplitude/modality (website#109).
      // The `gainManuallySet` guard inside renderImpl still wins if the user has
      // already touched Scale +/-, so this cannot stomp a manual adjustment.
      autoscalePending = true;
      // Topomap is scalp-only; disable + hide it when the active group is not scalp.
      const scalpNow = !!topoLayout && isScalpModality(group().modality);
      ui.topoBtn.disabled = !scalpNow;
      if (!scalpNow && showTopo) {
        showTopo = false;
        ui.topo.style.display = "none";
        ui.topoBtn.classList.remove("eegv__btn--active");
      }
      render();
    });
  }

  // Minimap click: set window start to clicked time (centered).
  ui.minimap.addEventListener("click", (e) => {
    const rect = ui.minimap.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const g = group();
    const targetCenter = frac * g.durationS;
    windowStartS = Math.max(0, targetCenter - windowLengthS / 2);
    render();
  });

  ui.canvas.addEventListener(
    "wheel",
    (e) => {
      // Vertical wheel scrolls the montage when zoomed; Shift+wheel scrolls time.
      if (e.shiftKey) scroll(Math.sign(e.deltaY) * timeStep());
      else if (group().nChannels > chanCount) {
        scrollChan(Math.sign(e.deltaY) * Math.max(1, Math.round(chanCount / 4)));
      } else return;
      e.preventDefault();
    },
    { passive: false },
  );

  // --- Bad-channel click in stacked mode (gutter label hit-test) -----------
  ui.canvas.addEventListener("click", (e) => {
    if (butterfly) return; // butterfly has no per-slot geometry
    if (!lastFrame || lastFrame.channels.length === 0) return;
    const rect = ui.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x >= lastPlotLeft) return; // only gutter (x < gutter)
    const slots = lastSlots;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const top = slot.baseline - slot.halfHeight;
      const bot = slot.baseline + slot.halfHeight;
      if (y >= top && y < bot) {
        const label = lastFrame.channels[i].label;
        // With the pencil armed a channel click is an annotation gesture: it
        // opens the popover for that channel, and the popover's status field
        // then decides the mark. Toggling here as well would fight it — the
        // annotator would land in a "bad" popover for a channel the same click
        // had just made good. With the pencil off nothing changes.
        if (annotations.onChannelClick(label)) break;
        if (badChannels.has(label)) badChannels.delete(label);
        else badChannels.add(label);
        // Channel marking IS the selection the annotation tool acts on
        // (website#255), so tell it the set changed rather than giving it a
        // second, competing gesture of its own.
        annotations.onSelectionChanged();
        render();
        break;
      }
    }
  });

  // --- Cursor readout (mousemove) -----------------------------------------
  ui.canvas.addEventListener("mousemove", (e) => {
    if (!lastFrame) return;
    const rect = ui.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < lastPlotLeft || x > lastPlotLeft + lastPlotWidth) {
      ui.cursor.textContent = "";
      return;
    }
    const frame = lastFrame;
    const span = frame.windowEndS - frame.windowStartS;
    const tAtX = frame.windowStartS + ((x - lastPlotLeft) / lastPlotWidth) * span;

    let chanLabel = "";
    let valueStr = "";
    if (!butterfly && frame.channels.length > 0) {
      const slots = lastSlots;
      let hitIdx = -1;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (y >= s.baseline - s.halfHeight && y < s.baseline + s.halfHeight) {
          hitIdx = i;
          break;
        }
      }
      if (hitIdx >= 0) {
        const ch = frame.channels[hitIdx];
        chanLabel = ch.label;
        const col = Math.round(((x - lastPlotLeft) / lastPlotWidth) * (frame.nCols - 1));
        const clamped = Math.max(0, Math.min(frame.nCols - 1, col));
        if (ch.kind === "line" && ch.line.length > 0) {
          valueStr = formatSi(ch.line[clamped] ?? 0, frame.unitBase);
        } else if (ch.kind === "band") {
          const mid = ((ch.min[clamped] ?? 0) + (ch.max[clamped] ?? 0)) / 2;
          valueStr = formatSi(mid, frame.unitBase);
        }
      }
    }

    // Nearest event under the cursor (within a few px of its line) -> its
    // description, so hovering an event line explains the otherwise-cryptic code.
    let eventStr = "";
    const pxPerS = lastPlotWidth / Math.max(1e-6, span);
    let bestDx = 5;
    for (const ev of frame.events) {
      const dx = Math.abs(lastPlotLeft + (ev.onsetS - frame.windowStartS) * pxPerS - x);
      if (dx <= bestDx) {
        bestDx = dx;
        eventStr = ev.description ? `${ev.label}: ${ev.description}` : ev.label;
      }
    }

    const timeStr = timeClock ? formatClock(tAtX) : `${tAtX.toFixed(2)} s`;
    const base = chanLabel ? `${chanLabel} · ${timeStr} · ${valueStr}` : timeStr;
    ui.cursor.textContent = eventStr ? `${base} · ◆ ${eventStr}` : base;
    if (showTopo) {
      topoTime = tAtX;
      try {
        drawTopo();
      } catch (err) {
        console.error("[eeg-viewer] drawTopo failed:", err);
      }
    }
  });

  ui.canvas.addEventListener("mouseleave", () => {
    ui.cursor.textContent = "";
  });

  // --- Help overlay toggle -------------------------------------------------
  let helpVisible = false;
  function toggleHelp(): void {
    helpVisible = !helpVisible;
    ui.helpOverlay.style.display = helpVisible ? "block" : "none";
  }

  ui.root.addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "ArrowRight") scroll(e.shiftKey ? windowLengthS : windowLengthS / 4);
    else if (k === "ArrowLeft") scroll(e.shiftKey ? -windowLengthS : -windowLengthS / 4);
    else if (k === "ArrowDown") scrollChan(1);
    else if (k === "ArrowUp") scrollChan(-1);
    else if (k === "PageDown") scrollChan(chanCount);
    else if (k === "PageUp") scrollChan(-chanCount);
    else if (k === "Home") {
      // Step window length down (shorter window).
      const idx = WINDOW_CHOICES.indexOf(windowLengthS);
      if (idx > 0) {
        windowLengthS = WINDOW_CHOICES[idx - 1];
        ui.win.value = String(windowLengthS);
        render();
      }
    } else if (k === "End") {
      // Step window length up (longer window).
      const idx = WINDOW_CHOICES.indexOf(windowLengthS);
      if (idx >= 0 && idx < WINDOW_CHOICES.length - 1) {
        windowLengthS = WINDOW_CHOICES[idx + 1];
        ui.win.value = String(windowLengthS);
        render();
      }
    } else if (k === "+" || k === "=") {
      gain *= 1.5;
      gainManuallySet = true;
      render();
    } else if (k === "-") {
      gain /= 1.5;
      gainManuallySet = true;
      render();
    } else if (k === "d") {
      dcRemove = !dcRemove;
      ui.dc.checked = dcRemove;
      render();
    } else if (k === "b") {
      butterfly = !butterfly;
      ui.butterflyCheck.checked = butterfly;
      render();
    } else if (k === "t") {
      timeClock = !timeClock;
      ui.clockCheck.checked = timeClock;
      render();
    } else if (k === "h") {
      hideBad = !hideBad;
      ui.hideBadCheck.checked = hideBad;
      render();
    } else if (k === "?") {
      toggleHelp();
    } else if (k === "Escape" && menuOpen) {
      setMenu(false);
    } else return;
    e.preventDefault();
  });

  if (typeof ResizeObserver !== "undefined") {
    let raf = 0;
    let lastObservedW = -1; // -1 (not 0) so even a zero-width first observation renders once
    const ro = new ResizeObserver((entries) => {
      // The scope height tracks width, so only a width change needs a repaint.
      // Ignore height-only changes (e.g. the cursor readout row growing/shrinking)
      // that would otherwise re-render on every pointer enter/leave.
      const w = Math.round(entries[0]?.contentRect.width ?? ui.root.getBoundingClientRect().width);
      if (w === lastObservedW) return;
      lastObservedW = w;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => render());
    });
    ro.observe(ui.root);
    cleanups.push(() => ro.disconnect());
  }
  // Repaint when the site theme flips (the canvas reads CSS vars, so a light/dark
  // toggle on <html> must trigger a re-render to stay homogeneous).
  if (typeof MutationObserver !== "undefined") {
    const mo = new MutationObserver(() => render());
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
    cleanups.push(() => mo.disconnect());
  }
  // Background preload pauses while the tab is hidden (website#254) -- no point
  // spending bandwidth/CPU on a recording nobody can see mid-scrub.
  if (typeof document !== "undefined") {
    prefetchController.setHidden(document.hidden);
    const onVisibility = () => prefetchController.setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }
  // Clean abort on teardown (website#208's discipline, applied to this mount's
  // own background reads): stop() invalidates the walk and aborts whatever
  // segment fetch is in flight rather than letting it run to completion
  // against a viewer nobody is looking at any more.
  cleanups.push(() => prefetchController.stop());
  cleanups.push(() => glRenderer?.dispose());
  const destroy = () => {
    disposed = true;
    for (const c of cleanups) c();
  };
  (slot as HTMLElement & { _eegvCleanup?: () => void })._eegvCleanup = destroy;
  // Hand the caller a live snapshot getter, not a snapshot: it is read at the
  // moment the user navigates away, which is arbitrarily long after this.
  opts.onTransfer?.(snapshotTransfer);

  await render();
  void store.eventsReady.then((events) => {
    store.events = events;
    eventTypes = events ? buildEventTypes(events) : [];
    fillEventLegend(ui.legend, eventTypes);
    render();
  });

  return destroy;
}

/**
 * Canvas paint colors pulled from the page's design tokens so the plot matches
 * light/dark and the surrounding UI exactly. Falls back to the renderer defaults
 * if a token is absent.
 */
function themeColors(root: HTMLElement): { background: string; foreground: string; grid: string } {
  const cs = getComputedStyle(root);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--color-bg", "#ffffff"),
    foreground: v("--color-fg", "#1a1a1a"),
    grid: v("--color-border", "#e6e6e6"),
  };
}

// --- DOM scaffold ----------------------------------------------------------

interface ViewerUi {
  root: HTMLElement;
  plot: HTMLElement;
  scope: HTMLElement;
  canvas: HTMLCanvasElement;
  glCanvas: HTMLCanvasElement;
  minimap: HTMLCanvasElement;
  /** Standing note under the minimap for a degraded view pyramid; normally hidden. */
  overviewNote: HTMLElement;
  time: HTMLElement;
  chanInfo: HTMLElement;
  cursor: HTMLElement;
  status: HTMLElement;
  win: HTMLSelectElement;
  dc: HTMLInputElement;
  events: HTMLInputElement;
  butterflyCheck: HTMLInputElement;
  clockCheck: HTMLInputElement;
  hideBadCheck: HTMLInputElement;
  topoBtn: HTMLButtonElement;
  topo: HTMLElement;
  topoCanvas: HTMLCanvasElement;
  topoInfo: HTMLElement;
  topoMin: HTMLElement;
  topoMax: HTMLElement;
  hp: HTMLSelectElement;
  lp: HTMLSelectElement;
  notch: HTMLSelectElement;
  navOrder: HTMLSelectElement;
  hscroll: HTMLInputElement;
  vscroll: HTMLInputElement;
  groupSel: HTMLSelectElement | null;
  gearBtn: HTMLButtonElement;
  menu: HTMLElement;
  helpOverlay: HTMLElement;
  legend: HTMLElement;
  preloadCheck: HTMLInputElement;
  preloadCap: HTMLSelectElement;
  annotateBtn: HTMLButtonElement;
  annotPanel: HTMLElement;
  on(action: string, fn: () => void): void;
}

function navBtn(action: string, label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "eegv__btn";
  b.dataset.act = action;
  b.textContent = label;
  b.title = title;
  return b;
}

function buildDom(
  slot: HTMLElement,
  store: RecordingStore,
  eventTypes: EventType[],
  preloadEnabled: boolean,
  preloadCapMB: number,
): ViewerUi {
  const root = el("div", "eegv");
  root.tabIndex = 0;

  const bar = el("div", "eegv__toolbar");

  let groupSel: HTMLSelectElement | null = null;
  if (store.groups.length > 1) {
    groupSel = document.createElement("select");
    groupSel.className = "eegv__sel";
    store.groups.forEach((g, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = g.name;
      groupSel?.append(o);
    });
    bar.append(grouped("Group", groupSel));
  }

  // Time group.
  const time = el("span", "eegv__readout");
  const win = compactSelect(
    WINDOW_CHOICES.map((s) => [String(s), `${s} s`]),
    "10",
  );
  bar.append(
    grouped(
      "Time",
      navBtn("page-back", "«", "Page back"),
      navBtn("step-back", "‹", "Step back"),
      time,
      navBtn("step-fwd", "›", "Step forward"),
      navBtn("page-fwd", "»", "Page forward"),
      win,
    ),
  );

  // Amplitude group.
  bar.append(
    grouped(
      "Scale",
      navBtn("gain-down", "−", "Scale down (less µV/div)"),
      navBtn("gain-up", "+", "Scale up"),
    ),
  );

  // Channel-zoom group (magnifier).
  const chanInfo = el("span", "eegv__readout");
  bar.append(
    grouped(
      "Channels",
      navBtn("chan-zoom-out", magnifierGlyph("-"), "Show more channels"),
      chanInfo,
      navBtn("chan-zoom-in", magnifierGlyph("+"), "Zoom into fewer channels"),
    ),
  );

  // Topomap toggle -- a primary view control (right of Channels), not a set-once
  // gear setting. Disabled when the recording has no embedded electrode positions.
  const topoBtn = document.createElement("button");
  topoBtn.type = "button";
  topoBtn.className = "eegv__btn eegv__topo-btn";
  topoBtn.title = "Scalp topomap (split panel)";
  topoBtn.setAttribute("aria-pressed", "false");
  topoBtn.innerHTML = topoGlyph();
  // Scalp topomap is only meaningful for EEG/MEG. iEEG (intracranial), EMG, fNIRS,
  // or unrecognized modalities get the toggle disabled, so we never draw a
  // misleading scalp map for non-scalp electrodes. An estimated (standard-montage)
  // layout still enables the toggle, but its tooltip flags that it is not measured.
  const scalp = resolveScalpPositions(store);
  if (!scalp) {
    topoBtn.disabled = true;
    topoBtn.title = isScalpModality(store.groups[0]?.modality)
      ? "no locatable channels for a scalp topomap"
      : "scalp topomap is EEG/MEG only";
  } else if (scalp.estimated) {
    topoBtn.title = "Scalp topomap - standard 10-20 layout (dataset ships no electrodes.tsv)";
  }
  bar.append(grouped("Topo", topoBtn));

  // Annotation-mode toggle (website#255). A primary view control like the
  // topomap, not a gear setting: it changes what a click on the trace *does*,
  // which has to be visible at a glance rather than buried behind a popover.
  const annotateBtn = document.createElement("button");
  annotateBtn.type = "button";
  annotateBtn.className = "eegv__btn eegv__annot-btn-toggle";
  annotateBtn.title = "Annotate — click the trace for a marker, drag for a span";
  annotateBtn.setAttribute("aria-label", "Annotation mode");
  annotateBtn.setAttribute("aria-pressed", "false");
  annotateBtn.innerHTML = annotateGlyph();
  bar.append(grouped("Annotate", annotateBtn));

  // Set-once controls (zero-phase filters + display toggles) live behind a gear
  // popover so the primary bar stays uncluttered -- these are typically configured
  // once per dataset and forgotten.
  const hp = compactSelect(HP_CHOICES, "0");
  const lp = compactSelect(LP_CHOICES, "0");
  const notch = compactSelect(NOTCH_CHOICES, notchDefault(store.powerLineFrequency));
  const dc = labeledCheck("DC", true);
  const events = labeledCheck("Events", true);
  const butterflyLc = labeledCheck("Butterfly", false);
  const clockLc = labeledCheck("Clock", false);
  const hideBadLc = labeledCheck("Hide bad", false);

  // Background preload (website#254): off by default, its own self-contained
  // group appended at the end of the menu so it stays out of the way of any
  // other gear-menu section (see website#253, in flight concurrently).
  const preloadLc = labeledCheck("Preload full recording", preloadEnabled);
  preloadLc.wrap.title =
    "Stream the rest of the recording into memory in the background, at the current zoom level, so paging and scrubbing elsewhere become instant. Off by default; capped in-memory cache.";
  const preloadCap = compactSelect(PRELOAD_CAP_CHOICES, String(preloadCapMB));
  preloadCap.title = "Background preload memory cap";
  preloadCap.disabled = !preloadEnabled;

  const gearBtn = document.createElement("button");
  gearBtn.type = "button";
  gearBtn.className = "eegv__gear";
  gearBtn.title = "Settings — filters & display";
  gearBtn.setAttribute("aria-label", "Settings");
  gearBtn.setAttribute("aria-expanded", "false");
  gearBtn.innerHTML = gearGlyph();

  // Iteration order for the enlarged viewer's prev/next controls (website#253).
  // It lives here, with the other set-once preferences, and is shown even in
  // the inline panel where there are no prev/next controls to govern: the
  // instance moves between the panel and the dialog without remounting, so a
  // gear that gains and loses an item on a move would be worse than one that
  // always offers the preference.
  const navOrder = compactSelect(
    NAV_ORDERS.map((o) => [o, NAV_ORDER_LABELS[o]] as [string, string]),
    readNavOrder(),
  );
  navOrder.title = "Which entity the enlarged viewer's Next button advances first";

  const menu = el("div", "eegv__menu");
  menu.style.display = "none";
  menu.append(
    grouped("Filter (Hz)", fieldLabel("HP", hp), fieldLabel("LP", lp), fieldLabel("Notch", notch)),
    grouped("Display", dc.wrap, events.wrap, butterflyLc.wrap, clockLc.wrap, hideBadLc.wrap),
    grouped("Next moves through", navOrder),
    grouped("Preload", preloadLc.wrap, fieldLabel("Cache", preloadCap)),
  );
  const settings = el("div", "eegv__settings");
  settings.append(gearBtn, menu);
  bar.append(settings);

  // Cursor readout: a compact overlay tucked into the bottom-right of the scope
  // (appears on hover, hidden otherwise) rather than a full-width line.
  const cursor = el("div", "eegv__cursor");
  cursor.setAttribute("aria-live", "polite");

  // Help overlay (absolutely positioned inside the eegv root).
  const helpOverlay = el("div", "eegv__help");
  helpOverlay.style.display = "none";
  helpOverlay.innerHTML = `
    <div class="eegv__help-inner">
      <strong>Keyboard shortcuts</strong>
      <ul>
        <li><kbd>←</kbd> / <kbd>→</kbd> &mdash; scroll time (small step)</li>
        <li><kbd>Shift+←</kbd> / <kbd>Shift+→</kbd> &mdash; scroll time (page)</li>
        <li><kbd>↑</kbd> / <kbd>↓</kbd> &mdash; scroll channels</li>
        <li><kbd>+</kbd> / <kbd>-</kbd> &mdash; scale up / down</li>
        <li><kbd>Home</kbd> / <kbd>End</kbd> &mdash; window shorter / longer</li>
        <li><kbd>d</kbd> &mdash; toggle DC removal</li>
        <li><kbd>b</kbd> &mdash; toggle butterfly mode</li>
        <li><kbd>t</kbd> &mdash; toggle clock time format</li>
        <li><kbd>h</kbd> &mdash; hide channels marked bad</li>
        <li><kbd>?</kbd> &mdash; toggle this help</li>
      </ul>
      <p style="margin:0;font-size:10px;color:var(--color-fg-subtle)">Click a channel label to mark it bad (dim; <kbd>h</kbd> hides them)</p>
      <p style="margin:4px 0 0;font-size:10px;color:var(--color-fg-subtle)">Annotate mode (pencil): click the trace for an event marker, drag for a span. Marked channels can be annotated as a set.</p>
    </div>
  `.trim();

  // Scope: a positioned wrapper holding the WebGL trace layer (background +
  // signal, behind) and the 2D chrome layer (labels/axis/events, in front). Both
  // canvases fill the scope via CSS inset:0; JS sizes them together. Falls back to
  // the 2D canvas alone (opaque) when WebGL is unavailable.
  const plot = el("div", "eegv__plot");
  const scope = el("div", "eegv__scope");
  const glCanvas = document.createElement("canvas");
  glCanvas.className = "eegv__glcanvas";
  const canvas = document.createElement("canvas");
  canvas.className = "eegv__canvas";
  scope.append(glCanvas, canvas);
  const vscroll = document.createElement("input");
  vscroll.type = "range";
  vscroll.className = "eegv__vscroll";
  vscroll.title = "Scroll channels";
  // Topomap split-panel (right of the scope; hidden until toggled).
  const topo = el("div", "eegv__topo");
  topo.style.display = "none";
  const topoCanvas = document.createElement("canvas");
  topoCanvas.className = "eegv__topo-canvas";
  topoCanvas.title = "Scalp topography at the cursor time";
  const topoBar = el("div", "eegv__topo-bar"); // viridis colorbar
  topoBar.style.background = `linear-gradient(to right, ${VIRIDIS_CSS})`;
  const topoMin = el("span", "eegv__topo-end");
  const topoMax = el("span", "eegv__topo-end");
  const topoScale = el("div", "eegv__topo-scale");
  topoScale.append(topoMin, topoBar, topoMax);
  const topoInfo = el("div", "eegv__topo-info");
  topo.append(topoCanvas, topoScale, topoInfo);
  plot.append(scope, vscroll, topo, cursor);

  const hscroll = document.createElement("input");
  hscroll.type = "range";
  hscroll.className = "eegv__hscroll";
  hscroll.title = "Scrub time";

  // Overview minimap canvas (hidden until data loads).
  const minimap = document.createElement("canvas");
  minimap.className = "eegv__minimap";
  minimap.style.display = "none";
  minimap.title = "Overview — click to jump";

  // Sits directly under the minimap because that is the affordance a truncated
  // view pyramid actually damages: the envelope it draws covers less of the
  // recording than it appears to.
  const overviewNote = el("p", "eegv__overview-note");
  overviewNote.setAttribute("role", "status");
  overviewNote.hidden = true;

  // Event legend: a compact scrollable table. Show the human description from the
  // events.json Levels when present (the raw code is meaningless on its own); the
  // chip's title carries the code for reference. All types listed (scroll, not grow).
  const legend = el("div", "eegv__legend");
  fillEventLegend(legend, eventTypes);

  // Annotation panel container (website#255). Built empty and hidden here so
  // its position in the stack is fixed; the annotation layer fills it.
  const annotPanel = el("div", "eegv__annot-panel");
  annotPanel.hidden = true;

  const status = el("div", "eegv__status");
  root.append(bar, plot, hscroll, minimap, overviewNote, legend, annotPanel, status, helpOverlay);
  slot.append(root);

  return {
    root,
    plot,
    scope,
    canvas,
    glCanvas,
    minimap,
    overviewNote,
    time,
    chanInfo,
    cursor,
    status,
    win,
    dc: dc.input,
    events: events.input,
    butterflyCheck: butterflyLc.input,
    clockCheck: clockLc.input,
    hideBadCheck: hideBadLc.input,
    preloadCheck: preloadLc.input,
    preloadCap,
    topoBtn,
    topo,
    topoCanvas,
    topoInfo,
    topoMin,
    topoMax,
    hp,
    lp,
    notch,
    navOrder,
    hscroll,
    vscroll,
    groupSel,
    gearBtn,
    menu,
    helpOverlay,
    legend,
    annotateBtn,
    annotPanel,
    on(action, fn) {
      root
        .querySelector<HTMLButtonElement>(`[data-act="${action}"]`)
        ?.addEventListener("click", fn);
    },
  };
}

function renderUnavailable(slot: HTMLElement, opts: ViewerOptions, err: unknown): void {
  // A directory recording (`.mefd`/`.ds`/BTi, website#252) has no single file
  // to download: `downloadUrl` names a data.nemar.org directory, which answers
  // with raw listing JSON. Point at the row's expand arrow instead, in the same
  // words `fallbackActionHtml` uses in dataset/[id].astro — the two are one
  // sentence on two surfaces, so keep them in sync.
  const dl = opts.dirRecording
    ? " Use the expand arrow next to its name to browse the recording's files instead."
    : opts.downloadUrl
      ? ` <a href="${escapeAttr(opts.downloadUrl)}" download>Download the file</a> instead.`
      : "";
  // A recorded data failure (derivative, corrupt, unsupported) has a specific,
  // permanent reason -> show it. Otherwise the store is just missing: still
  // generating, or a transient failure that will retry.
  const msg = opts.failureReason
    ? escapeAttr(opts.failureReason)
    : "No interactive viewer for this recording yet (the Zarr serving copy may still be generating).";
  slot.innerHTML = `<div class="eegv"><p class="eegv__msg">${msg}${dl}</p></div>`;
  console.warn("[eeg-viewer] unavailable:", err);
}

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function fillEventLegend(legend: HTMLElement, eventTypes: EventType[]): void {
  legend.replaceChildren();
  for (const t of eventTypes) {
    const chip = el("span", "eegv__chip");
    chip.title = t.description ? `${t.label} — ${t.description}` : t.label;
    const dot = el("span", "eegv__dot");
    dot.style.background = t.color;
    chip.append(dot, document.createTextNode(`${t.description || t.label} (${t.count})`));
    legend.append(chip);
  }
}

/** A labeled control group: a small-caps label above a row of controls. */
function grouped(label: string, ...controls: Array<Node>): HTMLElement {
  const g = el("div", "eegv__group");
  const lab = el("span", "eegv__group-label");
  lab.textContent = label;
  const row = el("div", "eegv__group-row");
  row.append(...controls);
  g.append(lab, row);
  return g;
}

/** A small inline magnifier glyph with a +/- center, as button content. */
function magnifierGlyph(sign: "+" | "-"): string {
  return sign === "+" ? "⊕" : "⊖";
}

/** Inline gear (settings) icon for the popover toggle. */
function gearGlyph(): string {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
}

/** Scalp modalities a head topomap is valid for. iEEG (intracranial), EMG, fNIRS,
 *  and unrecognized modalities are excluded so we never draw a misleading head map. */
const SCALP_MODALITIES = new Set(["EEG", "MEG"]);
function isScalpModality(modality: string | undefined): boolean {
  return SCALP_MODALITIES.has((modality || "").toUpperCase());
}

/**
 * Effective electrode positions for the scalp topomap. Returns null (no topomap) unless
 * the recording is a scalp modality. Real `electrodes.tsv` coordinates embedded in the
 * store win; when the store carries none, fall back to a standard 10-20/10-10 montage
 * matched to the EEG channel labels (the EEGLAB/MNE "apply a named montage" behaviour),
 * keyed by each channel's own label spelling so the render lookup matches. `estimated`
 * is true for the montage fallback so the UI can flag that the layout is not measured.
 * Requires >=3 locatable channels either way, so non-standard label sets (EGI "E1",
 * BioSemi "A1..", numeric) resolve nothing and get no topomap rather than a wrong one.
 */
function resolveScalpPositions(
  store: RecordingStore,
): { positions: Record<string, Vec3>; system: string; estimated: boolean } | null {
  if (!isScalpModality(store.groups[0]?.modality)) return null;
  const measured = store.electrodePositions;
  if (Object.keys(measured).length >= 3) {
    return { positions: measured, system: store.electrodeCoordinateSystem, estimated: false };
  }
  const labels: string[] = [];
  for (const g of store.groups) {
    if (isScalpModality(g.modality)) for (const c of g.channels) labels.push(c.label);
  }
  const positions = standardMontageFor(labels);
  // System "" is non-ALS, so the RAS standard-montage coords pass through alsToRas.
  return Object.keys(positions).length >= 3 ? { positions, system: "", estimated: true } : null;
}

/** Inline topomap icon: a head circle with a nose notch at the top. */
function topoGlyph(): string {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13.5" r="8"/><path d="M9.2 6 L12 2.8 L14.8 6"/></svg>';
}

/** Default Notch select value: the recording's PowerLineFrequency when it is a
 *  supported option (50/60 Hz), else "0" (off). Datasets that do not declare one
 *  open unfiltered. */
function notchDefault(powerLineFrequency: number | null): string {
  return powerLineFrequency === 50 || powerLineFrequency === 60 ? String(powerLineFrequency) : "0";
}

function compactSelect(options: Array<[string, string]>, value: string): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "eegv__sel";
  for (const [v, t] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    if (v === value) o.selected = true;
    select.append(o);
  }
  return select;
}

function labeledCheck(
  label: string,
  checked: boolean,
): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el("label", "eegv__field");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  wrap.append(input, document.createTextNode(` ${label}`));
  return { wrap, input };
}

/** A small inline "Label <control>" field (for the filter selects). */
function fieldLabel(label: string, control: HTMLElement): HTMLElement {
  const wrap = el("label", "eegv__field");
  wrap.append(document.createTextNode(`${label} `), control);
  return wrap;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/'/g, "&#x27;")
    .replace(/>/g, "&gt;");
}
