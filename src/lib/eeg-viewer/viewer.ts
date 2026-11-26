import { isIeegModality, spatialLayout, stackedScopeHeight } from "../ieeg-spatial/layout";
// Types only: the panel's code is fetched by `startSpatial` for an iEEG recording, never here.
import type { GroupInfo, SpatialPanel } from "../ieeg-spatial/panel";
import { loadMontage } from "../quality-views/montage-loader";
import type { SignalMarks } from "../quality-views/panel-bridge";
import type { SensorFieldClient } from "../quality-views/worker-client";
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
import {
  type AnnotationLayer,
  SCOPE_OVERLAY_ATTR,
  annotateGlyph,
  createAnnotationLayer,
} from "./annotation-ui";
import { createCursorSource } from "./cursor-source";
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
import { RETRY_CLASS } from "./retry";
import {
  type Placement,
  SEQUENTIAL_GRADIENT,
  type ScalpInput,
  paintScalpMap,
  placeScalpSensors,
  placementSentence,
  rowValues,
  templateNote,
  viewOfDraw,
  viewOfPlacement,
} from "./scalp-map";
import {
  type ChannelWindow,
  type GroupHandle,
  type RecordingStore,
  type WindowData,
  chooseWindowLevel,
  isMissingStoreError,
  openRecording,
  readLevel0,
  readOverview,
  readViewLevel,
  readWindow,
  windowDataBytes,
} from "./store";

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
  /**
   * Receives a handle on the instance's annotation state, on the same terms as
   * `onTransfer` (once, only for a mount that produced a viewer).
   *
   * The page needs it because a recording swap destroys this instance, and an
   * annotation popover holds an unsaved draft that lives nowhere else — so the
   * chrome around the viewer has to be able to ask before it navigates.
   */
  onAnnotations?: (handle: ViewerAnnotationHandle) => void;
  /**
   * An element the caller wants floated over the signal plot, appended into
   * `.eegv__scope` on every mount and stamped with `data-eegv-overlay`
   * (website#410: the embed route's NEMAR mark, a link back to the dataset).
   * The caller owns its content, position and styling; the same node is moved
   * into each new scope, so a recording swap keeps one element rather than
   * accumulating copies. To sit above the plot it needs a z-index of at least
   * 4: the scope stacks the WebGL and chrome canvases at 0 and 1, the
   * annotation canvas at 2 and the armed-annotation ring at 3 (see
   * `src/styles/eeg-viewer.css`). The cursor readout, at 5, stays above it.
   *
   * The viewer's own gestures stay off it. The annotation layer's
   * capture-phase handlers on the scope ignore presses that start inside it
   * (`startsInScopeOverlay`), and the cursor readout treats its box as a
   * no-readout zone, because the readout shares the plot's bottom-right
   * corner and a caller may well hide the overlay while the readout shows.
   * Without that zone a hidden overlay with `pointer-events: none` would let
   * the canvas under it keep the readout up, and the overlay could never be
   * reached with a mouse.
   *
   * The dataset page passes none, and nothing about its viewer changes.
   */
  scopeOverlay?: HTMLElement;
  /**
   * Size the scope to the room the host element (`slot`) leaves after the
   * viewer's other controls, instead of the default width-derived rule
   * (website#410: the embed route, whose iframe has a height the embedder
   * chose and must not scroll inside).
   *
   * Requires a host whose height does not depend on its own content: a flex
   * item with `min-block-size: 0`, or anything with a definite block size.
   * Measured against a content-sized host, the fit has nothing to fill and
   * settles at `FIT_MIN_PLOT_HEIGHT`.
   *
   * Tracks resizes of the host and of the viewer's own chrome (the legend and
   * minimap fill in after the first paint, the annotation panel opens and
   * closes, the toolbar wraps at a new width) without a ResizeObserver
   * feedback loop: setting the scope height changes the root's height, which
   * the observer reports, but the recomputed fit is then the height already
   * applied, so nothing re-renders. See `fitScopeHeight`.
   *
   * Off by default; the dataset page leaves it off and keeps its rule.
   */
  fitHeight?: boolean;
  /**
   * The link the "unavailable" fallback offers, in place of the download link
   * and the directory recording's "use the expand arrow" hint (website#410).
   *
   * Both defaults assume the dataset page: a download is one click away in
   * the file tree, and the expand arrow is on the tree row. The embed has
   * neither, so it points at the dataset page instead. Rendered as
   * `<a href target="_blank" rel="noopener">text</a> instead.`, with both
   * values escaped; a new tab because the one caller is a framed page, where
   * following the link in place would replace the viewer the embedder put
   * there.
   */
  unavailableLink?: { href: string; text: string };
  /**
   * What a Try again button does, for the one "unavailable" case a retry can
   * fix: the store exists but would not open (an outage), with no recorded data
   * failure. Absent: no button, as on a tree row, which has its own collapse and
   * reopen (website#416).
   */
  onRetry?: () => void | Promise<void>;
  /** This mount is a retry of a load that already failed, so the message says "still". */
  retried?: boolean;
  /**
   * The recording's place in the dataset, which switches on the "Brain" panel for intracranial
   * (iEEG) channel groups (IS-V1, ADR 0033): the dataset id, the version and the recording's
   * dataset-relative path name where its `_electrodes.tsv` and `_coordsystem.json` are read from
   * (`src/lib/ieeg-spatial/geometry.ts`). Absent: no Brain toggle, as for any other caller.
   * The embed route passes it too: the panel is a view, not an action, and its credit is a plain
   * link (ADR 0023).
   */
  spatial?: { datasetId: string; version: string; recording: string };
  /**
   * The quality panel's Signal tab (website phase W6): open on the window a `nemar.signal-window`
   * view names, with the floor's bad channels marked and its bad segments shaded. `prepare` runs
   * the view's checks against the store once it is open, before anything is drawn; a refusal
   * shows its sentence in place of the traces and draws nothing.
   */
  qualityMarks?: SignalMarks;
}

/** Whether a channel is drawn dimmed: marked bad by the visitor, or by the floor (website W6). The
 *  annotation layer reads the visitor's marks alone (`getSelectedChannels`). */
export function isDimmed(
  label: string,
  visitor: ReadonlySet<string>,
  floor: ReadonlySet<string>,
): boolean {
  return visitor.has(label) || floor.has(label);
}

/** Said when the store holds no channel group the marks name. */
export const MARKS_GROUP_MISSING =
  "The recording has no channel group the view names, so the window is not opened.";

/**
 * Smallest scope `fitHeight` will size to (CSS px). Below this the trace area
 * is too short to read, so a host that cannot fit it gets a viewer that
 * overflows it instead; the embed allows its document to scroll at that
 * point rather than draw an unusable plot.
 */
export const FIT_MIN_PLOT_HEIGHT = 140;

/**
 * The scope height `fitHeight` applies: the host's content height less the
 * height of everything in it that is not the scope, floored at
 * `FIT_MIN_PLOT_HEIGHT`.
 *
 * Floored to a whole pixel rather than rounded, so fractional chrome never
 * makes the viewer half a pixel taller than its host, which is a scrollbar.
 * Pure and exported so the arithmetic the no-scroll guarantee rests on is
 * covered by a test rather than living inside the mount closure.
 *
 * This is also what keeps the resize tracking free of a feedback loop: the
 * result does not depend on the scope's current height, only on the host and
 * the chrome, so re-measuring after applying it returns the same number. That
 * holds only while the chrome's height does not change with each render, which
 * is why a fit viewer's status line is held to one line (`.eegv--fit`): on a
 * narrow host "Signal loading…" fits one line and the full summary wraps to
 * two, so every render would move the fit and every fit would start a render.
 */
export function fitScopeHeight(hostHeight: number, chromeHeight: number): number {
  if (!Number.isFinite(hostHeight) || !Number.isFinite(chromeHeight)) return FIT_MIN_PLOT_HEIGHT;
  return Math.max(FIT_MIN_PLOT_HEIGHT, Math.floor(hostHeight - chromeHeight));
}

/**
 * What the page may ask (and tell) the mounted instance's annotation layer.
 * Deliberately the two questions the surrounding chrome actually has, not a
 * pass-through of the whole layer: everything else about annotations is the
 * viewer's own business.
 */
export interface ViewerAnnotationHandle {
  /** True while a popover is open, i.e. a draft exists only in that popover. */
  isPopoverOpen(): boolean;
  /** Flash and focus the open popover; no-op when none is open. */
  focusPopover(): void;
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
  /** Only honoured when `gainManuallySet` AND the new recording's first group
   *  is the same modality; otherwise auto-scale (website#109) runs against the
   *  new recording's own amplitude, a better estimate than whatever suited the
   *  previous one. */
  gain: number;
  gainManuallySet: boolean;
  /**
   * The modality `gain` was chosen against. Gain is a physical scale (µV/div
   * for EEG, fT/div for MEG), so carrying a manual one across modalities is
   * wrong by orders of magnitude — a flat line or a wall of clipping.
   *
   * Optional so a transfer record written before this field existed still type
   * checks; absent means "unknown", which is treated as a match, i.e. the
   * behaviour this field was added to narrow.
   */
  modality?: string;
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

/**
 * Whether a manually-set gain may travel from one recording to the next
 * (website#253's transfer, narrowed).
 *
 * `gain` multiplies the modality's own `DEFAULT_SCALINGS`, so it is a physical
 * scale — µV/div for EEG, fT/div for MEG — not a dimensionless zoom. Carrying
 * one across a modality change is wrong by orders of magnitude and shows up as
 * a flat line or a wall of clipping, with no control on screen explaining why.
 * Within a modality it is exactly the preference the user set and must survive.
 *
 * An absent or empty modality on either side counts as a match, per the repo's
 * null-safety convention for backend-shaped data (`splitModalities("") === []`
 * and friends): the store's `modality` is a free-text attr that can be missing,
 * and a missing value is not evidence of a mismatch. The comparison is
 * case-insensitive because the same attr arrives as both "EEG" and "eeg".
 *
 * Pure and exported so the failure mode above is covered by a test rather than
 * living unexercised inside the mount closure.
 */
export function gainCarriesOver(
  previousModality: string | undefined,
  nextModality: string | undefined,
): boolean {
  const from = (previousModality ?? "").trim().toUpperCase();
  const to = (nextModality ?? "").trim().toUpperCase();
  if (from === "" || to === "") return true;
  return from === to;
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

  // Owns every zarr fetch this mount attempt makes: the store open below and,
  // once mounted, every interactive window read (website#208). Registered as
  // the slot's cleanup immediately -- before the store has even opened -- so
  // that if a later `mountEegViewer` call supersedes this one while
  // `openRecording` is still in flight, ITS teardown-first block above runs
  // this abort instead of letting the fetch run to completion for a
  // `RecordingStore` nobody will use. Folded into the full disposer's own
  // cleanups once the mount succeeds (see `cleanups.push` below); aborting an
  // already-aborted controller is a no-op, so holding both references is safe.
  const abortController = new AbortController();
  (slot as HTMLElement & { _eegvCleanup?: () => void })._eegvCleanup = () =>
    abortController.abort();

  let store: RecordingStore;
  try {
    store = await openRecording(url, abortController.signal);
  } catch (err) {
    // Even the error path must respect staleness: a superseded attempt writing
    // "viewer unavailable" would replace a working viewer that a later mount
    // put in this slot. An aborted open is the same story either way -- the
    // fetch was cancelled on purpose (superseded or closed), not a real
    // failure worth surfacing.
    if (opts.isStale?.() || abortController.signal.aborted) return undefined;
    renderUnavailable(slot, opts, err, isRetryableUnavailable(opts, err));
    return undefined;
  }
  // Past the await, so a newer mount may already own this slot. Return before
  // writing anything — see `isStale` on ViewerOptions. Nothing needs releasing
  // here: no DOM was built yet, and the store holds no handle to close.
  if (opts.isStale?.() || abortController.signal.aborted) return undefined;
  if (store.groups.length === 0) {
    renderUnavailable(slot, opts, new Error("store has no channel groups"));
    return undefined;
  }

  // The floor's marks (website W6), checked against the store before anything is drawn.
  let marked: Extract<Awaited<ReturnType<SignalMarks["prepare"]>>, { ok: true }> | null = null;
  let markedGroup = 0;
  if (opts.qualityMarks) {
    const marks = opts.qualityMarks;
    markedGroup = marks.group === null ? 0 : store.groups.findIndex((g) => g.name === marks.group);
    const g = store.groups[markedGroup];
    const prepared = g
      ? await marks.prepare({
          labels: g.channelsByRow.map((c) => c.label),
          samples: g.nSamples,
          rate: g.rate,
        })
      : { ok: false as const, sentence: MARKS_GROUP_MISSING };
    if (opts.isStale?.() || abortController.signal.aborted) return undefined;
    if (!prepared.ok) {
      const root = document.createElement("div");
      root.className = "eegv";
      const message = document.createElement("p");
      message.className = "eegv__msg";
      message.dataset.eegvMarksRefused = "";
      message.textContent = prepared.sentence;
      root.append(message);
      slot.replaceChildren(root);
      return undefined;
    }
    marked = prepared;
  }
  let shaded: { startS: number; endS: number; label: string }[] = [];

  let eventTypes: EventType[] = [];

  // --- state ---------------------------------------------------------------
  // True once this mount's destroy() has run, so the fire-and-forget callbacks
  // below (view-level discovery settling, the preloader's stall notice) stop
  // touching DOM they no longer own.
  let disposed = false;
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
  // The floor's bad channels (the quality panel's marks, website W6): dimmed like a channel the
  // visitor marked, but never one of the visitor's marks, so the annotation layer never counts them.
  const floorBad = new Set<string>();
  /** Whether "Hide bad" hides a channel: the one rule the montage and its readout share, so the
   *  count said is the channels taken out. */
  const hidden = (label: string): boolean => hideBad && isDimmed(label, badChannels, floorBad);

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
    onStalled: () => syncPreloadNote(),
  });

  /**
   * The "preload paused" note, DERIVED rather than latched.
   *
   * `PrefetchController.stalled` is the single source of truth: the breaker
   * sets it, and both `start()` and `stop()` clear it, so it can never say
   * "stalled" about a walk that is running, or about no walk at all. A local
   * mirror of the flag could — and did: the recovery this note advertises
   * (toggle off and on) goes through `updatePrefetchTarget`, which returns
   * early when no view level is known yet, so a latched copy survived its own
   * cure and the note stuck permanently. The outage that trips the breaker is
   * the same one that fails the interactive read which would have supplied a
   * level, so that was the common case rather than the corner.
   *
   * Re-derived on every render for the same reason `syncDegradedNote` is: a
   * note that only updates on the paths that set it is a note that gets stuck.
   */
  function syncPreloadNote(): void {
    if (disposed) return;
    const show = preloadEnabled && prefetchController.stalled;
    ui.preloadNote.hidden = !show;
    ui.preloadNote.textContent = show
      ? "Preload paused — network trouble. Turn it off and on again to retry."
      : "";
  }

  /** (Re)targets and, when the target actually changed, restarts the
   *  background walk. Called after every render (cheap no-op when nothing
   *  about the target changed) and from the gear controls that affect it. */
  function updatePrefetchTarget(): void {
    if (!preloadEnabled || lastWinLevel === null) {
      prefetchController.stop();
      prefetchSignature = ""; // force a real restart next time preload is enabled
      // `stop()` retires the stall along with the walk, so the note goes too.
      // This is the toggle-off half of the recovery, and the group-switch path.
      syncPreloadNote();
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
    // `start()` clears the breaker, so a restart retires the notice — here
    // rather than in each of the handlers that can cause one (the preload
    // toggle, the cache cap, a group switch).
    syncPreloadNote();
  }
  // Topomap state. The projection is computed once (positions are fixed per
  // recording); topoTime tracks the cursor (null -> window center).
  let showTopo = false;
  let topoTime: number | null = null;
  // The Brain panel's cursor: a mouse resting over the traces (see cursor-source.ts).
  const cursorSource = createCursorSource((t) => spatial?.setCursor(t));
  // The scalp map (website ADR 0035 decision 5): built only for EEG/MEG, so non-scalp modalities
  // (iEEG/EMG/fNIRS/unknown) never get a head map. Where the sensors go is decided once per
  // recording by scalp-map.ts, with no frame assumed: the recording's own positions, else
  // template positions by channel name, else no map and the reason. The placement never rejects.
  // topoScratch is this viewer's private offscreen grid buffer (never shared).
  const topoScratch =
    typeof document !== "undefined" ? document.createElement("canvas") : undefined;
  const scalpInput = scalpInputOf(store);
  let placement: Placement | null = null;
  // Placed the first time the map is shown, so a recording whose map is never opened fetches no
  // montage (a placement by name loads the fourteen montages names reach).
  let placementStarted = false;
  function startPlacement(): void {
    if (placementStarted || !scalpInput) return;
    placementStarted = true;
    void placeScalpSensors(scalpInput, loadMontage).then((placed) => {
      if (disposed) return;
      placement = placed;
      ui.topoBtn.title = topoToggleTitle(placed, store);
      if (showTopo) {
        // The places are known before the first frame's samples: build the map's geometry in the
        // worker now, so the first map does not wait for it (website#592).
        if (placed.kind === "placed") void prepareTopo(placed);
        drawTopo();
      }
    });
  }
  // The map is drawn in the quality views' worker (worker-client.ts), loaded the first time the
  // panel draws. One draw is in flight at a time; a newer request waits and replaces any older one.
  // The page's one client is shared with any quality panel beside the viewer, so the viewer never
  // ends it: closing the viewer cancels its own draws.
  let topoClient: SensorFieldClient | null = null;
  let topoClientLoad: Promise<SensorFieldClient> | null = null;
  const topoAbort = new AbortController();
  const topoLayoutKey = `eeg-viewer:${opts.datasetId}:${opts.filePath}`;
  async function loadTopoClient(): Promise<SensorFieldClient> {
    if (!topoClient) {
      topoClientLoad ??= import("../quality-views/worker-client").then((m) =>
        m.sharedSensorFieldClient(),
      );
      topoClient = await topoClientLoad;
    }
    return topoClient;
  }
  async function prepareTopo(placed: {
    thetaDeg: Float64Array;
    radius: Float64Array;
  }): Promise<void> {
    try {
      const client = await loadTopoClient();
      if (!disposed) {
        await client.prepare({
          layoutKey: topoLayoutKey,
          thetaDeg: placed.thetaDeg,
          radius: placed.radius,
        });
      }
    } catch (err) {
      topoClientLoad = null;
      console.warn("[eeg-viewer] scalp map: the map worker could not be prepared:", err);
    }
  }
  let topoInFlight = false;
  let topoQueued: TopoRequest | null = null;

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

  // Safe to claim the slot: the previous instance was torn down at the top of
  // this function, and the `isStale` check after the await ruled out a newer
  // mount having taken ownership in the meantime.
  slot.innerHTML = "";
  // The Brain panel exists only when the caller named the recording and some channel group is
  // intracranial: otherwise there is nothing to look up and no button to show (IS-V1).
  const spatialWanted = !!opts.spatial && store.groups.some((g) => isIeegModality(g.modality));
  const ui = buildDom(slot, store, eventTypes, preloadEnabled, preloadCapMB, spatialWanted);
  const cleanups: Array<() => void> = [];
  cleanups.push(() => topoAbort.abort());
  // `fitHeight` hosts get chrome whose height cannot change from one render to
  // the next (`.eegv--fit` in eeg-viewer.css); see `fitScopeHeight`.
  if (opts.fitHeight) ui.root.classList.add("eegv--fit");
  // Default the notch filter from the recording's PowerLineFrequency (the converter
  // embeds it in the store attrs; the Notch select already reflects it). Datasets
  // without the sidecar field stay unfiltered. The declared line frequency can
  // still sit above this recording's Nyquist (60 Hz on a 100 Hz store), so it
  // goes through the same honesty check a transferred cutoff does.
  filters.notch = usableCutoff(Number(ui.notch.value) || null);
  ui.notch.value = String(filters.notch ?? 0);
  applyTransfer(opts.transfer);
  if (marked) {
    groupIndex = markedGroup;
    if (ui.groupSel) ui.groupSel.value = String(markedGroup);
    chanCount = store.groups[markedGroup].nChannels;
    const length =
      WINDOW_CHOICES.find((choice) => choice >= marked.durationS) ??
      WINDOW_CHOICES[WINDOW_CHOICES.length - 1];
    windowLengthS = length;
    ui.win.value = String(length);
    windowStartS = marked.startS;
    for (const label of marked.badChannels) floorBad.add(label);
    shaded = marked.segments.map((s) => ({
      startS: s.onset,
      endS: s.onset + s.duration,
      label: s.label,
    }));
    const said = document.createElement("p");
    said.className = "eegv__marks";
    said.dataset.eegvMarks = "";
    const bad = marked.badChannels.length
      ? `Marked bad by the floor (dimmed): ${marked.badChannels.join(", ")}.`
      : "The floor marked no channel bad.";
    const spans = marked.segments.length
      ? `${marked.segments.length} bad segments of the floor are shaded.`
      : "";
    said.textContent = [bad, spans, marked.note].filter(Boolean).join(" ");
    ui.root.prepend(said);
  }
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

  // After the annotation layer, which appends its own canvas to the scope, so
  // the overlay is the scope's last child. Stacking is still the caller's CSS
  // to settle (see `ViewerOptions.scopeOverlay`). `append` moves the node out
  // of a previous mount's already-discarded DOM, which is what keeps it one
  // element across recording swaps.
  const scopeOverlay = opts.scopeOverlay ?? null;
  if (scopeOverlay) {
    scopeOverlay.setAttribute(SCOPE_OVERLAY_ATTR, "");
    ui.scope.append(scopeOverlay);
  }

  function group(): GroupHandle {
    return store.groups[groupIndex];
  }

  // --- iEEG Brain panel (IS-V1) ----------------------------------------------
  // The panel decides everything (`src/lib/ieeg-spatial/panel.ts`); this is what it needs from the
  // viewer and what the viewer does for it: the group's labels and rates, sample reads, the toggle
  // button, and a highlighted band over the selected channel's trace.
  let highlightLabel: string | null = null;

  function spatialGroupInfo(): GroupInfo {
    const g = group();
    return {
      index: groupIndex,
      modality: g.modality,
      labels: g.channelsByRow.map((c) => c.label),
      units: g.channelsByRow.map((c) => c.unit),
      rateHz: g.rate,
      nativeRateHz: Number.isFinite(g.originalRate) && g.originalRate > 0 ? g.originalRate : null,
      durationS: g.durationS,
    };
  }

  /** Put the highlight band over the selected channel's slot, or hide it. */
  function placeTraceHighlight(): void {
    const band = ui.traceHl;
    const idx =
      highlightLabel === null || butterfly || !lastFrame
        ? -1
        : lastFrame.channels.findIndex((c) => c.label === highlightLabel);
    const slotBox = idx >= 0 ? lastSlots[idx] : undefined;
    if (!slotBox) {
      band.hidden = true;
      return;
    }
    band.style.top = `${slotBox.baseline - slotBox.halfHeight}px`;
    band.style.height = `${slotBox.halfHeight * 2}px`;
    band.hidden = false;
  }

  /** The panel selected a channel (or cleared): highlight its trace, and bring it into view. */
  function showSpatialTrace(label: string | null): void {
    highlightLabel = label;
    if (label !== null) {
      const row = group().channelsByRow.findIndex((c) => c.label === label);
      if (row >= 0 && (row < chanStart || row >= chanStart + chanCount)) {
        chanStart = Math.round(row - chanCount / 2);
        void render();
        return;
      }
    }
    placeTraceHighlight();
  }

  /**
   * Beside the scope when the viewer is wide enough; below it, at full width, when not (and only
   * while the panel is open, so a closed panel changes nothing about the viewer's layout).
   */
  function syncSpatialLayout(): void {
    if (!ui.spatialBox) return;
    const below = spatialLayout(ui.root.getBoundingClientRect().width) === "below";
    ui.plot.classList.toggle("eegv__plot--stack", below && !!spatial?.isOpen());
  }

  /** The toggle as the viewer shows it until the panel's code is loaded and takes it over. */
  function showBrainToggle(title: string): void {
    const btn = ui.brainBtn;
    if (!btn || !ui.brainGroup) return;
    ui.brainGroup.hidden = !isIeegModality(group().modality);
    btn.disabled = true;
    btn.title = title;
  }
  const CHECKING_TITLE = "Brain: checking this dataset for electrode positions";
  showBrainToggle(CHECKING_TITLE);

  /**
   * Load the panel's code and start it. Only for an iEEG recording with a spatial input, after
   * the first frame, so the electrode files are looked up (and the code fetched) only where there
   * are contacts to show, and never ahead of the signal.
   */
  let spatial: SpatialPanel | null = null;
  async function startSpatial(): Promise<void> {
    const where = opts.spatial;
    const box = ui.spatialBox;
    if (!spatialWanted || !where || !box) return;
    let panel: typeof import("../ieeg-spatial/panel");
    try {
      panel = await import("../ieeg-spatial/panel");
    } catch (err) {
      console.error("[eeg-viewer] the Brain panel's code did not load:", err);
      if (!disposed) {
        showBrainToggle("Brain view could not be loaded; reload the page to try again");
      }
      return;
    }
    if (disposed) return;
    spatial = panel.createSpatialPanel({
      recording: { datasetId: where.datasetId, version: where.version, path: where.recording },
      box,
      themeRoot: ui.root,
      group: spatialGroupInfo,
      readRows: (gi, startS, endS, r0, r1, signal) =>
        readLevel0(store.groups[gi], startS, endS, r0, r1, signal),
      setToggle: (t) => {
        const btn = ui.brainBtn;
        if (!btn || !ui.brainGroup) return;
        ui.brainGroup.hidden = !t.visible;
        btn.disabled = !t.enabled;
        btn.title = t.title;
        btn.setAttribute("aria-pressed", String(t.pressed));
        btn.classList.toggle("eegv__btn--active", t.pressed);
      },
      focusToggle: () => ui.brainBtn?.focus(),
      showTrace: showSpatialTrace,
      // Opening or closing the panel changes the scope's width; re-measure and redraw.
      layoutChanged: () => void render(),
    });
    spatial.start();
    // The first render has already run, so tell the panel the window that is on screen.
    if (lastFrame)
      spatial.setWindow(lastFrame.windowStartS, lastFrame.windowEndS - lastFrame.windowStartS);
  }
  ui.brainBtn?.addEventListener("click", () => spatial?.toggle());
  cleanups.push(() => spatial?.dispose());

  // --- degraded view pyramid ------------------------------------------------
  // `GroupHandle.viewLevelsDegraded` is the store's way of saying "the pyramid
  // in `viewLevels` is truncated because discovery hit a real failure", as
  // opposed to "this recording genuinely has that few levels". Only the first
  // is worth telling anyone about, and only the first is actionable (reload),
  // so it gets a standing note rather than a console warning nobody reads.
  // Without this the overview minimap and wide windows silently draw from a
  // partial pyramid and look like a short recording.

  /**
   * Status-line suffix for a degraded group; "" when the pyramid is intact.
   *
   * Deliberately does not name a cause. `ViewLevelDiscoveryError` covers a
   * retry-exhausted 5xx, a 403 from an expired token and a decode error alike,
   * and the flag does not say which — so "connection problem" would be a guess
   * presented as a diagnosis. What the reader can act on is the same either
   * way: reload.
   */
  function degradedNote(g: GroupHandle): string {
    return g.viewLevelsDegraded ? " · zoom levels incomplete" : "";
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
    // Held to one line in a `fitHeight` host, so the whole line is a tooltip.
    if (opts.fitHeight) ui.status.title = ui.status.textContent;
  }

  function syncDegradedNote(): void {
    if (disposed) return;
    const degraded = group().viewLevelsDegraded;
    ui.overviewNote.hidden = !degraded;
    ui.overviewNote.textContent = degraded
      ? "Some zoom levels failed to load. Reload to try again."
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
    // The user overrode auto-scale on the previous recording; respect that here
    // too rather than re-estimating and appearing to undo their work — but only
    // within one modality (see `gainCarriesOver`). Across modalities, drop it
    // and let auto-scale measure the new recording instead.
    const carries = gainCarriesOver(t.modality, store.groups[0].modality);
    if (t.gainManuallySet && carries && Number.isFinite(t.gain) && t.gain > 0) {
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
    // Only reopen the topomap for a scalp recording; an intracranial one keeps the panel closed.
    // A scalp recording whose map is refused reopens it, showing the reason.
    if (t.showTopo && scalpInput && !ui.topoBtn.disabled) {
      showTopo = true;
      startPlacement();
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
      // What `gain` is a scale *of*; the next mount refuses it across a
      // modality change (see applyTransfer).
      modality: group().modality,
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

  /**
   * `fitScopeHeight` against the live layout (`ViewerOptions.fitHeight`).
   *
   * The chrome is measured as everything in the host that is not the scope,
   * summed over the host's children rather than read off the viewer root
   * alone, so a sibling the caller appends after mounting (the units notice
   * the dataset page adds) is budgeted for too. Rect heights, not
   * `clientHeight`, because the latter is rounded and a rounded-up host is
   * how a fit ends up one pixel too tall.
   */
  function fittedScopeHeight(): number {
    const cs = getComputedStyle(slot);
    const px = (v: string) => Number.parseFloat(v) || 0;
    const host =
      slot.getBoundingClientRect().height -
      px(cs.borderTopWidth) -
      px(cs.borderBottomWidth) -
      px(cs.paddingTop) -
      px(cs.paddingBottom);
    let used = 0;
    for (const child of slot.children) used += child.getBoundingClientRect().height;
    return stackedScopeHeight(
      fitScopeHeight(host, used - ui.scope.getBoundingClientRect().height),
      ui.plot.classList.contains("eegv__plot--stack"),
    );
  }

  function sizeCanvas(): { w: number; h: number } {
    // The scope is the positioned frame; both canvases fill it (CSS inset:0). Its
    // width comes from flex (shrinks when the topo panel opens); we set its height.
    const rectW = ui.scope.getBoundingClientRect().width || ui.root.getBoundingClientRect().width;
    const cssW = Math.max(320, Math.round(rectW) || 800);
    let cssH: number;
    if (opts.fitHeight) {
      // The embed route (website#410): fill what the host leaves over. Still
      // independent of channel count, like the rule below.
      cssH = fittedScopeHeight();
    } else {
      // Fit the area the modal opens into: height tracks width (a ~2:1 scope) and
      // is capped by MAX_PLOT_HEIGHT and 70% of the viewport, so it never overflows.
      // It does NOT vary with channel count (stable embed boundary).
      const vpCap = Math.round((globalThis.innerHeight || 900) * 0.7);
      cssH = Math.max(280, Math.min(Math.round(cssW * 0.5), MAX_PLOT_HEIGHT, vpCap));
    }
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
      const win = await readWindow(
        g,
        start,
        end,
        plotWidth,
        readChanStart,
        readChanCount,
        false,
        abortController.signal,
      );
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
    const w = await readWindow(
      g,
      pStart,
      pEnd,
      plotWidth,
      chanStart,
      chanCount,
      true,
      abortController.signal,
    );
    if (w.channels.length === 0 || w.channels[0].kind !== "line") {
      // Window too wide for level-0: the read fell back to the pyramid band, which
      // filtfilt cannot touch. Re-read the *visible* (unpadded) window so its nCols
      // and time span line up with the axis -- returning the padded band would shift
      // every trace left by padS.
      const band =
        w.channels.length === 0
          ? w
          : await readWindow(
              g,
              start,
              end,
              plotWidth,
              chanStart,
              chanCount,
              false,
              abortController.signal,
            );
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
    syncSpatialLayout();
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
    // Written once per render, in full, before the read: the Hide bad count
    // comes from the montage rows in view, which are known now. Written in two
    // steps (the range here, the count after the read), the text grew and
    // shrank within every render, and in a `fitHeight` viewer each wrap of
    // the toolbar moved the plot and started another render.
    const visible = g.channelsByRow.slice(chanStart, visEnd);
    const hiddenInView = visible.filter((ch) => hidden(ch.label)).length;
    const chanRange =
      visEnd - chanStart >= g.nChannels
        ? `all ${g.nChannels}`
        : `${chanStart + 1}–${visEnd}/${g.nChannels}`;
    // Mirrors the reject-mode guard below: a view that is all bad channels
    // keeps them, so it reports none hidden.
    const hiddenNote =
      hiddenInView > 0 && hiddenInView < visible.length ? ` · ${hiddenInView} hidden` : "";
    ui.chanInfo.textContent = `${chanRange}${hiddenNote}`;

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
      // An aborted read (destroy() tore this mount down, or a superseding
      // mount reused this slot -- website#208) is a deliberate cancellation,
      // not a failure: leave whatever was already painted rather than
      // flashing "Signal unavailable" over a viewer that is (or is about to
      // be) gone, and write no other state for a request nobody asked to see
      // the result of.
      if (seq === renderSeq && !abortController.signal.aborted) {
        firstPaint = false;
        const msg = err instanceof Error ? err.message : String(err);
        const tc = themeColors(ui.root);
        glRenderer?.clear(tc.background); // wipe any stale GL frame under the overlay
        renderMessage(ctx, w, h, tc, `Signal unavailable: ${msg}`);
        statusBase = ""; // a late `watchViewLevels` must not overwrite this
        ui.status.textContent = `signal unavailable: ${msg}`;
        // This branch returns before `updatePrefetchTarget()` below, and it is
        // the SAME outage that trips the preloader's breaker — so without this
        // the note would be latched by a path that never re-evaluates it.
        syncPreloadNote();
      }
      return;
    } finally {
      prefetchController.notifyInteractiveEnd();
    }
    if (seq !== renderSeq) return; // a newer render superseded this one
    firstPaint = false;
    // The Brain panel's activity overlay follows the window on screen (no read happens unless its
    // Activity switch is on).
    spatial?.setWindow(start, end - start);
    // The window moved under a resting pointer: the cursor's time moved with it (and a plot that
    // narrowed past the pointer ends it).
    cursorSource.windowMoved(start, end, lastPlotLeft, lastPlotWidth);
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

    const n = Math.min(visible.length, win.channels.length);
    let channels: FrameChannel[] = visible.slice(0, n).map((ch, i) => {
      const color =
        ch.channelType && ch.channelType !== "OTHER"
          ? channelColor(ch.channelType)
          : channelColor(ch.modality);
      const cw = win.channels[i];
      const dim = isDimmed(ch.label, badChannels, floorBad);
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
    // if every visible channel is marked bad. The readout's count was written
    // before the read, from the same rows.
    // "Hide bad" hides the floor's marks too, as it hid every bad channel before W6.
    if (hideBad) {
      const kept = channels.filter((c) => !hidden(c.label));
      if (kept.length > 0) channels = kept;
    }

    const frame: ViewerFrame = {
      channels,
      nCols: win.nCols,
      windowStartS: start,
      windowEndS: end,
      events:
        showEvents && store.events ? eventsInWindow(store.events, eventTypes, start, end) : [],
      shaded: shaded.filter((span) => span.endS > start && span.startS < end),
      physPerDiv: defaultScaling(modality),
      unitBase: ELECTRIC.has(modality) ? "V" : "T",
      timeClock,
    };
    lastFrame = frame;
    lastSlots = traceLayout(frame.channels.length, lastPlotTop, lastPlotHeight);
    placeTraceHighlight();
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
    // Re-derived every frame, same as the note above: both are about a
    // background failure that can start and end with no handler firing.
    syncPreloadNote();

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
      data = await readOverview(g, abortController.signal);
    } catch (err) {
      // readOverview itself never rejects (it swallows failures, including a
      // caller-driven abort, and resolves to null) -- this catch is defense
      // in depth, so still skip logging an abort as if it were a failure.
      if (!abortController.signal.aborted) {
        console.error("[eeg-viewer] loadOverview failed:", err);
      }
    }
    // `disposed` covers the abort/teardown case (website#208): a torn-down
    // mount must not write overviewData, touch the minimap's (possibly
    // detached) display style, or call drawOverview(). `seq !== overviewSeq`
    // covers the narrower case of a group switch superseding this load.
    if (disposed || seq !== overviewSeq) return;
    overviewData = data;
    // "" hands display back to the stylesheet (`display: block`), so a page can
    // still hide the strip with an ordinary rule; the embed route does in
    // small frames.
    ui.minimap.style.display = data && data.length > 0 ? "" : "none";
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
  // its contribution. Reads from the already-loaded frame (no extra fetch). The map
  // is drawn in the worker; a refusal leaves it undrawn with its sentence.
  function topoCanvasSize(): number {
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
    ui.topoCanvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return cssSize;
  }

  /** Leave the map undrawn and say why, in the panel's own words. */
  function showTopoRefusal(sentence: string): void {
    const cssSize = topoCanvasSize();
    ui.topoCanvas.getContext("2d")?.clearRect(0, 0, cssSize, cssSize);
    // No empty square where the map would be: the sentence stands in its place.
    ui.topoCanvas.hidden = true;
    ui.topoScale.hidden = true;
    ui.topoMin.textContent = "";
    ui.topoMax.textContent = "";
    ui.topoInfo.textContent = sentence;
    ui.topoNote.textContent = "";
  }

  function drawTopo(): void {
    if (!showTopo || !scalpInput) return;
    const before = viewOfPlacement(placement);
    if (before?.kind === "undrawn") {
      showTopoRefusal(before.sentence);
      return;
    }
    if (placement?.kind !== "placed") return;
    const frame = lastFrame;
    if (!frame || frame.nCols <= 0) {
      const cssSize = topoCanvasSize();
      ui.topoCanvas.getContext("2d")?.clearRect(0, 0, cssSize, cssSize);
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
    const values = rowValues(
      placement.labels,
      frame.channels.map((ch) => ({
        label: ch.label,
        dim: ch.dim,
        value:
          ch.kind === "line"
            ? (ch.line[col] ?? Number.NaN)
            : ((ch.min[col] ?? Number.NaN) + (ch.max[col] ?? Number.NaN)) / 2,
      })),
    );
    requestTopo({ placement, values, t, unitBase: frame.unitBase });
  }

  function requestTopo(request: TopoRequest): void {
    if (topoInFlight) {
      topoQueued = request;
      return;
    }
    topoInFlight = true;
    void runTopo(request).finally(() => {
      topoInFlight = false;
      const next = topoQueued;
      topoQueued = null;
      if (next && !disposed) requestTopo(next);
    });
  }

  async function runTopo(request: TopoRequest): Promise<void> {
    const placed = request.placement;
    let outcome: Awaited<ReturnType<SensorFieldClient["draw"]>>;
    try {
      const client = await loadTopoClient();
      outcome = await client.draw(
        {
          layoutKey: topoLayoutKey,
          thetaDeg: placed.thetaDeg,
          radius: placed.radius,
          maps: [request.values],
        },
        { contours: "none", signal: topoAbort.signal },
      );
    } catch (err) {
      topoClientLoad = null;
      outcome = { kind: "unavailable", reason: err instanceof Error ? err.message : String(err) };
    }
    // A newer request replaces this one's picture; a closed panel shows nothing.
    if (disposed || !showTopo || topoQueued || placement !== placed) return;
    if (outcome.kind === "unavailable") console.warn("[eeg-viewer] scalp map:", outcome.reason);
    const view = viewOfDraw(outcome);
    if (view.kind === "unchanged") return;
    if (view.kind === "undrawn") {
      showTopoRefusal(view.sentence);
      return;
    }
    const map = view.map;
    const cssSize = topoCanvasSize();
    const tctx = ui.topoCanvas.getContext("2d");
    if (!tctx || !topoScratch) return;
    const [low, high] = paintScalpMap(
      tctx,
      cssSize,
      map,
      placed.thetaDeg,
      placed.radius,
      themeColors(ui.root),
      topoScratch,
    );
    ui.topoCanvas.hidden = false;
    ui.topoScale.hidden = false;
    ui.topoMin.textContent = formatSi(low, request.unitBase);
    ui.topoMax.textContent = formatSi(high, request.unitBase);
    const time = timeClock ? formatClock(request.t) : `${request.t.toFixed(2)} s`;
    ui.topoInfo.textContent = map.notes.length > 0 ? `${time} · flat field` : time;
    ui.topoNote.textContent = templateNote(placed) ?? "";
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
    showTopo = !showTopo && !!scalpInput;
    if (showTopo) startPlacement();
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
    // Toggling off and on is the retry the stall note advertises, and both
    // halves land in `updatePrefetchTarget`: off stops the walk (retiring the
    // breaker) and clears the signature, on starts a fresh one. Each exit syncs
    // the note, so the advertised cure works even when no view level is known
    // yet and the walk cannot restart at all.
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
    if (!writeNavOrder(order)) {
      // The return value exists precisely to say "localStorage refused"
      // (privacy mode, a blocked third-party context). The choice still applies
      // to this page via the event below, so this is a note, not a failure.
      console.warn(
        "[eeg-viewer] nav order not persisted (storage unavailable); the choice applies to this page only",
      );
    }
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
      // The Brain panel's contacts, selection and activity belong to one group's channels.
      if (spatial) spatial.setGroup(spatialGroupInfo());
      else if (ui.brainGroup) ui.brainGroup.hidden = !isIeegModality(group().modality);
      // Topomap is scalp-only; disable + hide it when the active group is not scalp.
      const scalpNow = !!scalpInput && isScalpModality(group().modality);
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
  // With the Brain panel open a click on a trace or its label selects the channel's contact(s)
  // instead (IS-V1); Shift+click on the label still marks it bad. The trace body is left to the
  // annotation tool while it is armed.
  ui.canvas.addEventListener("click", (e) => {
    if (butterfly) return; // butterfly has no per-slot geometry
    if (!lastFrame || lastFrame.channels.length === 0) return;
    const rect = ui.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const inGutter = x < lastPlotLeft;
    const picking = !!spatial?.isOpen();
    if (!inGutter && !(picking && !annotations.isActive())) return;
    const slots = lastSlots;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const top = slot.baseline - slot.halfHeight;
      const bot = slot.baseline + slot.halfHeight;
      if (y >= top && y < bot) {
        const label = lastFrame.channels[i].label;
        if (!inGutter) {
          spatial?.selectChannel(label);
          break;
        }
        // With the pencil armed a channel click is an annotation gesture: it
        // opens the popover for that channel, and the popover's status field
        // then decides the mark. Toggling here as well would fight it — the
        // annotator would land in a "bad" popover for a channel the same click
        // had just made good. With the pencil off nothing changes.
        if (annotations.onChannelClick(label)) break;
        if (picking && !e.shiftKey) {
          spatial?.selectChannel(label);
          break;
        }
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
  /** True when the pointer is inside the scope overlay's box (see
   *  `ViewerOptions.scopeOverlay` for why that box shows no readout). */
  function pointerOverOverlay(e: MouseEvent): boolean {
    if (!scopeOverlay?.isConnected) return false;
    const r = scopeOverlay.getBoundingClientRect();
    return (
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    );
  }
  ui.canvas.addEventListener("mousemove", (e) => {
    if (!lastFrame) return;
    if (pointerOverOverlay(e)) {
      ui.cursor.textContent = "";
      cursorSource.leave();
      return;
    }
    const rect = ui.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < lastPlotLeft || x > lastPlotLeft + lastPlotWidth) {
      ui.cursor.textContent = "";
      cursorSource.leave();
      return;
    }
    const frame = lastFrame;
    const span = frame.windowEndS - frame.windowStartS;
    const tAtX = frame.windowStartS + ((x - lastPlotLeft) / lastPlotWidth) * span;
    // The Brain panel recolors its contacts for this time (one recolor per animation frame).
    cursorSource.over(x, tAtX);

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
    cursorSource.leave();
  });
  // Touch has no hover: a touch (or a drag that starts a pan) ends the Brain panel's cursor, and
  // the mouse events a browser sends after a tap never start one. Mouse behavior is unchanged.
  for (const kind of ["down", "move", "leave", "cancel", "up"] as const) {
    ui.canvas.addEventListener(`pointer${kind}`, (e) => cursorSource.pointer(kind, e.pointerType));
  }
  for (const name of ["touchstart", "touchend", "touchcancel"]) {
    ui.canvas.addEventListener(name, () => cursorSource.touch(), { passive: true });
  }

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
  // `fitHeight` (website#410) also has to follow HEIGHT: the host's, when the
  // frame resizes, and the chrome's, when the legend or minimap fills in or
  // the annotation panel opens. A separate observer so the width-only one
  // above keeps its exact behavior on the dataset page. It re-renders only
  // when the fit actually moved: applying a height grows or shrinks the root,
  // which this observer then reports, but the fit it recomputes is the one
  // just applied, so that report ends here instead of looping.
  if (opts.fitHeight && typeof ResizeObserver !== "undefined") {
    let fitRaf = 0;
    const refit = (): void => {
      cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(() => {
        if (disposed) return;
        const applied = Math.round(ui.scope.getBoundingClientRect().height);
        const fit = fittedScopeHeight();
        if (fit === applied) return;
        // Applied now, not when `render` gets to it: a render already in
        // flight (a window read can take seconds) would otherwise leave the
        // viewer taller than its host, and the embed document scrolling, for
        // that whole read. The canvases are 100% of the scope, so until the
        // render below resizes their bitmaps the last frame is only stretched.
        ui.scope.style.height = `${fit}px`;
        render();
      });
    };
    const fitRo = new ResizeObserver(refit);
    fitRo.observe(slot);
    fitRo.observe(ui.root);
    // A sibling the caller appends to the host after mounting (the session's
    // units notice) is chrome too, but appending it resizes neither the host,
    // whose height the frame decides, nor the viewer root. Watch the host's
    // children, and each one's own size from then on (a wrapped notice grows
    // when the frame narrows), so it is budgeted rather than scrolled.
    const fitMo =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver((records) => {
            for (const r of records) {
              for (const n of r.addedNodes) if (n instanceof Element) fitRo.observe(n);
            }
            refit();
          })
        : null;
    fitMo?.observe(slot, { childList: true });
    cleanups.push(() => {
      fitRo.disconnect();
      fitMo?.disconnect();
      cancelAnimationFrame(fitRaf);
    });
  }
  // Repaint when the site theme flips (the canvas reads CSS vars, so a light/dark
  // toggle on <html> must trigger a re-render to stay homogeneous).
  if (typeof MutationObserver !== "undefined") {
    const mo = new MutationObserver(() => {
      spatial?.refreshTheme();
      void render();
    });
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
  // Clean abort on teardown (website#208): stop() invalidates the background
  // walk and aborts whatever segment fetch is in flight rather than letting it
  // run to completion against a viewer nobody is looking at any more.
  cleanups.push(() => prefetchController.stop());
  // Same discipline for the interactive path: aborts openRecording (if this
  // somehow still ran during teardown), every in-flight readWindow call
  // threaded through readFrame above, and the overview minimap's readOverview
  // call in loadOverview. Idempotent -- the early lightweight `_eegvCleanup`
  // registered before the store even opened may already have aborted this
  // same controller.
  cleanups.push(() => abortController.abort());
  cleanups.push(() => glRenderer?.dispose());
  // Idempotent. The page holds up to three handles on this one function — the
  // disposer returned below, `slot._eegvCleanup`, and the viewer session's
  // `live.destroy` (viewer-session.ts) — and a
  // dialog close landing during a navigate mount genuinely fires two of them.
  // Running the cleanups twice is not harmless: it double-disposes the GL
  // context and takes the annotation layer down in the middle of its own final
  // flush. The guard lives here, the one place all three handles converge,
  // rather than at each call site.
  const destroy = () => {
    if (disposed) return;
    disposed = true;
    for (const c of cleanups) c();
  };
  (slot as HTMLElement & { _eegvCleanup?: () => void })._eegvCleanup = destroy;
  // Hand the caller a live snapshot getter, not a snapshot: it is read at the
  // moment the user navigates away, which is arbitrarily long after this.
  opts.onTransfer?.(snapshotTransfer);
  // Same seam, same reason: the page asks these at click time, not now.
  opts.onAnnotations?.({
    isPopoverOpen: () => annotations.isPopoverOpen(),
    focusPopover: () => annotations.focusPopover(),
  });

  await render();
  // After the first frame, so looking up the electrode files never competes with the signal.
  if (!disposed) void startSpatial();
  void store.eventsReady.then((events) => {
    // Mirrors watchViewLevels' guard: a mount torn down while eventsReady is
    // still in flight must not write store.events/eventTypes, touch the
    // (possibly detached) legend node, or call render() -- which would touch
    // glRenderer after dispose() (website#208's discipline, applied here).
    if (disposed) return;
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
  /** The Brain toggle and its labeled group; null when the viewer has no Brain panel (IS-V1). */
  brainBtn: HTMLButtonElement | null;
  brainGroup: HTMLElement | null;
  /** The Brain panel's box in the plot row; null when there is no panel. */
  spatialBox: HTMLElement | null;
  /** The band drawn over the selected channel's trace (hidden unless a channel is selected). */
  traceHl: HTMLElement;
  topo: HTMLElement;
  topoCanvas: HTMLCanvasElement;
  topoInfo: HTMLElement;
  topoMin: HTMLElement;
  topoMax: HTMLElement;
  topoScale: HTMLElement;
  topoNote: HTMLElement;
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
  /** Note beside the preload toggle when the walk stalled; normally hidden. */
  preloadNote: HTMLElement;
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
  hasSpatial: boolean,
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

  // Time group. The `--time` modifier is for the embed route, which hides
  // this readout (src/pages/dataset/[id]/embed.astro).
  const time = el("span", "eegv__readout eegv__readout--time");
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
  topoBtn.title = TOPO_TITLE_BASE;
  topoBtn.setAttribute("aria-pressed", "false");
  topoBtn.innerHTML = topoGlyph();
  // Scalp topomap is only meaningful for EEG/MEG. iEEG (intracranial), EMG, fNIRS,
  // or unrecognized modalities get the toggle disabled, so we never draw a
  // misleading scalp map for non-scalp electrodes. A scalp recording keeps the
  // toggle: where its channels go is decided asynchronously (scalp-map.ts), and the
  // title then says where the positions came from, or why no map is drawn, which the
  // open panel also says in place of the map (topoToggleTitle).
  if (!scalpInputOf(store)) {
    topoBtn.disabled = true;
    topoBtn.title = isScalpModality(store.groups[0]?.modality)
      ? "no channels for a scalp topomap"
      : "scalp topomap is EEG/MEG only";
  }
  bar.append(grouped("Topo", topoBtn));

  // Brain toggle (IS-V1): intracranial contacts in the frame the dataset declares. Built only for
  // a viewer given a recording to look up; the panel (panel.ts) enables, titles and presses it.
  // Hidden until the panel says the channel group is intracranial.
  let brainBtn: HTMLButtonElement | null = null;
  let brainGroup: HTMLElement | null = null;
  if (hasSpatial) {
    brainBtn = document.createElement("button");
    brainBtn.type = "button";
    brainBtn.className = "eegv__btn eegv__topo-btn";
    brainBtn.disabled = true;
    brainBtn.title = "Brain: checking this dataset for electrode positions";
    brainBtn.setAttribute("aria-label", "Brain view of electrode contacts");
    brainBtn.setAttribute("aria-pressed", "false");
    brainBtn.dataset.spatialToggle = "";
    brainBtn.innerHTML = brainGlyph();
    brainGroup = grouped("Brain", brainBtn);
    brainGroup.hidden = true;
    bar.append(brainGroup);
  }

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
  // Only ever filled in when the walk's circuit breaker trips, so the buffered
  // bar going quiet has a stated cause instead of reading as a finished
  // preload.
  const preloadNote = el("p", "eegv__preload-note");
  preloadNote.setAttribute("role", "status");
  preloadNote.hidden = true;

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
    grouped("Preload", preloadLc.wrap, fieldLabel("Cache", preloadCap), preloadNote),
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
      ${hasSpatial ? '<p style="margin:4px 0 0;font-size:10px;color:var(--color-fg-subtle)">Brain panel open: click a trace or its label to select the channel&#39;s contact; Shift+click a label to mark it bad.</p>' : ""}
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
  const traceHl = el("div", "eegv__trace-hl");
  traceHl.hidden = true;
  traceHl.setAttribute("aria-hidden", "true");
  scope.append(glCanvas, canvas, traceHl);
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
  const topoBar = el("div", "eegv__topo-bar"); // sequential (viridis) colorbar
  topoBar.style.background = SEQUENTIAL_GRADIENT;
  const topoMin = el("span", "eegv__topo-end");
  const topoMax = el("span", "eegv__topo-end");
  const topoScale = el("div", "eegv__topo-scale");
  topoScale.append(topoMin, topoBar, topoMax);
  const topoInfo = el("div", "eegv__topo-info");
  // Where template positions came from, under the map (empty for a recording's own positions).
  const topoNote = el("div", "eegv__topo-note");
  topo.append(topoCanvas, topoScale, topoInfo, topoNote);
  // The Brain panel's box sits in the same row, after the scope and the topomap; its content is
  // the panel's own (panel.ts). Hidden until opened.
  let spatialBox: HTMLElement | null = null;
  if (hasSpatial) {
    spatialBox = el("div", "eegv__spatial");
    spatialBox.hidden = true;
    // One id per viewer on the page, so the toggle can say which box it controls.
    spatialBoxSeq += 1;
    spatialBox.id = `eegv-spatial-${spatialBoxSeq}`;
    brainBtn?.setAttribute("aria-controls", spatialBox.id);
  }
  plot.append(scope, vscroll, topo, ...(spatialBox ? [spatialBox] : []), cursor);

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
    preloadNote,
    topoBtn,
    topo,
    topoCanvas,
    topoInfo,
    topoMin,
    topoMax,
    topoScale,
    topoNote,
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
    brainBtn,
    brainGroup,
    spatialBox,
    traceHl,
    on(action, fn) {
      root
        .querySelector<HTMLButtonElement>(`[data-act="${action}"]`)
        ?.addEventListener("click", fn);
    },
  };
}

function renderUnavailable(
  slot: HTMLElement,
  opts: ViewerOptions,
  err: unknown,
  retryable = false,
): void {
  const onRetry = opts.onRetry;
  const offerRetry = retryable && Boolean(onRetry);
  slot.innerHTML = unavailableHtml(opts, isMissingStoreError(err), offerRetry);
  const button = slot.querySelector<HTMLButtonElement>(`.${RETRY_CLASS}`);
  if (button && onRetry) {
    button.addEventListener("click", () => {
      button.disabled = true;
      // Re-enabled when the retry settles: if it did not replace this message
      // (the page could not present the new host) the button must still work.
      Promise.resolve()
        .then(onRetry)
        .catch((e) => console.error("[eeg-viewer] retry failed:", e))
        .finally(() => {
          button.disabled = false;
        });
    });
  }
  console.warn(
    "[eeg-viewer] unavailable:",
    { datasetId: opts.datasetId, path: opts.filePath },
    err,
  );
}

const UNAVAILABLE_TEXT_ID = "eegv-unavailable-text";

/**
 * The whole "no viewer for this recording" block: the sentence, and Try again
 * after it when `retry` is set. The button is described by the sentence, so
 * focus landing on it after a failed retry reads the message too. The sentence
 * only carries an id when there is a button, because only the one live viewer
 * message ever has one (inline viewers under tree rows offer no retry, and
 * several can be on a page at once).
 */
export function unavailableHtml(
  opts: Parameters<typeof unavailableMessageHtml>[0],
  storeMissing: boolean,
  retry: boolean,
): string {
  const text = unavailableMessageHtml(opts, storeMissing);
  const sentence = retry ? `<span id="${UNAVAILABLE_TEXT_ID}">${text}</span>` : text;
  const button = retry
    ? ` <button type="button" class="${RETRY_CLASS}" aria-describedby="${UNAVAILABLE_TEXT_ID}">Try again</button>`
    : "";
  return `<div class="eegv"><p class="eegv__msg">${sentence}${button}</p></div>`;
}

/**
 * The "no viewer for this recording" sentence, as escaped HTML. Split out of
 * `renderUnavailable` so the choice of action and its escaping are unit
 * tested (website#410 added a caller-supplied action whose values come from
 * the embed page).
 */
export function unavailableMessageHtml(
  opts: Pick<
    ViewerOptions,
    "failureReason" | "dirRecording" | "downloadUrl" | "unavailableLink" | "retried"
  >,
  storeMissing = true,
): string {
  // A directory recording (`.mefd`/`.ds`/BTi, website#252) has no single file
  // to download: `downloadUrl` names a data.nemar.org directory, which answers
  // with raw listing JSON. Point at the row's expand arrow instead, in the same
  // words `fallbackActionHtml` uses in dataset/[id].astro — the two are one
  // sentence on two surfaces, so keep them in sync. A caller-supplied
  // `unavailableLink` (the embed route, website#410) replaces both.
  const dl = opts.unavailableLink
    ? ` <a href="${escapeAttr(opts.unavailableLink.href)}" target="_blank" rel="noopener">${escapeAttr(opts.unavailableLink.text)}</a> instead.`
    : opts.dirRecording
      ? " Use the expand arrow next to its name to browse the recording's files instead."
      : opts.downloadUrl
        ? ` <a href="${escapeAttr(opts.downloadUrl)}" download>Download the file</a> instead.`
        : "";
  // A recorded data failure (derivative, corrupt, unsupported) has a specific,
  // permanent reason -> show it. Otherwise "may still be generating" is only
  // true of a store that is not there (`isMissingStoreError`); a store that
  // exists and would not load (an outage, metadata it cannot read, a browser
  // without a canvas) is said to be just that. The outage case offers a retry
  // when the caller supplies `onRetry` (website#416).
  const msg = opts.failureReason
    ? escapeAttr(opts.failureReason)
    : storeMissing
      ? "No interactive viewer for this recording yet (the Zarr serving copy may still be generating)."
      : opts.retried
        ? "The viewer still could not load this recording."
        : "The viewer could not load this recording.";
  return `${msg}${dl}`;
}

/**
 * Whether a failed store open is the "could not load" case, the one a retry can
 * fix (an outage): no recorded data failure and not a store that is simply not
 * there. It is the store-open half of the split `unavailableMessageHtml` makes
 * (the same two conditions pick its "could not load" sentence), so on that path
 * the message and the Try again button agree. The two other callers of
 * `renderUnavailable` (no channel groups, no 2D canvas) say the same sentence
 * with no button, on purpose: nothing a retry does changes them. Metadata the
 * reader cannot parse counts as retryable too, since from here it looks the
 * same as an outage; a permanent one answers every retry with "still could not
 * load".
 */
export function isRetryableUnavailable(
  opts: Pick<ViewerOptions, "failureReason">,
  err: unknown,
): boolean {
  return !opts.failureReason && !isMissingStoreError(err);
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

const TOPO_TITLE_BASE = "Scalp topomap (split panel)";
const TOPO_TITLE_SUBJECT =
  "Scalp topomap - electrode positions from this subject's electrodes file";
const TOPO_TITLE_DATASET =
  "Scalp topomap - electrode positions from one electrodes file shared by every subject";

/** One map the topomap asks the worker for. */
interface TopoRequest {
  readonly placement: Placement & { kind: "placed" };
  readonly values: Float64Array;
  readonly t: number;
  readonly unitBase: "V" | "T";
}

/**
 * The topomap toggle's tooltip for a placement. Template positions by name say which montage, and
 * why the recording's own positions were not used when it has some; a refusal gives its sentence.
 * Positions the store carries say where the converter found them: the subject's own electrodes
 * file (`subject`) or one file shared by every subject (`dataset`), with the file named when the
 * store states it. A store that states no source (converted before the converter wrote one) keeps
 * the base title. No sentence calls the positions measured or digitized: a per-subject file can
 * hold template coordinates and the store cannot say which.
 */
export function topoToggleTitle(
  placement: Placement,
  provenance: Pick<RecordingStore, "electrodePositionsSource" | "electrodePositionsFile">,
): string {
  if (placement.kind === "refused") return `Scalp topomap - ${placementSentence(placement)}`;
  if (placement.source === "names") return `Scalp topomap - ${templateNote(placement)}`;
  const source = provenance.electrodePositionsSource;
  if (source === null) return TOPO_TITLE_BASE;
  const sentence = source === "subject" ? TOPO_TITLE_SUBJECT : TOPO_TITLE_DATASET;
  const file = provenance.electrodePositionsFile;
  return file === null ? sentence : `${sentence} (${file})`;
}

/**
 * What the scalp map reads of a recording, or null (no topomap) unless the recording is a scalp
 * modality with channels: the electrodes file's positions and frame, and the channels of its scalp
 * groups with their types.
 */
export function scalpInputOf(store: RecordingStore): ScalpInput | null {
  if (!isScalpModality(store.groups[0]?.modality)) return null;
  const channels: { label: string; channelType: string }[] = [];
  for (const g of store.groups) {
    if (!isScalpModality(g.modality)) continue;
    for (const c of g.channels) channels.push({ label: c.label, channelType: c.channelType });
  }
  if (channels.length === 0 && Object.keys(store.electrodePositions).length === 0) return null;
  return {
    positions: store.electrodePositions,
    coordinateSystem: store.electrodeCoordinateSystem,
    channels,
  };
}

/** Inline topomap icon: a head circle with a nose notch at the top. */
function topoGlyph(): string {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13.5" r="8"/><path d="M9.2 6 L12 2.8 L14.8 6"/></svg>';
}

let spatialBoxSeq = 0;

/** Inline Brain icon: a head profile with three contact dots. */
function brainGlyph(): string {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4C8 4 5 6.7 5 10.4c0 1.7.6 3 1.6 4 .2 1.6 1.4 3 3.4 3.5V20h4v-2c2-.5 3.2-1.9 3.4-3.5 1-1 1.6-2.3 1.6-4C19 6.7 16 4 12 4z"/><circle cx="9.5" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="13.5" r="1" fill="currentColor" stroke="none"/></svg>';
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
