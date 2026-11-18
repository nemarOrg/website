/**
 * The iEEG spatial panel of the signal viewer (card IS-V1): a "Brain" toggle that opens a side
 * panel drawing the recording's contacts in the frame the dataset declares, with an "Activity"
 * switch, two-way links between contacts and traces, plain refusals, and the RAVE credit.
 *
 * Two halves in one module:
 *
 * 1. A pure state machine (`reduce`, `viewModel`, and the helpers they use). Every decision lives
 *    here: whether the toggle is enabled and what its title says, which frame is the default, how
 *    a channel maps to contacts, when an activity read is requested (never while the switch is
 *    off, never past `MAX_ACTIVITY_SAMPLES`), what the stage shows, and the credit. `reduce`
 *    returns the next state and the effects the DOM half must run; `viewModel` is everything the
 *    DOM half draws. The credit is a field of the model in every state, so no state can leave it
 *    out. Both are covered by `panel.test.ts` without a DOM.
 * 2. `createSpatialPanel`, the DOM half: it runs the effects (resolve the dataset's sidecars,
 *    read level-0 samples once per window and compute them in slices, drive the renderer) and
 *    paints the model. It holds no decisions of its own.
 *
 * What it never does:
 * - It draws only the frames `geometry.ts` offered. Anatomy appears only behind a standard
 *   template frame that `transforms.ts` has a cited row for (card IS-V2, ADR 0033): the surface is
 *   fetched when the panel is open on such a frame, never for any other, contacts go through the
 *   row's affine only while the surface is drawn, and every such state carries the template label.
 *   There is no projection onto the surface and no inference from magnitudes. A lone contact at
 *   0 0 0 and positions spread wider than a head are drawn as written and warned about.
 * - It reads no signal sample while the Activity switch is off (the default), and none while the
 *   panel is closed. Turning the switch off, closing the panel, or a recording, group or frame
 *   change aborts any read in flight.
 * - It never caches a transient failure (`unreadable`, `listing_failed`) as permanent: the toggle
 *   stays enabled, the panel says so and offers Retry.
 * - It never names the frame from a description, and never picks a space for the reader beyond a
 *   default the frame selector shows: the first shown template space, else the first shown space.
 * - It never hides why it shows nothing (card IS-Q2). A recording whose channel names join no
 *   contact keeps an openable toggle and opens a refusal that lists both sets of names as the
 *   dataset wrote them (`name-refusal.ts`); a refusal for want of coordinates stays disabled with
 *   its sentence. When a declared non-millimeter unit is converted and every drawn contact then
 *   lies more than 300 mm from the origin, a banner on the stage and in every figure says so
 *   (`units-banner.ts`), the contacts are drawn as declared in the flat views, and no template is
 *   placed. Nothing is rescaled and no unit is inferred.
 */

import type { WindowData } from "../eeg-viewer/store";
import {
  ACTIVITY_METRICS,
  type ActivityMetric,
  type ActivityRefusal,
  type ActivityResult,
  type ActivityScale,
  BANDS,
  BAND_NYQUIST_FRACTION,
  type BandName,
  type ChannelActivity,
  type ChannelNullReason,
  activityChannelsFromWindow,
  buildScale,
  colorFor,
  computeActivity,
  minWindowSamples,
} from "./activity";
import {
  type BrainMesh,
  type BrainRenderer,
  type BrainTheme,
  MAX_CONTACTS,
  MIN_PICK_PX,
  createBrainRenderer,
  parseColor,
} from "./brain-gl";
import {
  MATCH_KINDS,
  MATCH_RULES,
  type MatchKind,
  type RuleTable,
  matchTag,
  ruleSentences,
} from "./channel-match";
import { type CreditLinkSpec, creditLink, creditLinkSpec } from "./credit";
import {
  type ChannelRef,
  type ExportFile,
  type ExportInput,
  FIGURE_FONT,
  type FigureTheme,
  type TemplatePlacement,
  channelClause,
  channelProvenance,
  downloadFailedSentence,
  downloadFile,
  exportPng,
  exportSvg,
  figureLabels,
  recordedLocation,
  templateLocation,
  viewContacts,
} from "./export";
import {
  type ChannelJoin,
  type Frame,
  type GeometryReason,
  type RawCells,
  type RecordingGeometry,
  type SpaceGeometry,
  type Units,
  type UnlocatedCause,
  type Vec3,
  dataPlaneSource,
  joinChannels,
  resolveRecordingGeometry,
} from "./geometry";
import { isIeegModality } from "./layout";
import {
  type NameRefusal,
  closedByNaming,
  nameRefusal,
  unlocatedCauseHeads,
  unlocatedChannelName,
} from "./name-refusal";
import {
  TEMPLATE_DIRECTORY,
  TEMPLATE_FAILED_SENTENCE,
  TEMPLATE_LICENSE_HREF,
  TEMPLATE_LOADING_SENTENCE,
  TEMPLATE_REFERENCE,
  type TemplatePlacementRule,
  fetchBytesSameOrigin,
  loadTemplateSurface,
  noPlacementSentence,
  placeOnTemplate,
  placementRuleFor,
  templateLabel,
} from "./transforms";
import { type UnitsBanner, unitsBanner } from "./units-banner";
import { type TemplateOutlines, layoutViews, parseViewOutlines, viewsMarkup } from "./views2d";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The most samples one activity computation reads: window samples times channels read. */
export const MAX_ACTIVITY_SAMPLES = 4_000_000;
/** Channels computed per slice, at most, so one slice stays well under a 200 ms long task. */
export const READ_SLICE_CHANNELS = 16;
/**
 * Samples computed per slice, at most: rows times a window's samples. A long window shrinks the
 * slice below `READ_SLICE_CHANNELS` channels (one channel is the floor, since a channel cannot be
 * cut). Measured in headless Chromium 148 (IS-Q2, no tracing, one band-power call): 1.5 ms for
 * 81,920 samples, 8.4 ms for 500,000 and 68 ms for 4,000,000, so this cap's 1,000,000 samples
 * is about 17 ms by linear interpolation (not measured at that size), against a 200 ms budget.
 */
export const SLICE_SAMPLE_CAP = 1_000_000;
/** Wait for the window to settle before reading, so a scroll does not start a read per frame. */
export const ACTIVITY_DEBOUNCE_MS = 150;
/** Give the sidecar reads, retries included, this long before offering Retry. */
export const GEOMETRY_TIMEOUT_MS = 30_000;
/**
 * Pauses before each further try when a read of the electrode files fails in a way that may pass.
 * The data plane answers 500 now and then, and one directory listing in four or five is enough to
 * fail a whole resolution, so the panel tries again quietly before it shows Retry.
 */
export const RETRY_DELAYS_MS: readonly number[] = [300, 800, 1600];
/** Drawn contacts spread wider than this (millimeters, declared units) get a warning: a head is about 200. */
export const SPAN_WARNING_MM = 250;
/** The 2D views' drawing box in the panel (CSS pixels at a 1:1 view box; the SVG scales to the stage). */
const VIEWS_WIDTH = 340;
const VIEWS_HEIGHT = 330;
/** Unselected contacts are drawn this opaque while a selection exists. */
const DIM_ALPHA = 0.3;
/**
 * A contact reached by an approximate name match is drawn this opaque. Known limit: opacity is the
 * only cue in the drawing itself, and it is overridden while anything is selected (the other
 * contacts are dimmed to `DIM_ALPHA`, a selected one is drawn in full), so the cue is gone then.
 * The text cues stay at all times: the row's tag, the status line's "approximate name match" and
 * the "[approximate name match]" in titles. No shipped rule joins by the close tier, so nothing is
 * affected today; the first close rule must add a cue that is not opacity (a ring or a marker in
 * the renderer and the 2D views, which this card could not touch).
 */
export const APPROXIMATE_ALPHA = 0.55;
// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** One plain sentence per `GeometryReason`; the toggle's title, the stage and the tests read these. */
export const GEOMETRY_SENTENCES: Record<GeometryReason, string> = {
  no_electrodes_file:
    "This recording has no electrodes file, so its contact positions are not known.",
  no_coordinates: "The electrodes file lists no usable x, y and z positions.",
  all_zero: "Every position in the electrodes file is 0, 0, 0, so none can be drawn.",
  unreadable: "The electrodes file could not be read.",
  no_coordsystem: "The electrodes file has no coordinate system file beside it.",
  ambiguous:
    "More than one electrodes file applies to this recording and nothing says which one to use.",
  listing_failed: "The dataset's file list could not be read.",
};

/** Reasons that may be a passing failure of the data plane rather than a property of the data. */
export const TRANSIENT_REASONS: readonly GeometryReason[] = ["unreadable", "listing_failed"];

function isTransient(reason: GeometryReason | null): boolean {
  return reason !== null && TRANSIENT_REASONS.includes(reason);
}

export const WEBGL_SENTENCE = "3D view needs WebGL2";
/**
 * Under the units banner the contacts lie too far out for the 3D spheres (true-size millimeters,
 * with no minimum on-screen size) to be seen, so the stage is the three flat views, which size
 * their dots in pixels; the switch says so instead of offering a 3D view that would draw nothing.
 */
export const BANNER_VIEW_SENTENCE =
  "3D view is off while the units banner shows; the three flat views draw every contact as declared";
const VIEW_SWITCH_TITLE = "Show the contacts in three flat views (left, top, front) instead of 3D";
export const LOADING_SENTENCE = "Looking for electrode positions...";
export const NO_MATCH_SENTENCE =
  "None of this recording's channels match a contact in the electrodes file.";

/** What can stop an activity read: IS-M1's refusals, the panel's own mixed-units check, a failed read. */
export type ActivityFailure = ActivityRefusal | "mixed_units" | "read_failed";

/** User-facing sentence per activity refusal; `rateHz` is the group's level-0 rate. */
export const ACTIVITY_SENTENCES: Record<ActivityFailure, (rateHz: number) => string> = {
  band_above_nyquist: (rate) =>
    `This band reaches above ${BAND_NYQUIST_FRACTION} times the sampling rate (${formatPlain(BAND_NYQUIST_FRACTION * rate)} Hz), so it cannot be measured here. Pick a lower band.`,
  window_too_short: (rate) =>
    `The window is too short for this measure; show at least ${formatPlain(minWindowSamples(rate) / rate)} s.`,
  not_level0: () =>
    "Activity needs full-rate samples, and this window is a zoomed-out summary. Zoom in.",
  bad_input: () => "Activity cannot be computed for this recording's channel units.",
  mixed_units: () =>
    "Activity cannot be computed: this recording's channels mix voltage and field units.",
  read_failed: () =>
    "The signal could not be read. Change the window, or turn Activity off and on, to try again.",
};

const NULL_REASON_SENTENCES: Record<ChannelNullReason, string> = {
  non_finite: "no value: a sample was not a number",
  band_above_nyquist: "no value: this channel's own sampling rate is too low for the band",
  undefined_value: "no value: the result is undefined",
};

function formatPlain(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Three significant digits, exponent form for very large or small values, unit appended. */
export function formatActivityValue(value: number, unit: string): string {
  const mag = Math.abs(value);
  const text =
    value === 0 ? "0" : mag >= 1000 || mag < 0.01 ? value.toExponential(2) : value.toPrecision(3);
  return `${text} ${unit}`;
}

const BAND_NAMES: Record<BandName, string> = {
  delta: "Delta",
  theta: "Theta",
  alpha: "Alpha",
  beta: "Beta",
  low_gamma: "Low gamma",
  high_gamma: "High gamma",
};

export type ActivityChoice = "rms" | "line_length" | "band_power" | "band_power_db";

export const ACTIVITY_CHOICES: readonly { value: ActivityChoice; label: string }[] = [
  { value: "rms", label: "RMS (mean removed)" },
  { value: "line_length", label: "Line length" },
  { value: "band_power", label: "Band power" },
  { value: "band_power_db", label: "Band power, relative (dB)" },
];

function choiceRequest(choice: ActivityChoice): { metric: ActivityMetric; relative: boolean } {
  switch (choice) {
    case "rms":
      return { metric: ACTIVITY_METRICS[0], relative: false };
    case "line_length":
      return { metric: ACTIVITY_METRICS[1], relative: false };
    case "band_power":
      return { metric: ACTIVITY_METRICS[2], relative: false };
    case "band_power_db":
      return { metric: ACTIVITY_METRICS[2], relative: true };
  }
}

// ---------------------------------------------------------------------------
// Frames, units, warnings
// ---------------------------------------------------------------------------

/** The frame as the status line names it: the identifier IS-C1 resolved, or what the file wrote. */
export function frameName(frame: Frame | null): string {
  if (frame === null) return "not read";
  switch (frame.kind) {
    case "template":
      return frame.identifier;
    case "native":
    case "described":
    case "pixels":
      return frame.declared;
    case "unknown":
      switch (frame.why) {
        case "space_mismatch":
          return `${frame.declared} (the file name says ${frame.spaceEntity})`;
        case "unrecognized_label":
          return `${frame.declared} (not a standard identifier)`;
        default:
          return "not declared";
      }
  }
}

/** One sentence on units. Millimeters are claimed only when IS-C1 scaled to millimeters. */
export function unitsSentence(units: Units): string {
  if (units.unit === "mm") {
    return units.scaleToMm === 1
      ? "Units: millimeters."
      : `Units: millimeters (the file says ${units.declared}, scaled to millimeters).`;
  }
  if (units.unit === "pixels") return "Units: pixels, as written.";
  const said =
    units.declared === null || units.declared === "n/a"
      ? "not declared"
      : `"${units.declared}" is not a length unit this view converts`;
  return `Units: ${said}; values are shown as written, with no scale claim.`;
}

export function spaceLabel(space: SpaceGeometry): string {
  return space.space ?? (space.frame ? frameName(space.frame) : "no space in the file name");
}

export type PositionWarning = { kind: "origin"; count: number } | { kind: "span"; mm: number };

/**
 * Warnings about drawn positions, never corrections. Contacts at exactly 0 0 0 are suspect
 * (real files place unlocated contacts there); a spread wider than `SPAN_WARNING_MM` is checked
 * only when the units are millimeters, since no other unit carries a scale claim.
 */
export function positionWarnings(
  contacts: readonly { position: Vec3 }[],
  units: Units,
): PositionWarning[] {
  const out: PositionWarning[] = [];
  const origin = contacts.filter((c) => c.position.every((v) => v === 0)).length;
  if (origin > 0) out.push({ kind: "origin", count: origin });
  if (units.unit === "mm" && contacts.length > 0) {
    let widest = 0;
    for (let axis = 0; axis < 3; axis++) {
      const values = contacts.map((c) => c.position[axis]);
      widest = Math.max(widest, Math.max(...values) - Math.min(...values));
    }
    if (widest > SPAN_WARNING_MM) out.push({ kind: "span", mm: widest });
  }
  return out;
}

/**
 * Channels without a position, grouped by the cause `joinChannels` gave, each by its own name as
 * the recording gave it. At most six names each. A name that fits two contacts says which; a
 * channel that lost its contact to another says whose it is. The words of each cause are
 * `name-refusal.ts`'s, which a recording closed by its names also uses.
 */
export function unlocatedNotes(joins: readonly ChannelJoin[]): string[] {
  const byCause = new Map<UnlocatedCause, string[]>();
  for (const join of joins) {
    if (join.cause === null) continue;
    const list = byCause.get(join.cause);
    if (list) list.push(unlocatedChannelName(join));
    else byCause.set(join.cause, [unlocatedChannelName(join)]);
  }
  const heads = new Map(unlocatedCauseHeads(joins).map((h) => [h.cause, h.head]));
  return [...byCause].map(([cause, labels]) => {
    const shown = labels.slice(0, 6).join(", ");
    const more = labels.length > 6 ? ` and ${labels.length - 6} more` : "";
    return `${heads.get(cause)}: ${shown}${more}.`;
  });
}

/** The non-exact tiers, in order, the ones a join can carry. */
const LOOSE_KINDS = MATCH_KINDS.filter((k): k is Exclude<MatchKind, "exact"> => k !== "exact");

/** How many channels reached their contact by each non-exact tier, strictest first. */
export function matchCounts(joins: readonly ChannelJoin[]): { kind: MatchKind; count: number }[] {
  return LOOSE_KINDS.flatMap((kind) => {
    const count = joins.filter((j) => j.status !== "unlocated" && j.matchKind === kind).length;
    return count > 0 ? [{ kind, count }] : [];
  });
}

/**
 * One note per rule chain that joined channels by a name rule: how many, what the rule read, and
 * up to three real pairs (the recording's channel name, then the contact's), so a reader sees both
 * names. Said for exact joins never: two identical names need no note.
 */
export function matchNotes(joins: readonly ChannelJoin[]): string[] {
  const groups = new Map<string, { kind: MatchKind; joins: ChannelJoin[] }>();
  for (const j of joins) {
    if (j.status === "unlocated" || j.matchKind === null || j.matchKind === "exact") continue;
    const key = `${j.matchKind}:${j.rule ?? ""}`;
    const group = groups.get(key);
    if (group) group.joins.push(j);
    else groups.set(key, { kind: j.matchKind, joins: [j] });
  }
  return [...groups.values()].map(({ kind, joins: js }) => {
    const rule = js[0].rule ?? "";
    const sentence = ruleSentences(rule).join("; and ");
    const examples = js
      .slice(0, 3)
      .map((j) => `${j.channel} for ${j.contacts.join(" and ")}`)
      .join(", ");
    const more = js.length > 3 ? `, and ${js.length - 3} more` : "";
    const bipolar = js.some((j) => j.status === "bipolar")
      ? " (bipolar pairs read at their midpoint)"
      : "";
    return `${js.length} channel${js.length === 1 ? "" : "s"} joined to contacts by ${matchTag(kind)}${bipolar}: ${sentence}. For example ${examples}${more}.`;
  });
}

function warningSentence(w: PositionWarning): string {
  if (w.kind === "origin") {
    return `${w.count} drawn contact${w.count === 1 ? " sits" : "s sit"} at 0, 0, 0 exactly, as written; treat ${w.count === 1 ? "it" : "them"} as suspect.`;
  }
  return `The drawn contacts span ${Math.round(w.mm)} mm, wider than a head; the units may be wrong.`;
}

// ---------------------------------------------------------------------------
// Placement: which contacts the recording's channels use
// ---------------------------------------------------------------------------

export interface RecordingRef {
  datasetId: string;
  version: string;
  /** Dataset-relative path of the recording, as the viewer opens it. */
  path: string;
}

/** What the panel needs to know about the viewer's current channel group. */
export interface GroupInfo {
  /** Index in the store's group list. */
  index: number;
  modality: string;
  /** Channel labels in array-row order (`GroupHandle.channelsByRow`). */
  labels: readonly string[];
  /** The stored unit of each channel, in the same order. */
  units: readonly string[];
  /** Level-0 sampling rate. */
  rateHz: number;
  /** The channel's original acquisition rate when the store records one. */
  nativeRateHz: number | null;
  durationS: number;
}

export interface PlacedContact {
  name: string;
  position: Vec3;
  /** The file's own cells for the position and size, verbatim (`recordedLocation`). */
  raw: RawCells;
  size: number | null;
  /** Channel rows (indices into the group's labels) that use this contact. */
  channels: number[];
  /** True when some channel reached it by the `close` tier: drawn as an approximate name match. */
  approximate: boolean;
}

export interface Placement {
  spaceIndex: number;
  space: SpaceGeometry;
  joins: ChannelJoin[];
  /** Located contacts used by at least one channel, in the order their first channel appears. */
  contacts: PlacedContact[];
  /** Per channel row: indices into `contacts` (one for a single contact, two for bipolar, none when unlocated). */
  channelContacts: number[][];
  /** Channels with a position (single or bipolar). */
  located: number;
}

/**
 * Join the group's channels to the contacts of one space. Only contacts some channel uses are
 * placed: a contact the recording does not carry has no trace and no activity. Uses
 * `joinChannels` and nothing of its own.
 */
export function placeContacts(
  space: SpaceGeometry,
  spaceIndex: number,
  labels: readonly string[],
  rules: RuleTable = MATCH_RULES,
): Placement {
  const joins = joinChannels(space, labels, rules);
  const byName = new Map(space.contacts.map((c) => [c.name, c]));
  const slot = new Map<string, number>();
  const contacts: PlacedContact[] = [];
  const channelContacts: number[][] = [];
  let located = 0;
  joins.forEach((join, row) => {
    const mine: number[] = [];
    if (join.status !== "unlocated") {
      located += 1;
      for (const name of join.contacts) {
        const contact = byName.get(name);
        if (!contact?.position) continue;
        let i = slot.get(name);
        if (i === undefined) {
          i = contacts.length;
          slot.set(name, i);
          contacts.push({
            name,
            position: contact.position,
            raw: contact.raw,
            size: contact.size,
            channels: [],
            approximate: false,
          });
        }
        contacts[i].channels.push(row);
        if (join.matchKind === "close") contacts[i].approximate = true;
        mine.push(i);
      }
    }
    channelContacts.push(mine);
  });
  return { spaceIndex, space, joins, contacts, channelContacts, located };
}

/**
 * The space shown first: the first shown template space, else the first shown space; when none
 * can be shown, the first space (its refusal is what the stage says). The frame selector is
 * always offered when there is more than one, and the status line names the frame in use.
 */
export function defaultSpaceIndex(geometry: RecordingGeometry): number | null {
  const shown = geometry.spaces.flatMap((s, i) => (s.reason === null ? [i] : []));
  const template = shown.find((i) => geometry.spaces[i].frame?.kind === "template");
  return template ?? shown[0] ?? (geometry.spaces.length > 0 ? 0 : null);
}

/** Wait `ms`, or until `signal` aborts, whichever is first; the timer is cleared on abort. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** True when a failure in this result may be the data plane's and not the dataset's. */
export function needsAnotherTry(geometry: RecordingGeometry): boolean {
  return isTransient(geometry.reason) || geometry.spaces.some((s) => isTransient(s.reason));
}

/**
 * Resolve the contacts, trying again after each pause in `delaysMs` while the result is a failure
 * that may pass (`unreadable`, `listing_failed`). A refusal that is a property of the data (no
 * file, no coordinates, all zero, ambiguous) is final after one try, and an aborted `signal` ends
 * the tries. Returns the last result, which still says so if every try failed.
 */
export async function resolveWithRetries(
  attempt: () => Promise<RecordingGeometry>,
  options: {
    delaysMs?: readonly number[];
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<RecordingGeometry> {
  const { delaysMs = RETRY_DELAYS_MS, signal, sleep = abortableSleep } = options;
  let geometry = await attempt();
  for (const delay of delaysMs) {
    if (!needsAnotherTry(geometry) || signal?.aborted) break;
    await sleep(delay, signal);
    if (signal?.aborted) break;
    geometry = await attempt();
  }
  return geometry;
}

function placementFor(
  geometry: RecordingGeometry,
  spaceIndex: number | null,
  group: GroupInfo | null,
): Placement | null {
  if (spaceIndex === null || group === null) return null;
  const space = geometry.spaces[spaceIndex];
  if (!space || space.reason !== null) return null;
  return placeContacts(space, spaceIndex, group.labels);
}

// ---------------------------------------------------------------------------
// Activity planning
// ---------------------------------------------------------------------------

/** Samples one read holds: `rows` channels times the window's samples at `rateHz`. */
export function activitySamples(
  rows: number,
  startS: number,
  endS: number,
  rateHz: number,
): number {
  const perChannel = Math.max(1, Math.ceil(endS * rateHz) - Math.floor(startS * rateHz));
  return rows * perChannel;
}

/** How many located channels one slice holds: at most `maxRows`, and at most `cap` samples, never fewer than one. */
export function sliceRowCount(
  perChannelSamples: number,
  maxRows: number = READ_SLICE_CHANNELS,
  cap: number = SLICE_SAMPLE_CAP,
): number {
  return Math.max(1, Math.min(maxRows, Math.floor(cap / Math.max(1, perChannelSamples))));
}

/** One read of the store: rows `[start, end)`, of which `rows` are the located ones to compute. */
export interface ReadSpan {
  start: number;
  end: number;
  rows: number[];
}

/**
 * The reads that fetch a plan's located rows: one span from the first row to the last, so each
 * chunk of the store is fetched once for the window (a chunk holds many channels, and a read per
 * slice fetched the same chunks again for every slice). A span is cut before the row that would
 * take it past `maxSamples` (rows times `perChannelSamples`), never inside a row, which also keeps
 * the rows read between located ones from outgrowing the bound. `rows` is sorted and distinct.
 */
export function readSpans(
  rows: readonly number[],
  perChannelSamples: number,
  maxSamples: number,
): ReadSpan[] {
  const spans: ReadSpan[] = [];
  for (const row of rows) {
    const last = spans[spans.length - 1];
    if (last && (row + 1 - last.start) * perChannelSamples <= maxSamples) {
      last.end = row + 1;
      last.rows.push(row);
    } else {
      spans.push({ start: row, end: row + 1, rows: [row] });
    }
  }
  return spans;
}

export interface ActivityPlan {
  token: number;
  groupIndex: number;
  startS: number;
  endS: number;
  rateHz: number;
  metric: ActivityMetric;
  band: BandName | null;
  relative: boolean;
  /** Channel rows to read, ascending, distinct, all located. */
  rows: number[];
}

function locatedRows(placement: Placement): number[] {
  const rows: number[] = [];
  placement.channelContacts.forEach((contacts, row) => {
    if (contacts.length > 0) rows.push(row);
  });
  return rows;
}

function earlyRefusal(
  metric: ActivityMetric,
  band: BandName,
  rateHz: number,
  samplesPerChannel: number,
): ActivityRefusal | null {
  if (metric === "band_power") {
    if (BANDS[band][1] > BAND_NYQUIST_FRACTION * rateHz) return "band_above_nyquist";
    if (samplesPerChannel < minWindowSamples(rateHz)) return "window_too_short";
    return null;
  }
  return samplesPerChannel < 2 ? "window_too_short" : null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface WindowSpan {
  startS: number;
  lengthS: number;
}

export interface Selection {
  /** Channel row, or null. */
  channel: number | null;
  /** Indices into `Placement.contacts`: none, one, or two for a bipolar channel. */
  contacts: number[];
}

/** What the DOM half reports after reading and computing a window. */
export interface ActivityReport {
  token: number;
  metric: ActivityMetric;
  band: BandName | null;
  relative: boolean;
  unit: string;
  windowS: number;
  analyzedS: number;
  segments: number | null;
  segmentSamples: number | null;
  referenceHz: [number, number] | null;
  /** Indexed by channel row; null for a row that was not computed. */
  channels: (ChannelActivity | null)[];
}

/** The values the contacts are colored by. */
export interface ActivityShown {
  report: ActivityReport;
  /** Per placed contact: the mean of its channels' finite values, or null. */
  contactValues: (number | null)[];
  /** Per placed contact with no value: why. */
  contactReasons: (ChannelNullReason | null)[];
  scale: ActivityScale;
}

export type ActivityStatus =
  | { kind: "off" }
  | { kind: "waiting" }
  | { kind: "too_wide"; samples: number }
  | { kind: "refused"; reason: ActivityFailure }
  | { kind: "computing" }
  | { kind: "ready" };

export interface ActivityState {
  on: boolean;
  choice: ActivityChoice;
  band: BandName;
  /** Bumped by every plan; a report or failure carrying another token is stale. */
  token: number;
  status: ActivityStatus;
  /** The values on screen. Kept while the next window computes, dropped on any other change. */
  shown: ActivityShown | null;
}

export type GeometryStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; geometry: RecordingGeometry };

/**
 * The template surface: `idle` until a registered frame is shown with the panel open, `loading`
 * while it is fetched, `ready` once the DOM half holds it, `failed` after a failed fetch (a
 * reopened panel, a frame change or a recording change tries again).
 */
export type TemplateStatus = "idle" | "loading" | "ready" | "failed";

export interface PanelState {
  recording: RecordingRef | null;
  group: GroupInfo | null;
  geometry: GeometryStatus;
  /** Bumped by every resolution; a result carrying another token is stale. */
  geometryToken: number;
  spaceIndex: number | null;
  placement: Placement | null;
  open: boolean;
  webgl: boolean;
  /** The reader asked for the three 2D views instead of the 3D canvas (IS-V3). */
  view2d: boolean;
  selection: Selection;
  window: WindowSpan | null;
  activity: ActivityState;
  template: TemplateStatus;
  /** The template outlines of the 2D views and the SVG (IS-V3): the same states, for `views.json`. */
  outlines: TemplateStatus;
  disposed: boolean;
}

const NO_SELECTION: Selection = { channel: null, contacts: [] };

function idleActivity(from?: ActivityState): ActivityState {
  return {
    on: false,
    choice: from?.choice ?? "band_power",
    band: from?.band ?? "high_gamma",
    token: (from?.token ?? 0) + 1,
    status: { kind: "off" },
    shown: null,
  };
}

export function initialState(): PanelState {
  return {
    recording: null,
    group: null,
    geometry: { kind: "idle" },
    geometryToken: 0,
    spaceIndex: null,
    placement: null,
    open: false,
    webgl: true,
    view2d: false,
    selection: NO_SELECTION,
    window: null,
    activity: idleActivity(),
    template: "idle",
    outlines: "idle",
    disposed: false,
  };
}

export type PanelEvent =
  | { type: "recording_changed"; recording: RecordingRef; group: GroupInfo }
  | { type: "group_changed"; group: GroupInfo }
  | { type: "geometry_resolved"; token: number; geometry: RecordingGeometry }
  | { type: "retry" }
  | { type: "toggle_open"; open?: boolean }
  | { type: "webgl_unavailable" }
  | { type: "view_changed"; view2d: boolean }
  | { type: "frame_changed"; spaceIndex: number }
  | { type: "select_contact"; contact: number | null; toggle?: boolean }
  | { type: "select_channel"; label: string | null }
  | { type: "activity_switch"; on: boolean }
  | { type: "activity_options"; choice?: ActivityChoice; band?: BandName }
  | { type: "window_changed"; startS: number; lengthS: number }
  | { type: "activity_report"; report: ActivityReport }
  | { type: "activity_failed"; token: number; reason: ActivityFailure }
  /** The DOM half holds the decoded surface. */
  | { type: "template_loaded" }
  | { type: "template_failed" }
  /** The DOM half holds the parsed outlines of `views.json` (IS-V3). */
  | { type: "outlines_loaded" }
  | { type: "outlines_failed" }
  | { type: "disposed" };

export type PanelEffect =
  | { type: "resolve_geometry"; token: number; recording: RecordingRef }
  | { type: "abort_geometry" }
  | { type: "read_activity"; plan: ActivityPlan }
  | { type: "abort_activity" }
  /** Fetch the template surface, once a canvas exists to draw it on. Never emitted for another frame. */
  | { type: "load_template" }
  /** Fetch the template outlines of the 2D views, once, for a registered frame with the panel open (IS-V3). */
  | { type: "load_outlines" }
  /** Highlight this channel's trace in the scope; null clears the highlight. */
  | { type: "select_trace"; label: string | null };

export interface Transition {
  state: PanelState;
  effects: PanelEffect[];
}

const same = (state: PanelState): Transition => ({ state, effects: [] });

function traceLabel(state: PanelState, selection: Selection): string | null {
  return selection.channel === null ? null : (state.group?.labels[selection.channel] ?? null);
}

/** Plan activity for the state: what the status is, and the read to start when there is one. */
function planActivity(
  state: PanelState,
  token: number,
): { status: ActivityStatus; read?: ActivityPlan } {
  const a = state.activity;
  if (!a.on) return { status: { kind: "off" } };
  const { group, placement, window } = state;
  if (!state.open || !group || !placement || placement.located === 0 || !window) {
    return { status: { kind: "waiting" } };
  }
  const startS = Math.max(0, Math.min(window.startS, group.durationS));
  const endS = Math.max(startS, Math.min(group.durationS, window.startS + window.lengthS));
  const rows = locatedRows(placement);
  const samples = activitySamples(rows.length, startS, endS, group.rateHz);
  if (samples > MAX_ACTIVITY_SAMPLES) return { status: { kind: "too_wide", samples } };
  const { metric, relative } = choiceRequest(a.choice);
  const perChannel = activitySamples(1, startS, endS, group.rateHz);
  const refusal = earlyRefusal(metric, a.band, group.rateHz, perChannel);
  if (refusal) return { status: { kind: "refused", reason: refusal } };
  return {
    status: { kind: "computing" },
    read: {
      token,
      groupIndex: group.index,
      startS,
      endS,
      rateHz: group.rateHz,
      metric,
      band: metric === "band_power" ? a.band : null,
      relative,
      rows,
    },
  };
}

/**
 * Re-plan activity after anything that changes what it would read. Any read in flight is
 * aborted first; `keepShown` keeps the values on screen while the next window computes (a window
 * move), and every other change drops them.
 */
function replan(state: PanelState, keepShown: boolean): Transition {
  const token = state.activity.token + 1;
  const plan = planActivity(state, token);
  const shown = keepShown && plan.status.kind === "computing" ? state.activity.shown : null;
  const effects: PanelEffect[] = [{ type: "abort_activity" }];
  if (plan.read) effects.push({ type: "read_activity", plan: plan.read });
  return {
    state: { ...state, activity: { ...state.activity, token, status: plan.status, shown } },
    effects,
  };
}

function contactValuesOf(
  report: ActivityReport,
  placement: Placement,
): { values: (number | null)[]; reasons: (ChannelNullReason | null)[] } {
  const values: (number | null)[] = [];
  const reasons: (ChannelNullReason | null)[] = [];
  for (const contact of placement.contacts) {
    const own = contact.channels.map((row) => report.channels[row] ?? null);
    const finite = own.flatMap((c) => (c && c.value !== null ? [c.value] : []));
    values.push(finite.length > 0 ? finite.reduce((s, v) => s + v, 0) / finite.length : null);
    reasons.push(finite.length > 0 ? null : (own.find((c) => c?.reason)?.reason ?? null));
  }
  return { values, reasons };
}

function selectChannelRow(state: PanelState, row: number): Transition {
  const contacts = state.placement?.channelContacts[row] ?? [];
  const selection: Selection = { channel: row, contacts: [...contacts] };
  const next = { ...state, selection };
  return { state: next, effects: [{ type: "select_trace", label: traceLabel(next, selection) }] };
}

function clearSelection(state: PanelState): Transition {
  return {
    state: { ...state, selection: NO_SELECTION },
    effects: [{ type: "select_trace", label: null }],
  };
}

function reduceCore(state: PanelState, event: PanelEvent): Transition {
  if (state.disposed) return same(state);
  switch (event.type) {
    case "recording_changed": {
      const geometryToken = state.geometryToken + 1;
      const next: PanelState = {
        ...initialState(),
        recording: event.recording,
        group: event.group,
        geometry: { kind: "loading" },
        geometryToken,
        webgl: state.webgl,
        view2d: state.view2d,
        template: state.template,
        outlines: state.outlines,
        activity: idleActivity(state.activity),
      };
      return {
        state: next,
        effects: [
          { type: "abort_activity" },
          { type: "abort_geometry" },
          { type: "select_trace", label: null },
          { type: "resolve_geometry", token: geometryToken, recording: event.recording },
        ],
      };
    }

    case "group_changed": {
      const placement =
        state.geometry.kind === "ready"
          ? placementFor(state.geometry.geometry, state.spaceIndex, event.group)
          : null;
      const next: PanelState = {
        ...state,
        group: event.group,
        placement,
        // The Brain toggle is hidden for a group that is not iEEG, so nothing could close it.
        open: state.open && isIeegModality(event.group.modality),
        selection: NO_SELECTION,
        // The next render reports the new group's window; nothing is read before it does.
        window: null,
      };
      const replanned = replan(next, false);
      return {
        state: replanned.state,
        effects: [...replanned.effects, { type: "select_trace", label: null }],
      };
    }

    case "geometry_resolved": {
      if (state.geometry.kind !== "loading" || event.token !== state.geometryToken) {
        return same(state);
      }
      const spaceIndex = defaultSpaceIndex(event.geometry);
      const next: PanelState = {
        ...state,
        geometry: { kind: "ready", geometry: event.geometry },
        spaceIndex,
        placement: placementFor(event.geometry, spaceIndex, state.group),
        selection: NO_SELECTION,
      };
      return replan(next, false);
    }

    case "retry": {
      if (!state.recording) return same(state);
      const geometryToken = state.geometryToken + 1;
      const replanned = replan(
        {
          ...state,
          geometry: { kind: "loading" },
          geometryToken,
          spaceIndex: null,
          placement: null,
          selection: NO_SELECTION,
        },
        false,
      );
      return {
        state: replanned.state,
        effects: [
          ...replanned.effects,
          { type: "abort_geometry" },
          { type: "select_trace", label: null },
          { type: "resolve_geometry", token: geometryToken, recording: state.recording },
        ],
      };
    }

    case "toggle_open": {
      const open = event.open ?? !state.open;
      if (open === state.open) return same(state);
      const next = { ...state, open, selection: open ? state.selection : NO_SELECTION };
      const replanned = replan(next, false);
      return {
        state: replanned.state,
        effects: open
          ? replanned.effects
          : [...replanned.effects, { type: "select_trace", label: null }],
      };
    }

    case "webgl_unavailable":
      return { state: { ...state, webgl: false }, effects: [] };

    case "view_changed":
      return event.view2d === state.view2d
        ? same(state)
        : { state: { ...state, view2d: event.view2d }, effects: [] };

    case "frame_changed": {
      if (state.geometry.kind !== "ready" || !state.geometry.geometry.spaces[event.spaceIndex]) {
        return same(state);
      }
      const next: PanelState = {
        ...state,
        spaceIndex: event.spaceIndex,
        placement: placementFor(state.geometry.geometry, event.spaceIndex, state.group),
        selection: NO_SELECTION,
      };
      const replanned = replan(next, false);
      return {
        state: replanned.state,
        effects: [...replanned.effects, { type: "select_trace", label: null }],
      };
    }

    case "select_contact": {
      const placement = state.placement;
      const contact = event.contact === null ? undefined : placement?.contacts[event.contact];
      if (event.contact === null || !contact) return clearSelection(state);
      // A contact belongs to one channel, or to several in a bipolar chain: take the first.
      const row = contact.channels[0];
      if (row === undefined) return clearSelection(state);
      const already =
        state.selection.channel === row && state.selection.contacts.includes(event.contact);
      if (already && event.toggle !== false) return clearSelection(state);
      return selectChannelRow(state, row);
    }

    case "select_channel": {
      const row = event.label === null ? -1 : (state.group?.labels.indexOf(event.label) ?? -1);
      if (row < 0 || state.selection.channel === row) return clearSelection(state);
      return selectChannelRow(state, row);
    }

    case "activity_switch": {
      if (event.on === state.activity.on) return same(state);
      return replan({ ...state, activity: { ...state.activity, on: event.on } }, false);
    }

    case "activity_options": {
      const a = state.activity;
      const choice = event.choice ?? a.choice;
      const band = event.band ?? a.band;
      if (choice === a.choice && band === a.band) return same(state);
      return replan({ ...state, activity: { ...a, choice, band } }, false);
    }

    case "window_changed": {
      const w = state.window;
      if (w && w.startS === event.startS && w.lengthS === event.lengthS) return same(state);
      const next = { ...state, window: { startS: event.startS, lengthS: event.lengthS } };
      if (!next.activity.on || !next.open) return same(next);
      return replan(next, true);
    }

    case "activity_report": {
      const a = state.activity;
      const placement = state.placement;
      if (event.report.token !== a.token || a.status.kind !== "computing" || !placement) {
        return same(state);
      }
      const { values, reasons } = contactValuesOf(event.report, placement);
      const shown: ActivityShown = {
        report: event.report,
        contactValues: values,
        contactReasons: reasons,
        scale: buildScale(values, "sequential", event.report.unit),
      };
      return {
        state: { ...state, activity: { ...a, status: { kind: "ready" }, shown } },
        effects: [],
      };
    }

    case "activity_failed": {
      const a = state.activity;
      if (event.token !== a.token || a.status.kind !== "computing") return same(state);
      return {
        state: {
          ...state,
          activity: { ...a, status: { kind: "refused", reason: event.reason }, shown: null },
        },
        effects: [],
      };
    }

    case "template_loaded":
    case "template_failed":
    case "outlines_loaded":
    case "outlines_failed":
      // Decided by `reduce`, which owns the template's status.
      return same(state);

    case "disposed":
      return {
        state: { ...state, disposed: true },
        effects: [
          { type: "abort_activity" },
          { type: "abort_geometry" },
          { type: "select_trace", label: null },
        ],
      };
  }
}

// ---------------------------------------------------------------------------
// The template surface (card IS-V2)
// ---------------------------------------------------------------------------

/**
 * The banner of the shown space (`units-banner.ts`): the declared unit converted, and every drawn
 * contact then more than 300 mm from the origin. Null when nothing is placed or the units are fine.
 * Never changes a position: it reads the contacts as IS-C1 gave them.
 */
export function bannerOf(placement: Placement | null): UnitsBanner | null {
  return placement
    ? unitsBanner(
        placement.space.units,
        placement.contacts.map((c) => c.position),
      )
    : null;
}

/**
 * The row that places the shown space on the template surface, or null: the frame decides alone,
 * except under the units banner, whose sentence says the positions are placed on no template, so
 * no row is offered and neither the surface nor the outlines are asked for.
 */
export function templateRuleOf(state: PanelState): TemplatePlacementRule | null {
  const placement = state.placement;
  if (!placement || bannerOf(placement)) return null;
  return placementRuleFor(placement.space.frame, placement.space.units);
}

/**
 * The surface is wanted only while the panel is open on a registered frame and the stage is a
 * canvas (contacts to draw, within the limit, WebGL2 present). No other frame ever wants it.
 */
function wantsTemplate(state: PanelState): boolean {
  return (
    state.open &&
    templateRuleOf(state) !== null &&
    stageModel(state, DEFAULT_LIMITS).kind === "canvas"
  );
}

/** The row the surface is drawn under right now: a registered frame whose surface has arrived. */
export function drawnTemplate(state: PanelState): TemplatePlacementRule | null {
  return state.template === "ready" ? templateRuleOf(state) : null;
}

/**
 * The outlines of `views.json` are wanted only while the panel is open on a registered frame and
 * contacts are drawn (3D, 2D or without WebGL2: the SVG export is always the 2D views). No other
 * frame, no EEG recording and no closed panel ever asks for them.
 */
function wantsOutlines(state: PanelState): boolean {
  if (!state.open || templateRuleOf(state) === null) return false;
  const kind = stageModel(state, DEFAULT_LIMITS).kind;
  return kind === "canvas" || kind === "views2d" || kind === "no_webgl";
}

/**
 * The row under which the stage draws a template right now: the surface (3D) or the outlines (the
 * 2D views) must have arrived. Null while loading, after a failure, and for every frame without a
 * row, which are drawn as declared.
 */
export function placedRule(state: PanelState, stage: StageModel): TemplatePlacementRule | null {
  const status = stage.kind === "canvas" ? state.template : state.outlines;
  const drawn = stage.kind === "canvas" || stage.kind === "views2d" || stage.kind === "no_webgl";
  return drawn && status === "ready" ? templateRuleOf(state) : null;
}

/**
 * The positions of the placed contacts as drawn, in the order of `Placement.contacts` (which is
 * the renderer's contact order): through the row's affine while the surface is drawn, as declared
 * otherwise. Nothing is snapped or projected onto the surface.
 */
export function drawnPositions(state: PanelState): Vec3[] | null {
  const placement = state.placement;
  if (!placement) return null;
  const rule = drawnTemplate(state);
  return placement.contacts.map((c) => (rule ? placeOnTemplate(rule, c.position) : c.position));
}

/**
 * Own the template's status around the rest of the machine: record the fetch's outcome, start the
 * fetch when (and only when) a registered frame is shown with the panel open, forget a failure
 * when the reader reopens the panel or changes frame or recording, and forget a request that
 * WebGL2's absence made pointless.
 */
export function reduce(state: PanelState, event: PanelEvent): Transition {
  if (state.disposed) return same(state);
  if (event.type === "template_loaded" || event.type === "template_failed") {
    if (state.template !== "loading") return same(state);
    return same({ ...state, template: event.type === "template_loaded" ? "ready" : "failed" });
  }
  if (event.type === "outlines_loaded" || event.type === "outlines_failed") {
    if (state.outlines !== "loading") return same(state);
    return same({ ...state, outlines: event.type === "outlines_loaded" ? "ready" : "failed" });
  }
  const t = reduceCore(state, event);
  let next = t.state;
  const retries =
    event.type === "frame_changed" ||
    event.type === "recording_changed" ||
    (event.type === "toggle_open" && next.open);
  if (next.template === "failed" && retries) next = { ...next, template: "idle" };
  if (next.outlines === "failed" && retries) next = { ...next, outlines: "idle" };
  if (next.template === "loading" && event.type === "webgl_unavailable") {
    next = { ...next, template: "idle" };
  }
  let effects = t.effects;
  if (next.template === "idle" && wantsTemplate(next)) {
    next = { ...next, template: "loading" };
    effects = [...effects, { type: "load_template" }];
  }
  if (next.outlines === "idle" && wantsOutlines(next)) {
    next = { ...next, outlines: "loading" };
    effects = [...effects, { type: "load_outlines" }];
  }
  return next === t.state && effects === t.effects ? t : { state: next, effects };
}

// ---------------------------------------------------------------------------
// The model the DOM half paints
// ---------------------------------------------------------------------------

export interface ToggleModel {
  /** False for a group that is not iEEG: the button is not shown at all. */
  visible: boolean;
  enabled: boolean;
  pressed: boolean;
  title: string;
}

export type StageModel =
  | { kind: "loading"; sentence: string }
  | { kind: "canvas" }
  /** The three 2D views, chosen by the reader. */
  | { kind: "views2d" }
  /** The three 2D views, because WebGL2 is missing; the sentence says so. */
  | { kind: "no_webgl"; sentence: string }
  | { kind: "refusal"; sentence: string; retry: boolean };

export interface FrameSelectorModel {
  selected: number;
  options: { index: number; label: string; refused: boolean }[];
}

export interface ActivityModel {
  on: boolean;
  choice: ActivityChoice;
  choices: { value: ActivityChoice; label: string }[];
  band: BandName;
  bands: { value: BandName; label: string; disabled: boolean }[];
  showBand: boolean;
  /** Which measure and band the values are (the selectors' own words); null while Activity is off. */
  measure: string | null;
  /** A plain sentence for the current status, or null. */
  message: string | null;
  busy: boolean;
  /** How the shown values were computed. */
  summary: string | null;
  colorbar: { css: string; lo: string; hi: string; degenerate: boolean } | null;
  /** Said when some drawn contact has no value. */
  noData: string | null;
}

export interface ContactRow {
  index: number;
  /** The contact's name exactly as the electrodes file records it. */
  name: string;
  /**
   * The recording's own channel name(s) beside it, in parentheses, when a name differs from the
   * contact's or did not join by the file's own name; empty when both names are the same.
   */
  detail: string;
  /** The small tag beside `detail`: the kinds of match that are not exact, or empty. */
  tag: string;
  /** What the tag means, in the words of the rules, for its tooltip; empty with no tag. */
  tagTitle: string;
  selected: boolean;
  /** Every channel that uses the contact, by name. */
  channels: string[];
  /** The same channels with how each name reached the contact (`channelClause`, `contactTitle`). */
  links: ChannelRef[];
  /** Where the dataset recorded it, with its unit word and frame (`recordedLocation`). */
  recorded: string;
  /** Where the template drawing puts it, once drawn and only then (`templateLocation`); else null. */
  template: string | null;
  /** The activity value or why there is none; null when the overlay shows nothing. */
  value: string | null;
}

/** The "2D views" switch and the save buttons, shown only while contacts are drawn. */
export interface ViewSwitchModel {
  /** Contacts are drawn, so the switch and the save buttons are shown. */
  shown: boolean;
  /** The 2D views are what the stage draws, by choice or because WebGL2 is missing. */
  on: boolean;
  /** False when WebGL2 is missing or the units banner shows: the flat views are the only view. */
  enabled: boolean;
  title: string;
  /**
   * Why the 3D view is not offered under the units banner, for a visible line beside the switch (a
   * disabled button has no focus and its title is a tooltip); the same words as the title. Null
   * otherwise, including without WebGL2, whose sentence the stage already says.
   */
  reason: string | null;
}

/**
 * The template surface under the canvas. `ready` is the only state in which the surface is drawn,
 * and it always carries the label (and "approximate" wherever a transform or another MNI variant
 * is involved), the template's reference and the link to its notice. Null for a frame with no
 * template placement, which says so in `notes` instead.
 */
export type TemplateModel =
  | { status: "loading"; sentence: string }
  | { status: "failed"; sentence: string }
  | {
      status: "ready";
      label: string;
      approximate: boolean;
      reference: { text: string; href: string };
      license: { text: string; href: string };
      /** The notice as one sentence ("Template surface: ...; ...."): the words of the links beside it. */
      notice: string;
    };

export interface PanelModel {
  toggle: ToggleModel;
  open: boolean;
  stage: StageModel;
  view: ViewSwitchModel;
  template: TemplateModel | null;
  frames: FrameSelectorModel | null;
  /** `N of M channels located; frame: IDENTIFIER; positions as declared by the dataset`. */
  status: string | null;
  notes: string[];
  /** The selected channel in terms of its contacts (`channelProvenance`), or null. */
  selectedChannel: string | null;
  /**
   * The units banner (`units-banner.ts`), said on the stage and in every figure, or null. Present
   * only while contacts are drawn.
   */
  banner: string | null;
  /**
   * The flat views' scale in words, under the banner (`units-banner.ts`): they have no scale bar,
   * so this says their extent; null whenever there is no banner.
   */
  scale: string | null;
  /**
   * Both sets of names, when the recording is closed by its channel names (the refusal stage
   * lists them); null for every other state.
   */
  nameRefusal: NameRefusal | null;
  activity: ActivityModel | null;
  contacts: ContactRow[];
  /** Present in every state: the link the panel mounts, as plain data. */
  credit: CreditLinkSpec;
}

export interface ModelLimits {
  maxContacts: number;
}

const DEFAULT_LIMITS: ModelLimits = { maxContacts: MAX_CONTACTS };

const TOGGLE_ENABLED_TITLE = "Brain: where the contacts are, in the frame the dataset declares";
/** A recording closed by its channel names opens, to compare the two sets of names. */
const NAMES_TOGGLE_TITLE =
  "Brain: no channel name joins a contact; open to compare the two lists of names";

/**
 * The placement of a recording closed by its channel names: a shown space, channels, none located,
 * and none unlocated for want of a position (that is a missing-coordinates refusal, which stays
 * disabled). Null for every other state.
 */
function closedByNamingPlacement(state: PanelState): Placement | null {
  const placement = state.placement;
  if (!placement || state.geometry.kind !== "ready" || placement.contacts.length > 0) return null;
  return closedByNaming(placement.joins, placement.located) ? placement : null;
}

function refusedSpaceSentences(geometry: RecordingGeometry): string {
  const distinct = new Set(geometry.spaces.map((s) => s.reason));
  if (geometry.spaces.length <= 1 || distinct.size === 1) {
    return GEOMETRY_SENTENCES[
      geometry.spaces[0]?.reason ?? geometry.reason ?? "no_electrodes_file"
    ];
  }
  return geometry.spaces
    .map((s) => `${spaceLabel(s)}: ${GEOMETRY_SENTENCES[s.reason ?? "no_coordinates"]}`)
    .join(" ");
}

function toggleModel(state: PanelState): ToggleModel {
  const visible = !!state.group && isIeegModality(state.group.modality);
  const pressed = state.open;
  const off = (title: string): ToggleModel => ({ visible, enabled: false, pressed, title });
  if (state.geometry.kind !== "ready") {
    return off("Brain: checking this dataset for electrode positions");
  }
  const geometry = state.geometry.geometry;
  if (state.placement && state.placement.contacts.length > 0) {
    return { visible, enabled: true, pressed, title: TOGGLE_ENABLED_TITLE };
  }
  if (isTransient(geometry.reason) || geometry.spaces.some((s) => isTransient(s.reason))) {
    return {
      visible,
      enabled: true,
      pressed,
      title: "Brain: the electrode positions could not be loaded; open to retry",
    };
  }
  if (closedByNamingPlacement(state)) {
    return { visible, enabled: true, pressed, title: NAMES_TOGGLE_TITLE };
  }
  if (geometry.spaces.some((s) => s.reason === null)) {
    return off(`Brain view unavailable: ${NO_MATCH_SENTENCE}`);
  }
  return off(`Brain view unavailable: ${refusedSpaceSentences(geometry)}`);
}

function stageModel(state: PanelState, limits: ModelLimits): StageModel {
  if (state.geometry.kind !== "ready") return { kind: "loading", sentence: LOADING_SENTENCE };
  const space = state.geometry.geometry.spaces[state.spaceIndex ?? 0];
  if (!space) {
    const reason = state.geometry.geometry.reason ?? "no_electrodes_file";
    return { kind: "refusal", sentence: GEOMETRY_SENTENCES[reason], retry: isTransient(reason) };
  }
  if (space.reason !== null) {
    return {
      kind: "refusal",
      sentence: GEOMETRY_SENTENCES[space.reason],
      retry: isTransient(space.reason),
    };
  }
  const placement = state.placement;
  if (!placement || placement.contacts.length === 0) {
    return { kind: "refusal", sentence: NO_MATCH_SENTENCE, retry: false };
  }
  if (placement.contacts.length > limits.maxContacts) {
    return {
      kind: "refusal",
      sentence: `This recording uses ${placement.contacts.length} located contacts; the 3D view draws at most ${limits.maxContacts}.`,
      retry: false,
    };
  }
  if (!state.webgl) return { kind: "no_webgl", sentence: WEBGL_SENTENCE };
  if (state.view2d || bannerOf(placement)) return { kind: "views2d" };
  return { kind: "canvas" };
}

function statusLine(state: PanelState): string | null {
  const { placement, group } = state;
  if (!placement || !group) return null;
  const base = `${placement.located} of ${group.labels.length} channels located; frame: ${frameName(placement.space.frame)}; positions as declared by the dataset`;
  // A join by a name rule is said here as well as in the notes: how many by which kind of match.
  const counts = matchCounts(placement.joins);
  if (counts.length === 0) return base;
  return `${base}; joined by name rules: ${counts.map((c) => `${c.count} ${matchTag(c.kind)}`).join(", ")}`;
}

/** What the notice under a drawn template says, in plain words; the live box links its two parts. */
export const TEMPLATE_NOTICE_PREFIX = "Template surface: ";
export const TEMPLATE_LICENSE_TEXT = "MNI copyright notice";
export function templateNotice(): string {
  return `${TEMPLATE_NOTICE_PREFIX}${TEMPLATE_REFERENCE.text}; ${TEMPLATE_LICENSE_TEXT}.`;
}

function templateModel(state: PanelState, stage: StageModel): TemplateModel | null {
  // The 3D canvas waits on the surface; the 2D views (chosen, or for want of WebGL2) on the outlines.
  if (stage.kind !== "canvas" && stage.kind !== "views2d" && stage.kind !== "no_webgl") return null;
  const rule = templateRuleOf(state);
  if (!rule) return null;
  const status = stage.kind === "canvas" ? state.template : state.outlines;
  if (status === "failed") {
    return { status: "failed", sentence: TEMPLATE_FAILED_SENTENCE };
  }
  if (status !== "ready") {
    return { status: "loading", sentence: TEMPLATE_LOADING_SENTENCE };
  }
  return {
    status: "ready",
    label: templateLabel(rule),
    approximate: rule.approximation !== null,
    reference: { text: TEMPLATE_REFERENCE.text, href: TEMPLATE_REFERENCE.href },
    license: { text: TEMPLATE_LICENSE_TEXT, href: TEMPLATE_LICENSE_HREF },
    notice: templateNotice(),
  };
}

function frameNotes(placement: Placement): string[] {
  const { space } = placement;
  const notes: string[] = [];
  const frame = space.frame;
  if (frame?.kind === "described") {
    notes.push(
      frame.description === null
        ? "The dataset gives no description of this frame."
        : `The dataset describes this frame as: ${frame.description}`,
    );
  }
  if (frame?.kind === "template" && frame.caseNormalized) {
    notes.push(`The file writes the identifier as "${frame.declared}".`);
  }
  if (frame?.kind === "unknown" && frame.why === "no_coordsystem") {
    notes.push("No coordinate system file pairs with these positions.");
  }
  if (placementRuleFor(frame, space.units) === null) notes.push(noPlacementSentence(frame));
  notes.push(unitsSentence(space.units));
  notes.push(...matchNotes(placement.joins));
  notes.push(...unlocatedNotes(placement.joins));
  for (const w of positionWarnings(placement.contacts, space.units)) {
    notes.push(warningSentence(w));
  }
  return notes;
}

function frameSelector(state: PanelState): FrameSelectorModel | null {
  if (state.geometry.kind !== "ready") return null;
  const spaces = state.geometry.geometry.spaces;
  if (spaces.length < 2) return null;
  return {
    selected: state.spaceIndex ?? 0,
    options: spaces.map((s, index) => ({
      index,
      label: s.reason === null ? spaceLabel(s) : `${spaceLabel(s)} (unavailable)`,
      refused: s.reason !== null,
    })),
  };
}

function activitySummary(shown: ActivityShown): string {
  const r = shown.report;
  if (r.metric === "rms")
    return `RMS of the window with its mean removed, ${formatPlain(r.windowS)} s.`;
  if (r.metric === "line_length")
    return `Mean absolute change per second, ${formatPlain(r.windowS)} s.`;
  const parts = [
    `Welch's method: ${r.segments} segment${r.segments === 1 ? "" : "s"} of ${r.segmentSamples} samples over ${formatPlain(r.analyzedS)} s of a ${formatPlain(r.windowS)} s window`,
  ];
  if (r.segments !== null && r.segments < 6) parts.push("few segments, so values are noisy");
  if (r.referenceHz) {
    parts.push(
      `decibels against the channel's own power from ${r.referenceHz[0]} to ${formatPlain(r.referenceHz[1])} Hz`,
    );
  }
  return `${parts.join("; ")}.`;
}

/** "Band power, relative (dB): High gamma, 70 to 150 Hz": the selectors' words, in one place. */
function measureSentence(a: ActivityState): string {
  const choice = ACTIVITY_CHOICES.find((c) => c.value === a.choice)?.label ?? a.choice;
  if (a.choice !== "band_power" && a.choice !== "band_power_db") return choice;
  return `${choice}: ${bandLabel(a.band)}`;
}

function bandLabel(band: BandName): string {
  return `${BAND_NAMES[band]}, ${BANDS[band][0]} to ${BANDS[band][1]} Hz`;
}

function activityModel(state: PanelState): ActivityModel | null {
  const { placement, group } = state;
  if (!placement || !group) return null;
  const a = state.activity;
  const status = a.status;
  const shown = a.shown;
  let message: string | null = null;
  if (status.kind === "too_wide") {
    message = `Zoom in to compute activity: this window holds ${status.samples.toLocaleString("en-US")} samples across the located channels, and the limit is ${MAX_ACTIVITY_SAMPLES.toLocaleString("en-US")}.`;
  } else if (status.kind === "refused") {
    message = ACTIVITY_SENTENCES[status.reason](group.rateHz);
  } else if (status.kind === "computing") {
    message = shown ? "Updating for the new window..." : "Computing...";
  }
  const hasNull = shown?.contactValues.some((v) => v === null) ?? false;
  return {
    on: a.on,
    choice: a.choice,
    choices: ACTIVITY_CHOICES.map((c) => ({ ...c })),
    band: a.band,
    bands: (Object.keys(BANDS) as BandName[]).map((value) => ({
      value,
      label: bandLabel(value),
      disabled: BANDS[value][1] > BAND_NYQUIST_FRACTION * group.rateHz,
    })),
    showBand: a.choice === "band_power" || a.choice === "band_power_db",
    measure: a.on ? measureSentence(a) : null,
    message,
    busy: status.kind === "computing",
    summary: shown ? activitySummary(shown) : null,
    colorbar: shown
      ? {
          css: shown.scale.css,
          lo: formatActivityValue(shown.scale.lo, shown.report.unit),
          hi: formatActivityValue(shown.scale.hi, shown.report.unit),
          degenerate: shown.scale.degenerate,
        }
      : null,
    noData: hasNull ? "Gray contacts have no value; the list says why." : null,
  };
}

function contactRows(state: PanelState, stage: StageModel): ContactRow[] {
  const { placement, group } = state;
  if (!placement || !group) return [];
  const selected = new Set(state.selection.contacts);
  const shown = state.activity.shown;
  const frameLabel = frameName(placement.space.frame);
  const rule = placedRule(state, stage);
  return placement.contacts.map((contact, index) => {
    const links: ChannelRef[] = contact.channels.map((row) => ({
      name: group.labels[row],
      kind: placement.joins[row].matchKind ?? "exact",
    }));
    // Beside the name: the channels that are not simply the contact's own name.
    const beside = links.filter((l) => l.name !== contact.name || l.kind !== "exact");
    const tags = [...new Set(beside.flatMap((l) => matchTag(l.kind) ?? []))];
    const rules = [
      ...new Set(
        contact.channels.flatMap((row) =>
          placement.joins[row].matchKind === "exact"
            ? []
            : ruleSentences(placement.joins[row].rule ?? ""),
        ),
      ),
    ];
    let value: string | null = null;
    if (shown) {
      const v = shown.contactValues[index];
      const reason = shown.contactReasons[index];
      value =
        v !== null && v !== undefined
          ? formatActivityValue(v, shown.report.unit)
          : reason
            ? NULL_REASON_SENTENCES[reason]
            : "no value";
    }
    return {
      index,
      name: contact.name,
      detail: beside.length > 0 ? `(${channelClause(beside, false)})` : "",
      tag: tags.join(", "),
      tagTitle: rules.length > 0 ? `${rules.join("; ")}.` : "",
      selected: selected.has(index),
      channels: contact.channels.map((row) => group.labels[row]),
      links,
      recorded: recordedLocation(contact.raw, placement.space.units, frameLabel),
      template: rule
        ? templateLocation(placeOnTemplate(rule, contact.position), rule.approximation !== null)
        : null,
      value,
    };
  });
}

/** The selected channel, said by what it was joined to; null when none is selected or its name is its contact's own. */
function selectedChannelSentence(state: PanelState): string | null {
  const row = state.selection.channel;
  const join = row === null ? undefined : state.placement?.joins[row];
  return join ? channelProvenance(join) : null;
}

/** Both sets of names, only on the refusal stage of a recording closed by its channel names. */
function namesFor(state: PanelState, stage: StageModel): NameRefusal | null {
  const placement = stage.kind === "refusal" ? closedByNamingPlacement(state) : null;
  return placement
    ? nameRefusal(
        placement.joins,
        placement.space.contacts.map((c) => c.name),
      )
    : null;
}

/** Everything the DOM half draws, from the state alone. The credit is in every model. */
export function viewModel(state: PanelState, limits: ModelLimits = DEFAULT_LIMITS): PanelModel {
  const stage = stageModel(state, limits);
  const drawn = stage.kind === "canvas" || stage.kind === "views2d" || stage.kind === "no_webgl";
  const placement = drawn ? state.placement : null;
  const banner = bannerOf(placement);
  return {
    toggle: toggleModel(state),
    open: state.open,
    stage,
    view: {
      shown: drawn,
      on: stage.kind === "views2d" || stage.kind === "no_webgl",
      enabled: state.webgl && !banner,
      title: !state.webgl ? WEBGL_SENTENCE : banner ? BANNER_VIEW_SENTENCE : VIEW_SWITCH_TITLE,
      reason: state.webgl && banner ? BANNER_VIEW_SENTENCE : null,
    },
    template: templateModel(state, stage),
    frames: frameSelector(state),
    status: placement ? statusLine(state) : null,
    notes: placement ? frameNotes(placement) : [],
    selectedChannel: placement ? selectedChannelSentence(state) : null,
    banner: banner?.text ?? null,
    scale: banner?.scale ?? null,
    nameRefusal: namesFor(state, stage),
    activity: placement ? activityModel(state) : null,
    contacts: placement ? contactRows(state, stage) : [],
    credit: creditLinkSpec(),
  };
}

export type Rgb01 = readonly [number, number, number];

export interface ColorPalette {
  /** A contact with no color of its own (`--brand-electrode`). */
  neutral: Rgb01;
  /** A contact the overlay has no value for. */
  noData: Rgb01;
}

/**
 * Four values in 0..1 per drawn contact for `BrainRenderer.setColors`: the neutral color while
 * the overlay shows nothing, the scale's color for a value, the no-data color for none. While a
 * selection exists the other contacts are translucent, so every selected contact (both of a
 * bipolar pair) stands out. Null when nothing is drawn.
 */
export function contactColors(state: PanelState, palette: ColorPalette): Float32Array | null {
  const placement = state.placement;
  if (!placement) return null;
  const shown = state.activity.on ? state.activity.shown : null;
  const selected = new Set(state.selection.contacts);
  const out = new Float32Array(placement.contacts.length * 4);
  for (let i = 0; i < placement.contacts.length; i++) {
    let rgb: Rgb01 = palette.neutral;
    if (shown) {
      const c = colorFor(shown.scale, shown.contactValues[i] ?? null);
      rgb = c ? [c[0] / 255, c[1] / 255, c[2] / 255] : palette.noData;
    }
    out.set(rgb, i * 4);
    // A contact some channel reached by an approximate name match is drawn half transparent, so
    // it is told apart from an exact one. Not while anything is selected: the others are dimmed to
    // `DIM_ALPHA` and the selected one is drawn in full (see `APPROXIMATE_ALPHA`'s limit).
    out[i * 4 + 3] =
      selected.size > 0 && !selected.has(i)
        ? DIM_ALPHA
        : placement.contacts[i].approximate && !selected.has(i)
          ? APPROXIMATE_ALPHA
          : 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seam for IS-V2 (template anatomy)
// ---------------------------------------------------------------------------

/**
 * The seam between the template (IS-V2) and the 2D views and exports (IS-V3). A registered
 * template placement, with the outlines of `views.json` in hand, is the template's outlines, the
 * contact positions through the same row's affine as the 3D view, and the same words as the 3D
 * view says (`templateLabel`, `templateNotice`); the notice's addresses ride along for the SVG's
 * metadata. Null for every other state (a frame with no row, pending or unsupported, units not
 * converted, outlines still loading or failed), which draws the contacts as declared with no
 * outline and no template sentence.
 */
export function templatePlacementFor(
  state: PanelState,
  outlines: TemplateOutlines | null,
): TemplatePlacement | null {
  const rule = templateRuleOf(state);
  const placement = state.placement;
  if (!rule || !placement || !outlines || state.outlines !== "ready") return null;
  return {
    outlines,
    positions: placement.contacts.map((c) => placeOnTemplate(rule, c.position)),
    approximate: rule.approximation !== null,
    labels: [templateLabel(rule), templateNotice()],
    references: [TEMPLATE_REFERENCE.href, TEMPLATE_LICENSE_HREF],
  };
}

// ---------------------------------------------------------------------------
// DOM half
// ---------------------------------------------------------------------------

/** What the viewer gives the panel, and nothing else. */
export interface SpatialPanelHost {
  recording: RecordingRef;
  /** The panel's box, in the DOM and hidden; the panel fills it and shows it when opened. */
  box: HTMLElement;
  /** An element whose computed style carries the theme tokens. */
  themeRoot: HTMLElement;
  /** The viewer's current channel group. */
  group(): GroupInfo;
  /** Level-0 samples of one group, rows `[r0, r1)`, for `[startS, endS)`. */
  readRows(
    groupIndex: number,
    startS: number,
    endS: number,
    r0: number,
    r1: number,
    signal: AbortSignal,
  ): Promise<WindowData>;
  /** The toggle button: show it or not, enable it, press it, title it. */
  setToggle(toggle: ToggleModel): void;
  /** Move focus to the toggle button (after Escape closes the panel). */
  focusToggle(): void;
  /** Highlight a channel's trace in the scope; null clears it. */
  showTrace(label: string | null): void;
  /** The panel opened or closed, so the scope's width changes. */
  layoutChanged(): void;
}

export interface SpatialPanel {
  /** Begin resolving the dataset's electrode files. Called once, after the first frame. */
  start(): void;
  toggle(): void;
  isOpen(): boolean;
  setGroup(group: GroupInfo): void;
  setWindow(startS: number, lengthS: number): void;
  /** The viewer's trace click: select (or, on a second click, deselect) a channel by label. */
  selectChannel(label: string): void;
  /** Re-read the theme tokens after a light or dark switch. */
  refreshTheme(): void;
  dispose(): void;
}

function tokens(root: HTMLElement): { theme: BrainTheme; noData: string; border: string } {
  const cs = getComputedStyle(root);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    theme: {
      background: v("--color-bg", "#ffffff"),
      outline: v("--color-fg", "#0f172a"),
      mesh: v("--color-fg-muted", "#475569"),
      contact: v("--brand-electrode", "#f5b82e"),
    },
    noData: v("--color-fg-subtle", "#64748b"),
    border: v("--color-border", "#e2e8f0"),
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Set text only when it changed, so a live region is not announced again for the same words. */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function failedGeometry(recording: RecordingRef, reason: GeometryReason): RecordingGeometry {
  return {
    datasetId: recording.datasetId,
    version: recording.version,
    recording: recording.path,
    spaces: [],
    reason,
  };
}

/** One macrotask, so a long loop of slices gives the page a turn between them. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export type PlanOutcome =
  | { ok: true; report: ActivityReport }
  | { ok: false; reason: ActivityFailure };

/**
 * Read and compute one plan. The located rows are read once for the window (`readSpans`; `readRows`
 * returns the level-0 window of rows `[r0, r1)`), so no chunk of the store is fetched twice, and
 * then computed in slices of at most `sliceChannels` channels and `sliceSamples` samples, yielding
 * to the page after the read and after every slice, so decoding and computing never share a task
 * and no slice is a long one. Returns null when `signal` aborted, a failure word when IS-M1 refuses
 * a slice or the slices disagree about the unit (voltage in one, field in another: one color scale
 * cannot span them), and otherwise one report whose summary fields come from the first slice (the
 * rate and window are the same for all). A rejected `readRows` rejects this.
 */
export async function computeActivityPlan(
  plan: ActivityPlan,
  group: Pick<GroupInfo, "labels" | "units" | "nativeRateHz">,
  readRows: (r0: number, r1: number) => Promise<WindowData>,
  options: {
    signal?: AbortSignal;
    sliceChannels?: number;
    sliceSamples?: number;
    /** The most samples one call of `readRows` may ask for. */
    readSamples?: number;
    yieldTask?: () => Promise<void>;
  } = {},
): Promise<PlanOutcome | null> {
  const {
    signal,
    sliceChannels = READ_SLICE_CHANNELS,
    sliceSamples = SLICE_SAMPLE_CAP,
    readSamples = MAX_ACTIVITY_SAMPLES,
    yieldTask = nextTask,
  } = options;
  const perRow: (ChannelActivity | null)[] = new Array(group.labels.length).fill(null);
  let first: ActivityResult | null = null;
  let firstUnit: "V" | "T" | null = null;
  const perChannel = activitySamples(1, plan.startS, plan.endS, plan.rateHz);
  const sliceSize = sliceRowCount(perChannel, sliceChannels, sliceSamples);
  for (const span of readSpans(plan.rows, perChannel, readSamples)) {
    if (signal?.aborted) return null;
    const win = await readRows(span.start, span.end);
    if (signal?.aborted) return null;
    // The read's decoding is done; compute in a task of its own.
    await yieldTask();
    for (let i = 0; i < span.rows.length; i += sliceSize) {
      if (signal?.aborted) return null;
      const rows = span.rows.slice(i, i + sliceSize);
      const slice: WindowData = {
        level: win.level,
        nCols: win.nCols,
        channels: rows.map((row) => win.channels[row - span.start]),
      };
      const info = rows.map((row) => ({
        label: group.labels[row],
        unit: group.units[row],
        nativeRateHz: group.nativeRateHz ?? undefined,
      }));
      const adapted = activityChannelsFromWindow(slice, info);
      if (!adapted.ok) return { ok: false, reason: adapted.reason };
      firstUnit ??= adapted.unit;
      if (adapted.unit !== firstUnit) return { ok: false, reason: "mixed_units" };
      const outcome = computeActivity({
        channels: adapted.channels,
        rateHz: plan.rateHz,
        unit: adapted.unit,
        metric: plan.metric,
        band: plan.band ?? undefined,
        relative: plan.relative,
        displayUnit: adapted.unit === "V" ? "µV" : undefined,
      });
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      outcome.channels.forEach((c, k) => {
        perRow[rows[k]] = c;
      });
      first ??= outcome;
      await yieldTask();
    }
  }
  if (signal?.aborted || !first) return null;
  return {
    ok: true,
    report: {
      token: plan.token,
      metric: first.metric,
      band: first.band,
      relative: first.relative,
      unit: first.unit,
      windowS: first.windowS,
      analyzedS: first.analyzedS,
      segments: first.segments,
      segmentSamples: first.segmentSamples,
      referenceHz: first.referenceHz,
      channels: perRow,
    },
  };
}

/**
 * The decoded surface, shared by every panel of the page: the same two small files for any
 * dataset, so a second panel (or a reopened one) never fetches them again. A failure is not kept,
 * so the next ask tries again. Never aborted: the promise is shared, so aborting it for one panel
 * would fail the load of every other panel waiting on it; a panel that closes mid-fetch leaves the
 * download to finish into the browser cache.
 */
let surfaceLoad: Promise<BrainMesh> | null = null;
function templateSurface(): Promise<BrainMesh> {
  surfaceLoad ??= loadTemplateSurface(fetchBytesSameOrigin).catch((err) => {
    surfaceLoad = null;
    throw err;
  });
  return surfaceLoad;
}

/** Read the template's outlines file from the same origin. */
async function readOutlinesFile(): Promise<unknown> {
  const res = await fetch(`${TEMPLATE_DIRECTORY}views.json`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`views.json answered ${res.status}`);
  return res.json();
}

/**
 * The template's outlines (`views.json`), shared by every panel of the page and read at most once:
 * a second panel, or a reopened one, gets the same promise. A failure is not kept, so the next ask
 * tries again. `read` is the file's reader (the page's fetch by default).
 */
let outlinesLoad: Promise<TemplateOutlines> | null = null;
export function templateOutlines(
  read: () => Promise<unknown> = readOutlinesFile,
): Promise<TemplateOutlines> {
  outlinesLoad ??= read()
    .then(parseViewOutlines)
    .catch((err) => {
      outlinesLoad = null;
      throw err;
    });
  return outlinesLoad;
}

/** Forget the shared outlines, so a test can start from a page that has not read them. */
export function forgetTemplateOutlines(): void {
  outlinesLoad = null;
}

/** Gives each panel's ids their own numbers (a page may hold more than one panel). */
let panelSeq = 0;

export function createSpatialPanel(host: SpatialPanelHost): SpatialPanel {
  const { box } = host;
  let state = initialState();
  let disposed = false;
  let started = false;
  let reads = 0;

  let geometryCtl: AbortController | null = null;
  let geometryTimer = 0;
  let activityCtl: AbortController | null = null;
  let activityTimer = 0;

  let renderer: BrainRenderer | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let drawnPlacement: Placement | null = null;
  /** The row the contacts were last drawn under (null: as declared) and the mesh last handed over. */
  let drawnRule: TemplatePlacementRule | null = null;
  let drawnMesh: BrainMesh | null = null;
  /** The surface, once the shared fetch has delivered it to this panel. */
  let templateMesh: BrainMesh | null = null;
  /** A `load_template` effect waits for a renderer: no WebGL2, no fetch. */
  let templateRequested = false;
  /** The parsed outlines, once `load_outlines` has finished. */
  let outlinesData: TemplateOutlines | null = null;
  let palette: ColorPalette = { neutral: [0.96, 0.72, 0.18], noData: [0.4, 0.45, 0.5] };
  let theme: BrainTheme = {
    background: "#ffffff",
    outline: "#0f172a",
    mesh: "#475569",
    contact: "#f5b82e",
  };
  let figureTheme: FigureTheme = {
    background: "#ffffff",
    foreground: "#0f172a",
    muted: "#475569",
    border: "#e2e8f0",
    contact: "#f5b82e",
  };
  let savingMessage = "";

  // --- DOM ---------------------------------------------------------------
  box.replaceChildren();
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", "Electrode positions");
  box.dataset.spatialPanel = "";
  const inner = el("div", "eegv__spatial-inner");
  const frameWrap = el("label", "eegv__field eegv__spatial-frame");
  const frameSel = el("select", "eegv__sel");
  frameSel.dataset.spatialFrame = "";
  frameWrap.append(document.createTextNode("Frame "), frameSel);
  frameWrap.hidden = true;

  const stage = el("div", "eegv__spatial-stage");
  stage.dataset.spatialStage = "";
  const stageMsg = el("p", "eegv__spatial-msg");
  stageMsg.setAttribute("role", "status");
  const retry = el("button", "eegv__btn eegv__spatial-retry", "Retry");
  retry.type = "button";
  retry.hidden = true;
  const msgWrap = el("div", "eegv__spatial-msgwrap");
  msgWrap.append(stageMsg, retry);
  // The three 2D views (IS-V3), in the stage with the sentence and the credit.
  const views = el("div", "eegv__spatial-views");
  views.dataset.spatialViews = "";
  views.hidden = true;
  // The credit is created here, on every mount, and nothing passes an option to leave it out.
  const credit = creditLink(document);
  // The units banner (IS-Q2): a visible warning over the top of the drawing, for a dataset whose
  // declared unit disagrees with its numbers. Hidden unless the model carries one.
  const banner = el("div", "eegv__spatial-banner");
  banner.setAttribute("role", "note");
  banner.dataset.spatialBanner = "";
  banner.hidden = true;
  // The flat views have no scale bar: under the banner this line says their extent in words.
  const scaleLine = el("p", "eegv__spatial-scale");
  scaleLine.dataset.spatialScale = "";
  scaleLine.hidden = true;
  stage.append(banner, scaleLine, msgWrap, views, credit);

  // The names of a recording closed by its channel names (IS-Q2), under the refusal sentence.
  const nameBox = el("div", "eegv__spatial-names");
  nameBox.setAttribute("role", "group");
  nameBox.setAttribute("aria-label", "Channel names and contact names that no rule joined");
  nameBox.dataset.spatialNames = "";
  nameBox.hidden = true;

  // The "2D views" switch and the two save buttons (IS-V3), shown while contacts are drawn.
  const actions = el("div", "eegv__spatial-actions");
  const view2dBtn = el("button", "eegv__btn", "2D views");
  view2dBtn.type = "button";
  view2dBtn.dataset.spatialView2d = "";
  const savePngBtn = el("button", "eegv__btn", "Save PNG");
  savePngBtn.type = "button";
  savePngBtn.dataset.spatialSave = "png";
  const saveSvgBtn = el("button", "eegv__btn", "Save SVG");
  saveSvgBtn.type = "button";
  saveSvgBtn.dataset.spatialSave = "svg";
  actions.append(view2dBtn, savePngBtn, saveSvgBtn);
  actions.hidden = true;
  // Why the 3D view is off under the banner, in the page and not only in the button's tooltip.
  const viewReason = el("p", "eegv__spatial-actmsg");
  viewReason.dataset.spatialViewReason = "";
  viewReason.id = `eegv-view-reason-${++panelSeq}`;
  viewReason.hidden = true;
  const saveMsg = el("p", "eegv__spatial-actmsg");
  saveMsg.setAttribute("role", "status");
  saveMsg.hidden = true;
  // What the 2D views say beyond their circles: how the axes are read, and the template sentences.
  const viewNotes = el("ul", "eegv__spatial-viewnotes");
  viewNotes.dataset.spatialViewNotes = "";
  viewNotes.hidden = true;

  // The template surface's words, under the canvas: the label first, then who made the surface and
  // where its notice is. Present only while the surface is drawn (or loading, or failed).
  const templateBox = el("div", "eegv__spatial-template");
  templateBox.dataset.spatialTemplate = "";
  const templateLine = el("p", "eegv__spatial-status");
  templateLine.dataset.spatialTemplateLabel = "";
  const templateNotice = el("p", "eegv__spatial-status eegv__spatial-template-notice");
  templateNotice.dataset.spatialTemplateNotice = "";
  const referenceLink = document.createElement("a");
  referenceLink.dataset.spatialTemplateReference = "";
  const licenseLink = document.createElement("a");
  licenseLink.dataset.spatialTemplateLicense = "";
  for (const a of [referenceLink, licenseLink]) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  templateNotice.append(
    document.createTextNode(TEMPLATE_NOTICE_PREFIX),
    referenceLink,
    document.createTextNode("; "),
    licenseLink,
    document.createTextNode("."),
  );
  templateBox.append(templateLine, templateNotice);
  templateBox.hidden = true;

  const status = el("p", "eegv__spatial-status");
  status.setAttribute("aria-live", "polite");
  status.dataset.spatialStatus = "";
  // The selected channel, said by what it was joined to (a bipolar pair, a name that joined by a rule).
  const selChan = el("p", "eegv__spatial-status eegv__spatial-selchan");
  selChan.setAttribute("aria-live", "polite");
  selChan.dataset.spatialSelectedChannel = "";
  selChan.hidden = true;
  const notes = el("ul", "eegv__spatial-notes");

  const act = el("div", "eegv__spatial-activity");
  const actRow = el("div", "eegv__spatial-actrow");
  const actSwitch = document.createElement("input");
  actSwitch.type = "checkbox";
  actSwitch.dataset.spatialActivity = "";
  const actLabel = el("label", "eegv__field");
  actLabel.append(actSwitch, document.createTextNode(" Activity"));
  const metricSel = el("select", "eegv__sel");
  metricSel.setAttribute("aria-label", "Activity measure");
  for (const c of ACTIVITY_CHOICES) metricSel.append(option(c.value, c.label));
  const bandSel = el("select", "eegv__sel");
  bandSel.setAttribute("aria-label", "Frequency band");
  for (const b of Object.keys(BANDS) as BandName[]) bandSel.append(option(b, b));
  actRow.append(actLabel, metricSel, bandSel);
  const actMsg = el("p", "eegv__spatial-actmsg");
  actMsg.setAttribute("role", "status");
  const bar = el("div", "eegv__spatial-bar");
  bar.dataset.spatialColorbar = "";
  const barLo = el("span", "eegv__spatial-barend");
  const barGrad = el("div", "eegv__spatial-grad");
  const barHi = el("span", "eegv__spatial-barend");
  bar.append(barLo, barGrad, barHi);
  bar.hidden = true;
  const actSummary = el("p", "eegv__spatial-actsum");
  const actNoData = el("p", "eegv__spatial-actsum");
  act.append(actRow, actMsg, bar, actSummary, actNoData);

  const list = el("ul", "eegv__spatial-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Contacts");
  // A bipolar channel selects two contacts at once.
  list.setAttribute("aria-multiselectable", "true");
  list.dataset.spatialList = "";
  inner.append(
    frameWrap,
    stage,
    nameBox,
    actions,
    viewReason,
    saveMsg,
    templateBox,
    status,
    selChan,
    viewNotes,
    notes,
    act,
    list,
  );
  box.append(inner);

  // The panel owns its keys: arrows, letters and plus/minus must not reach the scope's shortcuts.
  // Escape closes the panel and hands focus back to the toggle that opened it.
  box.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" && state.open) {
      e.preventDefault();
      dispatch({ type: "toggle_open", open: false });
      host.focusToggle();
    }
  });

  // --- model -> DOM -------------------------------------------------------
  interface RowEls {
    li: HTMLLIElement;
    /** The recording's channel name(s) beside the contact's name, in parentheses. */
    names: HTMLElement;
    /** The small tag for a join that is not the file's own name. */
    tag: HTMLElement;
    value: HTMLElement;
    tpl: HTMLElement;
  }
  let rows: RowEls[] = [];
  let rowsFor: Placement | null = null;

  function rebuildRows(model: PanelModel): void {
    rows = model.contacts.map((c) => {
      const li = el("li", "eegv__spatial-row");
      li.setAttribute("role", "option");
      li.dataset.contact = String(c.index);
      const detail = el("span", "eegv__spatial-detail");
      const names = el("span", "eegv__spatial-chan");
      const tag = el("span", "eegv__spatial-tag");
      tag.hidden = true;
      detail.append(names, tag);
      const value = el("span", "eegv__spatial-value");
      // Where the dataset recorded the contact, under its name, in the same words as the figures.
      const loc = el("span", "eegv__spatial-loc", c.recorded);
      // The template position, a smaller line below, only while a template is drawn.
      const tpl = el("span", "eegv__spatial-loc eegv__spatial-tpl");
      tpl.hidden = true;
      li.append(el("span", "eegv__spatial-name", c.name), detail, value, loc, tpl);
      return { li, names, tag, value, tpl };
    });
    list.replaceChildren(...rows.map((r) => r.li));
  }

  function paintRows(model: PanelModel): void {
    const focusIndex = Math.max(
      0,
      model.contacts.findIndex((c) => c.selected),
    );
    model.contacts.forEach((c, i) => {
      const { li, names, tag, value, tpl } = rows[i];
      li.setAttribute("aria-selected", String(c.selected));
      li.tabIndex = i === focusIndex ? 0 : -1;
      setText(names, c.detail);
      tag.hidden = c.tag === "";
      setText(tag, c.tag);
      tag.title = c.tagTitle;
      const v = c.value ?? "";
      if (value.textContent !== v) value.textContent = v;
      tpl.hidden = c.template === null;
      setText(tpl, c.template ?? "");
    });
  }

  function ensureVisible(li: HTMLElement): void {
    if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop;
    else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight;
    }
  }

  function ensureRenderer(wantCanvas: boolean): void {
    if (!wantCanvas) {
      if (renderer) {
        renderer.dispose();
        renderer = null;
      }
      canvas?.remove();
      canvas = null;
      drawnPlacement = null;
      drawnRule = null;
      drawnMesh = null;
      return;
    }
    if (renderer) return;
    // A fresh canvas per renderer: a disposed or failed one leaves a lost context behind.
    const c = el("canvas", "eegv__spatial-canvas");
    c.setAttribute("role", "img");
    c.setAttribute(
      "aria-label",
      "3D view of the electrode contacts. The contact list below is the keyboard alternative.",
    );
    stage.prepend(c);
    const r = createBrainRenderer(c, theme);
    if (!r) {
      c.remove();
      state = reduce(state, { type: "webgl_unavailable" }).state;
      return;
    }
    canvas = c;
    renderer = r;
    drawnPlacement = null;
    drawnRule = null;
    drawnMesh = null;
    c.addEventListener("click", onCanvasClick);
  }

  function syncRenderer(): void {
    if (!renderer || !canvas) return;
    const placement = state.placement;
    renderer.resize();
    // The surface is drawn only for a registered frame whose surface has arrived, and the contacts
    // go through that frame's affine only then; `PlacedContact` index i is renderer contact i.
    const rule = drawnTemplate(state);
    const mesh = rule ? templateMesh : null;
    if (mesh !== drawnMesh) {
      renderer.setMesh(mesh);
      drawnMesh = mesh;
    }
    if (placement && (placement !== drawnPlacement || rule !== drawnRule)) {
      const positions = drawnPositions(state) ?? [];
      renderer.setContacts(
        placement.contacts.map((c, i) => ({ position: positions[i], size: c.size })),
      );
      drawnPlacement = placement;
      drawnRule = rule;
    }
    const colors = contactColors(state, palette);
    if (colors) renderer.setColors(colors);
    renderer.setSelected(
      state.selection.contacts.length === 1 ? state.selection.contacts[0] : null,
    );
  }

  function sync(): void {
    if (disposed) return;
    let model = viewModel(state);
    host.setToggle(model.toggle);
    box.hidden = !model.open;
    box.dataset.activityState = state.activity.status.kind;
    box.dataset.activityReads = String(reads);
    ensureRenderer(model.open && model.stage.kind === "canvas");
    // Creating the renderer may have found no WebGL2; the model then says so.
    model = viewModel(state);
    if (!model.open) return;

    // Frame selector
    frameWrap.hidden = model.frames === null;
    if (model.frames) {
      const want = model.frames.options.map((o) => `${o.index}|${o.label}`).join("\n");
      if (frameSel.dataset.key !== want) {
        frameSel.replaceChildren(
          ...model.frames.options.map((o) => option(String(o.index), o.label)),
        );
        frameSel.dataset.key = want;
      }
      frameSel.value = String(model.frames.selected);
    }

    // The template's words
    const tm = model.template;
    box.dataset.templateState = tm?.status ?? "none";
    templateBox.hidden = tm === null;
    if (tm) {
      setText(templateLine, tm.status === "ready" ? tm.label : tm.sentence);
      templateNotice.hidden = tm.status !== "ready";
      if (tm.status === "ready") {
        setText(referenceLink, tm.reference.text);
        referenceLink.href = tm.reference.href;
        setText(licenseLink, tm.license.text);
        licenseLink.href = tm.license.href;
      }
    }

    // Stage
    const stageKind = model.stage.kind;
    stage.dataset.stage = stageKind;
    if (model.stage.kind === "canvas" || model.stage.kind === "views2d") {
      msgWrap.hidden = true;
    } else {
      msgWrap.hidden = false;
      setText(stageMsg, model.stage.sentence);
      retry.hidden = !(model.stage.kind === "refusal" && model.stage.retry);
    }

    setText(banner, model.banner ?? "");
    banner.hidden = model.banner === null;
    setText(scaleLine, model.scale ?? "");
    scaleLine.hidden = model.scale === null;
    paintNames(model);

    paintViews(model);
    actions.hidden = !model.view.shown;
    view2dBtn.setAttribute("aria-pressed", String(model.view.on));
    view2dBtn.classList.toggle("eegv__btn--active", model.view.on);
    view2dBtn.disabled = !model.view.enabled;
    view2dBtn.title = model.view.title;
    setText(viewReason, model.view.reason ?? "");
    viewReason.hidden = model.view.reason === null || !model.view.shown;
    if (viewReason.hidden) view2dBtn.removeAttribute("aria-describedby");
    else view2dBtn.setAttribute("aria-describedby", viewReason.id);
    setText(saveMsg, savingMessage);
    saveMsg.hidden = savingMessage === "" || !model.view.shown;

    setText(status, model.status ?? "");
    status.hidden = model.status === null;
    setText(selChan, model.selectedChannel === null ? "" : `Channel ${model.selectedChannel}`);
    selChan.hidden = model.selectedChannel === null;
    const noteKey = model.notes.join("\n");
    if (notes.dataset.key !== noteKey) {
      notes.replaceChildren(...model.notes.map((n) => el("li", "eegv__spatial-note", n)));
      notes.dataset.key = noteKey;
    }

    // Activity
    const am = model.activity;
    act.hidden = am === null;
    if (am) {
      actSwitch.checked = am.on;
      metricSel.value = am.choice;
      metricSel.disabled = !am.on;
      bandSel.hidden = !am.showBand;
      bandSel.disabled = !am.on;
      if (bandSel.dataset.key !== am.bands.map((b) => `${b.label}${b.disabled}`).join("|")) {
        bandSel.replaceChildren(
          ...am.bands.map((b) => {
            const o = option(b.value, b.label);
            o.disabled = b.disabled;
            return o;
          }),
        );
        bandSel.dataset.key = am.bands.map((b) => `${b.label}${b.disabled}`).join("|");
      }
      bandSel.value = am.band;
      setText(actMsg, am.message ?? "");
      actMsg.hidden = am.message === null;
      act.setAttribute("aria-busy", String(am.busy));
      bar.hidden = am.colorbar === null;
      if (am.colorbar) {
        barGrad.style.background = `linear-gradient(to right, ${am.colorbar.css})`;
        setText(barLo, am.colorbar.lo);
        setText(barHi, am.colorbar.hi);
        bar.title = am.colorbar.degenerate
          ? "Every value is the same, so every contact has one color."
          : "";
      }
      setText(actSummary, am.summary ?? "");
      actSummary.hidden = am.summary === null;
      setText(actNoData, am.noData ?? "");
      actNoData.hidden = am.noData === null;
    }

    // Contact list
    if (rowsFor !== state.placement || rows.length !== model.contacts.length) {
      rebuildRows(model);
      rowsFor = state.placement;
    }
    paintRows(model);
    const first = state.selection.contacts[0];
    if (first !== undefined && rows[first] && !list.contains(document.activeElement)) {
      ensureVisible(rows[first].li);
    }

    syncRenderer();
    if (templateRequested && renderer) {
      templateRequested = false;
      startTemplateLoad();
    }
  }

  function startOutlinesLoad(): void {
    templateOutlines().then(
      (data) => {
        if (disposed) return;
        outlinesData = data;
        dispatch({ type: "outlines_loaded" });
      },
      (err) => {
        if (disposed) return;
        console.error("[ieeg-spatial] loading the template outlines failed:", err);
        dispatch({ type: "outlines_failed" });
      },
    );
  }

  function startTemplateLoad(): void {
    templateSurface().then(
      (mesh) => {
        if (disposed) return;
        templateMesh = mesh;
        dispatch({ type: "template_loaded" });
      },
      (err) => {
        if (disposed) return;
        console.error("[ieeg-spatial] loading the template brain failed:", err);
        dispatch({ type: "template_failed" });
      },
    );
  }

  // --- 2D views and exports (IS-V3) ---------------------------------------
  function figureInput(model: PanelModel): ExportInput {
    return {
      state,
      model,
      colors: contactColors(state, palette),
      theme: figureTheme,
      template: templatePlacementFor(state, outlinesData),
      frameLabel: frameName(state.placement?.space.frame ?? null),
    };
  }

  /** The two sets of names of a recording closed by its channel names, rebuilt only when they change. */
  function paintNames(model: PanelModel): void {
    const refusal = model.nameRefusal;
    nameBox.hidden = refusal === null;
    if (refusal === null) {
      if (nameBox.dataset.key !== undefined) nameBox.replaceChildren();
      delete nameBox.dataset.key;
      return;
    }
    const key = JSON.stringify(refusal);
    if (nameBox.dataset.key === key) return;
    nameBox.dataset.key = key;
    const column = (list: NameRefusal["channels"], attribute: string) => {
      const col = el("div", "eegv__spatial-names-col");
      col.setAttribute(`data-${attribute}`, "");
      const heading = el("p", "eegv__spatial-names-head", list.heading);
      heading.id = `eegv-${attribute}-${++panelSeq}`;
      const ul = el("ul", "eegv__spatial-names-list");
      // The list is named by its heading, for a screen reader that lands on the list itself.
      ul.setAttribute("aria-labelledby", heading.id);
      list.names.forEach((name, i) => {
        // Each name is its own bidirectional run (`dir="auto"` with CSS isolation), so a
        // right-to-left name cannot reorder its neighbors or the note after it.
        const li = el("li", "eegv__spatial-names-item", name);
        li.dir = "auto";
        const note = list.notes[i];
        if (note) {
          const tag = el("span", "eegv__spatial-names-note", ` [${note}]`);
          tag.dir = "ltr";
          li.append(tag);
        }
        ul.append(li);
      });
      col.append(heading, ul);
      return col;
    };
    const cols = el("div", "eegv__spatial-names-cols");
    cols.append(
      column(refusal.channels, "spatial-names-channels"),
      column(refusal.contacts, "spatial-names-contacts"),
    );
    nameBox.replaceChildren(
      ...refusal.causes.map((c) => el("p", "eegv__spatial-names-cause", c)),
      cols,
      el("p", "eegv__spatial-names-verdict", refusal.verdict),
    );
  }

  let viewsHtml = "";
  function paintViews(model: PanelModel): void {
    const show = model.stage.kind === "views2d" || model.stage.kind === "no_webgl";
    views.hidden = !show;
    viewNotes.hidden = !show;
    if (!show || !state.placement) {
      if (viewsHtml !== "") views.replaceChildren();
      viewsHtml = "";
      return;
    }
    const input = figureInput(model);
    const laid = layoutViews({
      contacts: viewContacts(input),
      millimeters: state.placement.space.units.unit === "mm",
      template: input.template?.outlines ?? null,
      arrangement: "grid",
      region: { x: 0, y: 0, width: VIEWS_WIDTH, height: VIEWS_HEIGHT },
    });
    // Every circle carries its own <title>, so the group is not an image: its children stay reachable.
    const html = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWS_WIDTH} ${VIEWS_HEIGHT}" role="group" aria-label="Contacts in three views. The contact list below is the keyboard alternative.">${viewsMarkup(laid, { foreground: figureTheme.foreground, muted: figureTheme.muted, border: figureTheme.border }, FIGURE_FONT)}</svg>`;
    if (html !== viewsHtml) {
      views.innerHTML = html;
      viewsHtml = html;
    }
    const sentences = figureLabels(input, true)
      .filter((l) => l.role === "axes" || l.role === "measure")
      .map((l) => l.text);
    const key = sentences.join("\n");
    if (viewNotes.dataset.key !== key) {
      viewNotes.replaceChildren(...sentences.map((n) => el("li", "eegv__spatial-note", n)));
      viewNotes.dataset.key = key;
    }
  }

  async function save(kind: "png" | "svg"): Promise<void> {
    const model = viewModel(state);
    if (!model.view.shown) return;
    savingMessage = "";
    let filename = `figure.${kind}`;
    try {
      const input = figureInput(model);
      let file: ExportFile;
      if (kind === "svg") {
        file = exportSvg(input);
      } else {
        // The 3D canvas's current frame when the live view is 3D; the three views otherwise.
        const frame = model.stage.kind === "canvas" && renderer ? renderer.snapshot() : null;
        file = await exportPng(input, frame);
      }
      filename = file.filename;
      downloadFile(file);
    } catch (err) {
      console.error(`[ieeg-spatial] saving the ${kind} failed:`, err);
      savingMessage =
        filename === `figure.${kind}`
          ? `The ${kind.toUpperCase()} could not be made. Try the other format, or the 2D views.`
          : downloadFailedSentence(filename);
    }
    sync();
  }

  // --- events -------------------------------------------------------------
  function dispatch(event: PanelEvent): void {
    if (disposed) return;
    const before = state.open;
    const t = reduce(state, event);
    state = t.state;
    for (const effect of t.effects) run(effect);
    sync();
    if (state.open !== before) host.layoutChanged();
  }

  function run(effect: PanelEffect): void {
    switch (effect.type) {
      case "resolve_geometry":
        resolve(effect.token, effect.recording);
        return;
      case "abort_geometry":
        window.clearTimeout(geometryTimer);
        geometryCtl?.abort();
        geometryCtl = null;
        return;
      case "abort_activity":
        window.clearTimeout(activityTimer);
        activityCtl?.abort();
        activityCtl = null;
        return;
      case "read_activity": {
        window.clearTimeout(activityTimer);
        activityCtl?.abort();
        const ctl = new AbortController();
        activityCtl = ctl;
        activityTimer = window.setTimeout(
          () => void readActivity(effect.plan, ctl.signal),
          ACTIVITY_DEBOUNCE_MS,
        );
        return;
      }
      case "load_outlines":
        startOutlinesLoad();
        return;
      case "load_template":
        templateRequested = true;
        return;
      case "select_trace":
        host.showTrace(effect.label);
        return;
    }
  }

  function resolve(token: number, recording: RecordingRef): void {
    window.clearTimeout(geometryTimer);
    geometryCtl?.abort();
    const ctl = new AbortController();
    geometryCtl = ctl;
    let timedOut = false;
    geometryTimer = window.setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, GEOMETRY_TIMEOUT_MS);
    resolveWithRetries(
      () =>
        resolveRecordingGeometry({
          ...recording,
          recording: recording.path,
          ...dataPlaneSource(recording.datasetId, recording.version, { signal: ctl.signal }),
        }),
      { signal: ctl.signal },
    )
      .then((geometry) => {
        window.clearTimeout(geometryTimer);
        // A superseded or disposed resolution is dropped; a timeout is a failure to retry.
        if (ctl.signal.aborted && !timedOut) return;
        dispatch({
          type: "geometry_resolved",
          token,
          geometry: timedOut ? failedGeometry(recording, "listing_failed") : geometry,
        });
      })
      .catch((err) => {
        window.clearTimeout(geometryTimer);
        if (ctl.signal.aborted && !timedOut) return;
        console.error("[ieeg-spatial] resolving contacts failed:", err);
        dispatch({
          type: "geometry_resolved",
          token,
          geometry: failedGeometry(recording, "listing_failed"),
        });
      });
  }

  async function readActivity(plan: ActivityPlan, signal: AbortSignal): Promise<void> {
    reads += 1;
    box.dataset.activityReads = String(reads);
    const group = host.group();
    if (group.index !== plan.groupIndex) return;
    try {
      const outcome = await computeActivityPlan(
        plan,
        group,
        (r0, r1) => host.readRows(plan.groupIndex, plan.startS, plan.endS, r0, r1, signal),
        { signal },
      );
      if (outcome === null || signal.aborted) return;
      dispatch(
        outcome.ok
          ? { type: "activity_report", report: outcome.report }
          : { type: "activity_failed", token: plan.token, reason: outcome.reason },
      );
    } catch (err) {
      if (signal.aborted) return;
      console.error("[ieeg-spatial] reading activity failed:", err);
      dispatch({ type: "activity_failed", token: plan.token, reason: "read_failed" });
    }
  }

  function onCanvasClick(e: MouseEvent): void {
    if (!renderer || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    const index = renderer.pick(
      e.clientX - rect.left,
      e.clientY - rect.top,
      coarse ? 14 : MIN_PICK_PX,
    );
    dispatch({ type: "select_contact", contact: index });
  }

  retry.addEventListener("click", () => dispatch({ type: "retry" }));
  view2dBtn.addEventListener("click", () => {
    if (view2dBtn.disabled) return;
    savingMessage = "";
    dispatch({ type: "view_changed", view2d: !viewModel(state).view.on });
  });
  savePngBtn.addEventListener("click", () => void save("png"));
  saveSvgBtn.addEventListener("click", () => void save("svg"));
  views.addEventListener("click", (e) => {
    const dot = (e.target as Element | null)?.closest<SVGCircleElement>("circle[data-contact]");
    if (dot) dispatch({ type: "select_contact", contact: Number(dot.dataset.contact) });
  });
  frameSel.addEventListener("change", () =>
    dispatch({ type: "frame_changed", spaceIndex: Number(frameSel.value) }),
  );
  actSwitch.addEventListener("change", () =>
    dispatch({ type: "activity_switch", on: actSwitch.checked }),
  );
  metricSel.addEventListener("change", () =>
    dispatch({ type: "activity_options", choice: metricSel.value as ActivityChoice }),
  );
  bandSel.addEventListener("change", () =>
    dispatch({ type: "activity_options", band: bandSel.value as BandName }),
  );

  function rowOf(target: EventTarget | null): number | null {
    const li = (target as HTMLElement | null)?.closest<HTMLLIElement>("li[data-contact]");
    return li ? Number(li.dataset.contact) : null;
  }
  list.addEventListener("click", (e) => {
    const index = rowOf(e.target);
    if (index !== null) dispatch({ type: "select_contact", contact: index });
  });
  list.addEventListener("keydown", (e) => {
    const current = rowOf(document.activeElement);
    if (current === null || rows.length === 0) return;
    let next: number | null = null;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, current + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      dispatch({ type: "select_contact", contact: current });
      e.preventDefault();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    dispatch({ type: "select_contact", contact: next, toggle: false });
    rows[next]?.li.focus();
  });

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => renderer?.resize());
    resizeObserver.observe(stage);
  }

  function readTheme(): void {
    const t = tokens(host.themeRoot);
    theme = t.theme;
    palette = { neutral: parseColor(t.theme.contact), noData: parseColor(t.noData) };
    figureTheme = {
      background: t.theme.background,
      foreground: t.theme.outline,
      muted: t.theme.mesh,
      border: t.border,
      contact: t.theme.contact,
    };
    renderer?.setTheme(theme);
  }
  readTheme();

  // --- handle -------------------------------------------------------------
  return {
    start() {
      if (started || disposed) return;
      started = true;
      dispatch({ type: "recording_changed", recording: host.recording, group: host.group() });
    },
    toggle() {
      if (!started) return;
      // Closing is always allowed; opening only while the toggle is enabled.
      if (!state.open && !viewModel(state).toggle.enabled) return;
      dispatch({ type: "toggle_open" });
    },
    isOpen: () => state.open,
    setGroup(group) {
      if (started) dispatch({ type: "group_changed", group });
    },
    setWindow(startS, lengthS) {
      if (started) dispatch({ type: "window_changed", startS, lengthS });
    },
    selectChannel(label) {
      if (started && state.open) dispatch({ type: "select_channel", label });
    },
    refreshTheme() {
      readTheme();
      sync();
    },
    dispose() {
      if (disposed) return;
      const t = reduce(state, { type: "disposed" });
      state = t.state;
      for (const effect of t.effects) run(effect);
      disposed = true;
      resizeObserver?.disconnect();
      ensureRenderer(false);
      box.replaceChildren();
    },
  };
}
