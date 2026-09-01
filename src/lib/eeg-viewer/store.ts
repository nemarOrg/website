/**
 * Zarrita reader for a NEMAR biosigIO Zarr v3 recording store (website#99).
 * Confirmed contract (spike against zarr.nemar.org/nm000132):
 *
 *   /                         root group, attrs.channel_groups = ["eeg_250hz", ...]
 *   <group>/                  attrs: rate, original_rate, n_channels, n_samples,
 *                             channels[] = {label, channel_type, modality, unit,
 *                             scale, offset, row_index, usable_for_inference}
 *   <group>/0                 [n_ch, n_time] int16, SHARDED + zstd (level-0)
 *   <group>/view/L            [2, n_ch, n_time_L] int16 min/max envelope (NOT sharded)
 *   events/{onset,duration,code}  + the events group's attrs.label_map {code: description}
 *
 * Dequantize: physical = digital * scale + offset (per channel). The viewer reads
 * a window at the pyramid level closest to 1 sample/px, so transfer is bounded by
 * the viewport, not the recording length.
 */
import * as zarr from "zarrita";
import { pickViewLevel, unitToSI } from "./dsp";

export interface ChannelMeta {
  label: string;
  channelType: string;
  modality: string;
  unit: string;
  scale: number;
  offset: number;
  rowIndex: number;
  usableForInference: boolean;
  /** Multiply a native-unit physical value by this to get SI (V or T). */
  siFactor: number;
}

export interface ViewLevel {
  /** 1-based pyramid level (view/1, view/2, ...). */
  level: number;
  /** Time samples this level holds for the whole recording (array shape[2]). */
  nTime: number;
  array: zarr.Array<"int16", zarr.FetchStore>;
}

export interface GroupHandle {
  name: string;
  modality: string;
  rate: number;
  originalRate: number;
  nChannels: number;
  nSamples: number;
  durationS: number;
  channels: ChannelMeta[];
  /** Channels ordered by their array row_index (the level-0/view row order). */
  channelsByRow: ChannelMeta[];
  level0: zarr.Array<"int16", zarr.FetchStore>;
  viewLevels: ViewLevel[];
  /** Resolves when lazy view-pyramid discovery has finished. First paint does
   *  not wait for this; wide-window reads and the overview minimap do. */
  viewLevelsReady: Promise<ViewLevel[]>;
}

export interface EventTable {
  onsetS: Float64Array;
  durationS: Float64Array;
  code: Int32Array;
  /** Internal code -> raw BIDS value string (e.g. "21", "boundary"). */
  labelMap: Record<string, string>;
  /** Raw value string -> human description from the events.json Levels (embedded
   * by the converter); empty when the dataset declares none. */
  valueDescriptions: Record<string, string>;
}

export interface RecordingStore {
  url: string;
  format: string;
  /** BIDS PowerLineFrequency (Hz) resolved from the recording's _eeg.json sidecar
   * by the converter and embedded in the store attrs; null when the dataset does
   * not declare one. The viewer defaults the notch filter to this. */
  powerLineFrequency: number | null;
  /** BIDS electrode positions {label:[x,y,z]} from electrodes.tsv, embedded by the
   * converter, with the coordinate system + units; empty when the dataset declares
   * none. The viewer projects these for the scalp topomap. */
  electrodePositions: Record<string, [number, number, number]>;
  electrodeCoordinateSystem: string;
  electrodeCoordinateUnits: string;
  groups: GroupHandle[];
  events: EventTable | null;
  /** Events are loaded after the first signal frame so startup is not gated on
   *  reading all event arrays. Resolves to null when the store has no events. */
  eventsReady: Promise<EventTable | null>;
}

export type ChannelWindow =
  | { kind: "line"; line: Float32Array }
  | { kind: "band"; min: Float32Array; max: Float32Array };

export interface WindowData {
  /** 0 = level-0 (lines); >=1 = view level (min/max band). */
  level: number;
  nCols: number;
  channels: ChannelWindow[];
}

/**
 * Approximate resident size of a decoded window, for the background preloader's
 * byte-accounted cache (website#254). Counts the `Float32Array` payloads only
 * (a line channel's samples, or a band channel's min+max pair) -- close enough
 * for a soft cap; it does not need to match the JS engine's actual allocation.
 */
export function windowDataBytes(win: WindowData): number {
  let bytes = 0;
  for (const ch of win.channels) {
    bytes += ch.kind === "line" ? ch.line.byteLength : ch.min.byteLength + ch.max.byteLength;
  }
  return bytes;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function parseChannels(raw: unknown): ChannelMeta[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c, i) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const unit = typeof o.unit === "string" ? o.unit : "uV";
    return {
      label: typeof o.label === "string" ? o.label : `ch${i}`,
      channelType: typeof o.channel_type === "string" ? o.channel_type : "OTHER",
      modality: typeof o.modality === "string" ? o.modality : "MISC",
      unit,
      scale: num(o.scale, 1),
      offset: num(o.offset, 0),
      rowIndex: num(o.row_index, i),
      usableForInference: o.usable_for_inference !== false,
      siFactor: unitToSI(unit),
    };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fetch handler that retries transient gateway failures, with capped
 * exponential backoff + jitter. zarr.nemar.org (a Cloudflare Worker in front of
 * S3) returns the odd 429/5xx under a burst of concurrent chunk reads or a cold
 * edge; each request retries independently so the bursts spread out and the
 * signal still loads. GETs carry no body, so reissuing the request is safe.
 */
function retryingFetch(retries = 6, baseMs = 250) {
  const delay = (attempt: number) =>
    sleep(Math.min(baseMs * 2 ** attempt, 3000) + Math.floor(Math.random() * 200));
  return async (request: Request): Promise<Response> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(request);
        const transient = res.status === 429 || (res.status >= 500 && res.status < 600);
        if (transient) {
          if (attempt < retries) {
            await delay(attempt);
            continue;
          }
          throw new Error(`zarr.nemar.org returned ${res.status} after ${retries + 1} attempts`);
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt >= retries) throw err;
        await delay(attempt);
      }
    }
    throw lastErr;
  };
}

/** A FetchStore that retries transient 5xx/429 for resilient streaming. */
export function makeStore(url: string): zarr.FetchStore {
  // useSuffixRequest: read the sharded level-0 index with a native `Range:
  // bytes=-N` instead of a full-object GET to learn its size first. Without it
  // zarrita fetches the entire ~3 MB shard for any level-0 access; with it a
  // windowed level-0 read is just the index + the window's inner chunks (~127 KB
  // for a 10 s window), which makes full-rate lines + client filters affordable.
  return new zarr.FetchStore(url, { fetch: retryingFetch(), useSuffixRequest: true });
}

/**
 * Open a recording store and read all group + event metadata (no signal yet).
 * The per-group reads (attrs, level-0, view-level probes) and the events read run
 * in parallel so first paint of the toolbar is not gated on a chain of sequential
 * round trips.
 */
export async function openRecording(url: string): Promise<RecordingStore> {
  const store = makeStore(url);
  const root = await zarr.open(store, { kind: "group" });
  const attrs = root.attrs as Record<string, unknown>;
  const format = typeof attrs.format === "string" ? attrs.format : "";
  const plf = attrs.power_line_frequency;
  const powerLineFrequency =
    typeof plf === "number" && Number.isFinite(plf) && plf > 0 ? plf : null;
  // Validate each entry: a label maps to [x,y,z] of finite numbers. BIDS uses the
  // string "n/a" for missing coords (and a buggy converter could emit short tuples),
  // so skip anything that is not three finite numbers rather than feeding NaN into the
  // projection.
  const electrodePositions: Record<string, [number, number, number]> = {};
  const ep = attrs.electrode_positions;
  if (ep && typeof ep === "object" && !Array.isArray(ep)) {
    let skipped = 0;
    for (const [label, raw] of Object.entries(ep as Record<string, unknown>)) {
      if (
        Array.isArray(raw) &&
        raw.length === 3 &&
        raw.every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        electrodePositions[label] = raw as [number, number, number];
      } else {
        skipped++;
      }
    }
    if (skipped > 0) {
      console.warn(
        `[eeg-viewer] electrode_positions: skipped ${skipped} entries with invalid coords`,
      );
    }
  }
  const electrodeCoordinateSystem =
    typeof attrs.electrode_coordinate_system === "string" ? attrs.electrode_coordinate_system : "";
  const electrodeCoordinateUnits =
    typeof attrs.electrode_coordinate_units === "string" ? attrs.electrode_coordinate_units : "";
  const groupNames = Array.isArray(attrs.channel_groups) ? (attrs.channel_groups as string[]) : [];

  const groups = await Promise.all(groupNames.map((name) => openGroup(root, name)));
  const eventsReady = readEvents(root);
  return {
    url,
    format,
    powerLineFrequency,
    electrodePositions,
    electrodeCoordinateSystem,
    electrodeCoordinateUnits,
    groups,
    events: null,
    eventsReady,
  };
}

async function openGroup(root: zarr.Group<zarr.FetchStore>, name: string): Promise<GroupHandle> {
  try {
    const [grp, rawLevel0] = await Promise.all([
      zarr.open(root.resolve(name), { kind: "group" }),
      zarr.open(root.resolve(`${name}/0`), { kind: "array" }),
    ]);
    if (rawLevel0.dtype !== "int16") {
      throw new Error(`unexpected dtype ${rawLevel0.dtype} at ${name}/0; expected int16`);
    }
    const level0 = rawLevel0 as zarr.Array<"int16", zarr.FetchStore>;
    const ga = grp.attrs as Record<string, unknown>;
    const channels = parseChannels(ga.channels);
    const nChannels = channels.length;
    if (
      typeof ga.n_channels === "number" &&
      Number.isFinite(ga.n_channels) &&
      ga.n_channels !== nChannels
    ) {
      console.warn(
        `[eeg-viewer] group "${name}": attrs.n_channels=${ga.n_channels} but parsed ${nChannels} channels; using ${nChannels}`,
      );
    }
    const nSamples = num(ga.n_samples, level0.shape[level0.shape.length - 1]);
    const rate = num(ga.rate, 250);
    const handle: GroupHandle = {
      name,
      modality: typeof ga.modality === "string" ? ga.modality : channels[0]?.modality || "MISC",
      rate,
      originalRate: num(ga.original_rate, rate),
      nChannels,
      nSamples,
      durationS: nSamples / rate,
      channels,
      channelsByRow: [...channels].sort((a, b) => a.rowIndex - b.rowIndex),
      level0,
      viewLevels: [],
      viewLevelsReady: Promise.resolve([]),
    };
    handle.viewLevelsReady = discoverViewLevels(root, name, ga)
      .then((levels) => {
        handle.viewLevels = levels;
        return levels;
      })
      .catch((err) => {
        console.warn(`[eeg-viewer] view-level discovery failed for ${name}:`, err);
        return [];
      });
    return handle;
  } catch (err) {
    throw new Error(
      `failed to open group "${name}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

const VIEW_PROBE_BATCH = 6;
const VIEW_PROBE_MAX = 12;

/**
 * Discover the view-pyramid levels (view/1, view/2, ...). The store has no level
 * count attribute, so we probe — but in batches with early stop, so a typical
 * pyramid resolves in one round-trip with only a couple of 404s rather than
 * blindly firing a dozen misses (each doubled by zarrita's v2 `.zattrs`
 * fallback). Levels are contiguous from view/1.
 */
function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /404|not[ _]?found/i.test(msg);
}

async function discoverViewLevels(
  root: zarr.Group<zarr.FetchStore>,
  group: string,
  attrs: Record<string, unknown> = {},
): Promise<ViewLevel[]> {
  const declared = declaredViewLevels(attrs);
  if (declared) {
    const levels = await Promise.all(declared.map((level) => openViewLevel(root, group, level)));
    return levels.filter((v): v is ViewLevel => v !== null);
  }

  const levels: ViewLevel[] = [];
  for (let base = 1; base <= VIEW_PROBE_MAX; base += VIEW_PROBE_BATCH) {
    const probes = await Promise.allSettled(
      Array.from({ length: VIEW_PROBE_BATCH }, (_, i) => base + i).map(async (level) => {
        const view = await openViewLevel(root, group, level);
        if (!view) throw new Error(`unexpected missing view/${level}`);
        return view;
      }),
    );
    let added = 0;
    for (const p of probes) {
      if (p.status !== "fulfilled") {
        if (!isNotFound(p.reason)) {
          console.warn("[eeg-viewer] view-level probe failed (non-404):", p.reason);
        }
        break; // contiguous from view/1
      }
      levels.push(p.value);
      added++;
    }
    if (added < VIEW_PROBE_BATCH) break; // hit the end within this batch
  }
  return levels;
}

function declaredViewLevels(attrs: Record<string, unknown>): number[] | null {
  const raw = attrs.view_levels ?? attrs.viewLevels;
  if (Array.isArray(raw)) {
    const levels = raw
      .map((v) => {
        if (typeof v === "number") return v;
        if (v && typeof v === "object") {
          const level = (v as Record<string, unknown>).level;
          return typeof level === "number" ? level : Number.NaN;
        }
        return Number.NaN;
      })
      .filter((n) => Number.isInteger(n) && n > 0);
    return levels.length > 0 ? [...new Set(levels)].sort((a, b) => a - b) : null;
  }
  const count = attrs.n_view_levels ?? attrs.view_level_count;
  if (typeof count === "number" && Number.isInteger(count) && count > 0) {
    return Array.from({ length: Math.min(count, VIEW_PROBE_MAX) }, (_, i) => i + 1);
  }
  return null;
}

async function openViewLevel(
  root: zarr.Group<zarr.FetchStore>,
  group: string,
  level: number,
): Promise<ViewLevel | null> {
  const rawArray = await zarr.open(root.resolve(`${group}/view/${level}`), {
    kind: "array",
  });
  if (rawArray.dtype !== "int16") {
    throw new Error(`unexpected dtype ${rawArray.dtype} at ${group}/view/${level}; expected int16`);
  }
  const array = rawArray as zarr.Array<"int16", zarr.FetchStore>;
  return { level, nTime: array.shape[array.shape.length - 1], array };
}

async function readEvents(root: zarr.Group<zarr.FetchStore>): Promise<EventTable | null> {
  try {
    const grp = await zarr.open(root.resolve("events"), { kind: "group" });
    const [onset, duration, code] = await Promise.all([
      zarr.open(root.resolve("events/onset"), { kind: "array" }),
      zarr.open(root.resolve("events/duration"), { kind: "array" }),
      zarr.open(root.resolve("events/code"), { kind: "array" }),
    ]);
    const [on, du, co] = await Promise.all([
      zarr.get(onset, null),
      zarr.get(duration, null),
      zarr.get(code, null),
    ]);
    const attrs = grp.attrs as Record<string, unknown>;
    const labelMap = (attrs.label_map ?? {}) as Record<string, string>;
    const valueDescriptions = (attrs.value_descriptions ?? {}) as Record<string, string>;
    return {
      onsetS: Float64Array.from(on.data as ArrayLike<number>),
      durationS: Float64Array.from(du.data as ArrayLike<number>),
      code: Int32Array.from(co.data as ArrayLike<number>),
      labelMap,
      valueDescriptions,
    };
  } catch (err) {
    console.warn("[eeg-viewer] readEvents failed; events hidden:", err);
    return null;
  }
}

/** Largest window (samples) we will read from level-0; past it prefer the pyramid
 * when one exists (a sharded level-0 read scales with the window, so this caps
 * transfer). Falls back to level-0 regardless if the store has no view levels. */
const LEVEL0_MAX_SAMPLES = 20000;

/**
 * Aggregate a [2, nCh, nTime] int16 min/max region into a per-column activity
 * envelope: max over channels of |max - min|, dequantized to SI units. Pure
 * function (no zarr I/O) — exported for unit tests and used by readOverview.
 */
export function aggregateOverview(
  data: Int16Array,
  nCh: number,
  nTime: number,
  channels: Array<{ scale: number; offset: number; siFactor: number }>,
): Float32Array {
  const out = new Float32Array(nTime);
  for (let c = 0; c < nTime; c++) {
    let maxRange = 0;
    for (let i = 0; i < nCh; i++) {
      const ch = channels[i];
      if (!ch) continue;
      const a0 = (0 * nCh + i) * nTime + c;
      const a1 = (1 * nCh + i) * nTime + c;
      const v0 = (data[a0] * ch.scale + ch.offset) * ch.siFactor;
      const v1 = (data[a1] * ch.scale + ch.offset) * ch.siFactor;
      const range = Math.abs(v1 - v0);
      if (range > maxRange) maxRange = range;
    }
    out[c] = maxRange;
  }
  return out;
}

/**
 * Read the coarsest view-pyramid level for a group and aggregate channel
 * activity into a per-column envelope (max over channels of (max-min),
 * dequantized to SI units). Returns null when no view levels exist.
 *
 * This is used by the overview minimap: a single cheap read of the coarsest
 * (smallest) level, cached by the caller.
 */
export async function readOverview(group: GroupHandle): Promise<Float32Array | null> {
  if (group.viewLevels.length === 0) await group.viewLevelsReady;
  if (group.viewLevels.length === 0) return null;
  const view = group.viewLevels[group.viewLevels.length - 1];
  try {
    const region = await zarr.get(view.array, null);
    // Expected shape [2, nCh, nTime] (min/max rows). Guard so a mis-shaped store
    // hides the minimap instead of indexing undefined dims into garbage data.
    if (region.shape.length < 3 || region.shape[0] !== 2) {
      console.error(
        "[eeg-viewer] readOverview: unexpected shape",
        region.shape,
        "(want [2, nCh, nTime])",
      );
      return null;
    }
    const nCh = region.shape[1];
    const nTime = region.shape[2];
    return aggregateOverview(region.data as Int16Array, nCh, nTime, group.channelsByRow);
  } catch (err) {
    console.warn("[eeg-viewer] readOverview failed:", err);
    return null;
  }
}

/**
 * Read the signal for `[startS, endS)` of a group, choosing the pyramid level
 * closest to `pixelWidth` columns and dequantizing into physical units. Only the
 * channel rows `[rowStart, rowStart+rowCount)` are fetched (vertical scrolling
 * through a large montage transfers just the visible rows). The returned
 * `channels` align 1:1 with `group.channelsByRow.slice(rowStart, ...)`.
 */
export async function readWindow(
  group: GroupHandle,
  startS: number,
  endS: number,
  pixelWidth: number,
  rowStart = 0,
  rowCount = group.nChannels,
  forceLevel0 = false,
  signal?: AbortSignal,
): Promise<WindowData> {
  const dur = group.durationS;
  const start = Math.max(0, Math.min(startS, dur));
  const end = Math.max(start, Math.min(endS, dur));
  const visibleFraction = dur > 0 ? (end - start) / dur : 1;
  const r0 = Math.max(0, Math.min(rowStart, group.nChannels));
  const r1 = Math.max(r0 + 1, Math.min(rowStart + rowCount, group.nChannels));

  let viewLevels = group.viewLevels;
  let levelSamples = [group.nSamples, ...viewLevels.map((v) => v.nTime)];
  let chosen = pickViewLevel(levelSamples, visibleFraction, pixelWidth);
  // With useSuffixRequest a windowed level-0 read only fetches the window's inner
  // chunks, so level-0 (crisp full-rate lines) is used for narrow windows and the
  // view pyramid (min/max band) for wide overviews -- pickViewLevel already
  // returns 0 only when the window is narrow enough that level-0 is the right
  // resolution. `forceLevel0` (client filters) also needs samples. A hard sample
  // cap keeps an unexpectedly wide level-0 selection from over-fetching; past it
  // we fall back to the finest view level.
  const windowSamples = Math.ceil((end - start) * group.rate);
  let useLevel0 = (chosen === 0 || forceLevel0) && windowSamples <= LEVEL0_MAX_SAMPLES;
  if (useLevel0) return readLevel0(group, start, end, r0, r1, signal);

  if (viewLevels.length === 0) {
    viewLevels = await group.viewLevelsReady;
    levelSamples = [group.nSamples, ...viewLevels.map((v) => v.nTime)];
    chosen = pickViewLevel(levelSamples, visibleFraction, pixelWidth);
    useLevel0 = (chosen === 0 || forceLevel0) && windowSamples <= LEVEL0_MAX_SAMPLES;
    if (useLevel0) return readLevel0(group, start, end, r0, r1, signal);
  }

  // A view level: either pickViewLevel chose level-0 but it is too wide for the
  // sample cap, or it chose a view level and no filter is forcing level-0. Either
  // way fall back to the finest pyramid level (or level-0 itself if no pyramid
  // exists, which only happens for short recordings).
  const view = viewLevels[Math.max(1, chosen) - 1];
  if (!view) return readLevel0(group, start, end, r0, r1, signal); // no pyramid -> level-0 anyway
  return readViewLevel(group, view, start, end, r0, r1, signal);
}

/**
 * Read a `[startS, endS)` window from level-0 (full-rate samples) explicitly,
 * bypassing the `readWindow` level-selection heuristic. Exported so the
 * background preloader (prefetch.ts, website#254) can target a specific,
 * already-chosen pyramid level while walking the recording, rather than
 * re-deriving `pickViewLevel`'s pixel-width heuristic for a window that is not
 * actually on screen. `signal` aborts the underlying zarr chunk fetch (wired
 * to the preloader's own AbortController; website#208 covers threading this
 * through the interactive path too).
 */
export async function readLevel0(
  group: GroupHandle,
  startS: number,
  endS: number,
  r0: number,
  r1: number,
  signal?: AbortSignal,
): Promise<WindowData> {
  const c0 = Math.floor(startS * group.rate);
  const c1 = Math.min(group.nSamples, Math.max(c0 + 1, Math.ceil(endS * group.rate)));
  const region = await zarr.get(group.level0, [zarr.slice(r0, r1), zarr.slice(c0, c1)], {
    signal,
  });
  const cols = region.shape[1];
  const data = region.data as Int16Array;
  const channels: ChannelWindow[] = group.channelsByRow.slice(r0, r1).map((ch, i) => {
    const line = new Float32Array(cols);
    const base = i * cols;
    for (let c = 0; c < cols; c++) line[c] = (data[base + c] * ch.scale + ch.offset) * ch.siFactor;
    return { kind: "line" as const, line };
  });
  return { level: 0, nCols: cols, channels };
}

/**
 * Read a `[startS, endS)` window from a specific view-pyramid level explicitly.
 * See `readLevel0` above for why this is exported (website#254's preloader).
 */
export async function readViewLevel(
  group: GroupHandle,
  view: ViewLevel,
  startS: number,
  endS: number,
  r0: number,
  r1: number,
  signal?: AbortSignal,
): Promise<WindowData> {
  const dur = group.durationS || 1;
  const c0 = Math.floor((startS / dur) * view.nTime);
  const c1 = Math.min(view.nTime, Math.max(c0 + 1, Math.ceil((endS / dur) * view.nTime)));
  const region = await zarr.get(view.array, [null, zarr.slice(r0, r1), zarr.slice(c0, c1)], {
    signal,
  });
  const cols = region.shape[2];
  const data = region.data as Int16Array;
  const nCh = region.shape[1]; // = r1 - r0
  // region is [2, nCh, cols] row-major: index = ((m*nCh)+row)*cols + c.
  const channels: ChannelWindow[] = group.channelsByRow.slice(r0, r1).map((ch, i) => {
    const min = new Float32Array(cols);
    const max = new Float32Array(cols);
    const a0 = (0 * nCh + i) * cols;
    const a1 = (1 * nCh + i) * cols;
    for (let c = 0; c < cols; c++) {
      const v0 = (data[a0 + c] * ch.scale + ch.offset) * ch.siFactor;
      const v1 = (data[a1 + c] * ch.scale + ch.offset) * ch.siFactor;
      min[c] = v0 < v1 ? v0 : v1;
      max[c] = v0 < v1 ? v1 : v0;
    }
    return { kind: "band" as const, min, max };
  });
  return { level: view.level, nCols: cols, channels };
}
