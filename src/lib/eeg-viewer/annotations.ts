/**
 * Annotation model for the signal viewer (website#255). Pure: no DOM, no
 * storage, no vocabulary. Everything here is data in, data out, so the BIDS
 * serialization and the overlap geometry are unit-testable without a browser.
 *
 * Two kinds, deliberately kept apart end to end (model, persistence, export)
 * because BIDS keeps them apart:
 *
 * - A `TimeAnnotation` is an *event*: something that happened at a time, with
 *   or without a duration. A click on the trace makes a zero-duration marker
 *   (a spike, an electrode pop); a drag makes a span (a seizure, a burst of
 *   artifact). Both are ordinary `events.tsv` rows -- BIDS treats duration 0
 *   as a legitimate instantaneous event, so the two need no distinction beyond
 *   the number itself.
 * - A `ChannelAnnotation` is a statement about a *channel*, with no time
 *   dimension at all: this electrode is noisy, that one is flat for the whole
 *   recording. Those are `channels.tsv` rows (`status`, `status_description`),
 *   not events, and forcing them into an events table would assert a time span
 *   nobody marked.
 *
 * Annotating a time range *on one channel* is the intersection of the two and
 * is deliberately out of scope here. Nothing below forecloses it -- a future
 * `channel` field on `TimeAnnotation` would serialize into the same events
 * table -- but v1 does not carry the field, so no reader can mistake an
 * unscoped annotation for a scoped one that lost its scope.
 */

/** A HED tag as it belongs in a file: long form, library prefix included. */
export type HedPath = string;

export interface TimeAnnotation {
  id: string;
  /** Seconds from the start of the recording. */
  onsetS: number;
  /** Seconds; 0 for a point marker. */
  durationS: number;
  /** Long-form HED paths, in the order the annotator picked them. */
  hedTags: HedPath[];
  /** Free text; exported in the `description` column. */
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelAnnotation {
  id: string;
  /** Channel label exactly as the recording spells it. */
  channel: string;
  /** BIDS `channels.tsv` status vocabulary. */
  status: "good" | "bad";
  hedTags: HedPath[];
  /** Free text; exported in the `status_description` column. */
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface AnnotationSet {
  time: TimeAnnotation[];
  channels: ChannelAnnotation[];
}

export function emptyAnnotationSet(): AnnotationSet {
  return { time: [], channels: [] };
}

export function isAnnotationSetEmpty(set: AnnotationSet): boolean {
  return set.time.length === 0 && set.channels.length === 0;
}

// --- construction ----------------------------------------------------------

/**
 * A monotonic-ish unique id. `crypto.randomUUID` where it exists (every
 * browser this ships to, and Node 19+), else a timestamp-plus-counter that is
 * unique within the session -- which is all an id needs to be here, since
 * annotations are keyed per recording and never merged across devices.
 */
let idCounter = 0;
export function newAnnotationId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  idCounter += 1;
  return `a${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * Turn two times from a drag into a non-negative onset/duration pair. A
 * backwards drag (release left of press) is the same range as a forwards one,
 * and a click -- both times equal -- is a zero-duration marker.
 */
export function normalizeRange(aS: number, bS: number): { onsetS: number; durationS: number } {
  const lo = Math.min(aS, bS);
  const hi = Math.max(aS, bS);
  const onsetS = Math.max(0, lo);
  // Clamping the low end must not stretch the span past where it was drawn,
  // so the high end is clamped to the same floor before subtracting.
  return { onsetS, durationS: Math.max(0, Math.max(hi, 0) - onsetS) };
}

export interface TimeAnnotationInput {
  onsetS: number;
  durationS: number;
  hedTags?: HedPath[];
  description?: string;
  id?: string;
  createdAt?: number;
  updatedAt?: number;
}

export function createTimeAnnotation(
  input: TimeAnnotationInput,
  now: number = Date.now(),
): TimeAnnotation {
  return {
    id: input.id ?? newAnnotationId(),
    onsetS: Math.max(0, finite(input.onsetS)),
    durationS: Math.max(0, finite(input.durationS)),
    hedTags: dedupeTags(input.hedTags ?? []),
    description: cleanText(input.description ?? ""),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

export interface ChannelAnnotationInput {
  channel: string;
  status?: "good" | "bad";
  hedTags?: HedPath[];
  description?: string;
  id?: string;
  createdAt?: number;
  updatedAt?: number;
}

export function createChannelAnnotation(
  input: ChannelAnnotationInput,
  now: number = Date.now(),
): ChannelAnnotation {
  return {
    id: input.id ?? newAnnotationId(),
    channel: input.channel.trim(),
    status: input.status ?? "bad",
    hedTags: dedupeTags(input.hedTags ?? []),
    description: cleanText(input.description ?? ""),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/** Order-preserving de-duplication; a tag picked twice is still one tag. */
function dedupeTags(tags: HedPath[]): HedPath[] {
  const seen = new Set<string>();
  const out: HedPath[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * Collapse whitespace and strip the two characters a BIDS TSV cell cannot
 * carry. BIDS TSVs have no quoting, so a tab would invent a column and a
 * newline would invent a row; both are replaced with a space at the point the
 * text enters the model rather than at serialization, so what is stored is
 * what will be written.
 */
function cleanText(text: string): string {
  return text
    .replace(/[\t\r\n]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

// --- collection operations -------------------------------------------------

/**
 * Deterministic order: onset, then the shorter span first (so a marker sorts
 * ahead of a span that starts with it), then id. Total, so the same set always
 * serializes byte-identically regardless of the order edits arrived in.
 */
export function sortTimeAnnotations(list: TimeAnnotation[]): TimeAnnotation[] {
  return [...list].sort(
    (a, b) => a.onsetS - b.onsetS || a.durationS - b.durationS || cmp(a.id, b.id),
  );
}

/** Deterministic order: channel label, then id. */
export function sortChannelAnnotations(list: ChannelAnnotation[]): ChannelAnnotation[] {
  return [...list].sort((a, b) => cmp(a.channel, b.channel) || cmp(a.id, b.id));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Insert or replace by id, returning a new sorted list. */
export function upsertTimeAnnotation(
  list: TimeAnnotation[],
  annotation: TimeAnnotation,
): TimeAnnotation[] {
  const next = list.filter((a) => a.id !== annotation.id);
  next.push(annotation);
  return sortTimeAnnotations(next);
}

export function removeTimeAnnotation(list: TimeAnnotation[], id: string): TimeAnnotation[] {
  return list.filter((a) => a.id !== id);
}

/**
 * Insert or replace by id **and by channel**: a channels.tsv has at most one
 * row per channel, so re-annotating a channel replaces its previous row rather
 * than adding a second one that would make the export ambiguous.
 */
export function upsertChannelAnnotation(
  list: ChannelAnnotation[],
  annotation: ChannelAnnotation,
): ChannelAnnotation[] {
  const next = list.filter((a) => a.id !== annotation.id && a.channel !== annotation.channel);
  next.push(annotation);
  return sortChannelAnnotations(next);
}

/** Apply one set of tags/status/description to several channels at once. */
export function upsertChannelAnnotations(
  list: ChannelAnnotation[],
  channels: string[],
  shared: Omit<ChannelAnnotationInput, "channel" | "id">,
  now: number = Date.now(),
): ChannelAnnotation[] {
  let next = list;
  for (const channel of channels) {
    const existing = next.find((a) => a.channel === channel);
    next = upsertChannelAnnotation(
      next,
      createChannelAnnotation(
        { ...shared, channel, id: existing?.id, createdAt: existing?.createdAt, updatedAt: now },
        now,
      ),
    );
  }
  return next;
}

export function removeChannelAnnotation(
  list: ChannelAnnotation[],
  id: string,
): ChannelAnnotation[] {
  return list.filter((a) => a.id !== id);
}

// --- windowing and overlap -------------------------------------------------

/**
 * Annotations whose span intersects `[startS, endS)`. A zero-duration marker
 * counts when its onset is inside the window; a span counts when any part of
 * it is, so one that begins off-screen still draws its visible remainder.
 */
export function timeAnnotationsInWindow(
  list: TimeAnnotation[],
  startS: number,
  endS: number,
): TimeAnnotation[] {
  return list.filter((a) => a.onsetS + a.durationS >= startS && a.onsetS < endS);
}

export function timeAnnotationsOverlap(a: TimeAnnotation, b: TimeAnnotation): boolean {
  const aEnd = a.onsetS + a.durationS;
  const bEnd = b.onsetS + b.durationS;
  // Touching endpoints (one ends exactly where the next begins) is not an
  // overlap; two markers at the identical instant are.
  if (a.durationS === 0 && b.durationS === 0) return a.onsetS === b.onsetS;
  return a.onsetS < bEnd && b.onsetS < aEnd;
}

/** Every other annotation in `list` that overlaps `annotation` (ignoring itself). */
export function findTimeOverlaps(
  list: TimeAnnotation[],
  annotation: TimeAnnotation,
): TimeAnnotation[] {
  return list.filter((a) => a.id !== annotation.id && timeAnnotationsOverlap(a, annotation));
}

/**
 * Lane index per annotation so overlapping spans can be drawn stacked instead
 * of on top of each other. Greedy first-fit over the sorted list: each
 * annotation takes the lowest lane whose previous occupant has already ended.
 *
 * Overlap is *allowed*, not prevented -- a seizure containing individual
 * spikes is two true annotations of the same seconds, and refusing the second
 * one would be the tool arguing with the clinician. Laning is how both stay
 * visible.
 *
 * Deliberately a shade more conservative than `timeAnnotationsOverlap`: a
 * zero-duration marker occupies a nominal sliver of time, so two markers at
 * the same instant (and a marker sitting exactly on a span's edge) get
 * separate lanes even though neither counts as an overlap. Laning answers
 * "would these collide on screen", not "do these overlap in the data".
 */
const MARKER_LANE_WIDTH_S = 1e-9;

export function assignOverlapLanes(list: TimeAnnotation[]): Map<string, number> {
  const lanes: number[] = []; // lane index -> time its current occupant ends
  const out = new Map<string, number>();
  for (const a of sortTimeAnnotations(list)) {
    const end = a.onsetS + Math.max(a.durationS, MARKER_LANE_WIDTH_S);
    let lane = lanes.findIndex((occupiedUntil) => occupiedUntil <= a.onsetS);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(end);
    } else {
      lanes[lane] = end;
    }
    out.set(a.id, lane);
  }
  return out;
}

// --- BIDS serialization ----------------------------------------------------

const NA = "n/a";

/**
 * Seconds as a BIDS TSV cell: rounded to 0.1 ms and printed without trailing
 * zeros. Deterministic (no locale, no exponent for the magnitudes a recording
 * can reach) so the same set always produces the same bytes.
 */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0";
  const rounded = Math.round(seconds * 1e4) / 1e4;
  // `-0 === 0`, so this also catches the negative zero a value just below zero
  // rounds to, which would otherwise serialize as the cell "-0".
  if (rounded === 0) return "0";
  // toFixed then strip: String() on a rounded float can still print an
  // exponent or a long binary tail (0.1 + 0.2), which toFixed(4) will not.
  return rounded.toFixed(4).replace(/\.?0+$/, "") || "0";
}

/** A HED string: the annotation's tags, comma-separated as HED specifies. */
export function formatHed(tags: HedPath[]): string {
  return tags.length > 0 ? tags.join(", ") : NA;
}

function cell(text: string): string {
  const clean = cleanText(text);
  return clean === "" ? NA : clean;
}

function tsv(rows: string[][]): string {
  return `${rows.map((r) => r.join("\t")).join("\n")}\n`;
}

/**
 * BIDS `events.tsv` for the time annotations. `onset` and `duration` are the
 * two required columns and must come first and in that order; `HED` is the
 * standard optional column for a HED string; `description` is an extra column
 * carrying the annotator's free text.
 *
 * Sorted by onset, missing values as `n/a`, tab-separated, one trailing
 * newline -- so the output is byte-stable for a given set.
 */
export function serializeEventsTsv(list: TimeAnnotation[]): string {
  const rows: string[][] = [["onset", "duration", "HED", "description"]];
  for (const a of sortTimeAnnotations(list)) {
    rows.push([
      formatSeconds(a.onsetS),
      formatSeconds(a.durationS),
      formatHed(a.hedTags),
      cell(a.description),
    ]);
  }
  return tsv(rows);
}

/**
 * BIDS `channels.tsv`-shaped export for the channel annotations. `name` is the
 * required first column (this is what makes the file mergeable into a real
 * `channels.tsv`; "channel" would not be), `status` takes the BIDS
 * good/bad vocabulary, `status_description` carries the free text, and `HED`
 * carries the tags.
 *
 * Note this is an *annotation* file, not a complete `channels.tsv`: it lists
 * only the channels somebody marked, and omits the `type`/`units` columns BIDS
 * also requires, which belong to the dataset rather than to the annotator.
 */
export function serializeChannelsTsv(list: ChannelAnnotation[]): string {
  const rows: string[][] = [["name", "status", "status_description", "HED"]];
  for (const a of sortChannelAnnotations(list)) {
    rows.push([a.channel, a.status, cell(a.description), formatHed(a.hedTags)]);
  }
  return tsv(rows);
}

// --- file naming -----------------------------------------------------------

/**
 * The BIDS entity stem of a recording path: the filename with its directory,
 * its extension and its trailing `_<suffix>` removed.
 *
 * `sub-01/ses-1/eeg/sub-01_ses-1_task-rest_eeg.edf` -> `sub-01_ses-1_task-rest`
 *
 * A directory-format recording (`.mefd`, `.ds`, website#252) is named the same
 * way, so the same rule applies to it unchanged. A path that does not look
 * BIDS-shaped keeps whatever stem it has rather than being rewritten.
 */
export function recordingStem(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  // Strip one extension only: `.nii.gz` is not a signal format, and a label
  // containing a dot must survive.
  const noExt = base.replace(/\.[A-Za-z0-9]+$/, "");
  return noExt.replace(/_[A-Za-z0-9]+$/, "") || noExt || "recording";
}

export function eventsTsvFilename(filePath: string): string {
  return `${recordingStem(filePath)}_events.tsv`;
}

/**
 * Deliberately **not** `<stem>_channels.tsv`. That name says "this is the
 * recording's channels table", and this file is not one: it lists only the
 * channels somebody annotated and omits the `type`/`units` columns BIDS
 * requires. A file named like the real thing invites being dropped into a
 * dataset as-is, which would silently delete every unannotated channel's row.
 * The suffix keeps it obviously a thing to merge.
 */
export function channelsTsvFilename(filePath: string): string {
  return `${recordingStem(filePath)}_channels-annotations.tsv`;
}
