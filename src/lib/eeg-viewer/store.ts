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
}

export interface EventTable {
  onsetS: Float64Array;
  durationS: Float64Array;
  code: Int32Array;
  labelMap: Record<string, string>;
}

export interface RecordingStore {
  url: string;
  format: string;
  groups: GroupHandle[];
  events: EventTable | null;
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
          throw new Error(
            `zarr.nemar.org returned ${res.status} after ${retries + 1} attempts`,
          );
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
  const groupNames = Array.isArray(attrs.channel_groups) ? (attrs.channel_groups as string[]) : [];

  const [groups, events] = await Promise.all([
    Promise.all(groupNames.map((name) => openGroup(root, name))),
    readEvents(root),
  ]);
  return { url, format, groups, events };
}

async function openGroup(root: zarr.Group<zarr.FetchStore>, name: string): Promise<GroupHandle> {
  try {
    const [grp, rawLevel0, viewLevels] = await Promise.all([
      zarr.open(root.resolve(name), { kind: "group" }),
      zarr.open(root.resolve(`${name}/0`), { kind: "array" }),
      discoverViewLevels(root, name),
    ]);
    if (rawLevel0.dtype !== "int16") {
      throw new Error(
        `unexpected dtype ${rawLevel0.dtype} at ${name}/0; expected int16`,
      );
    }
    const level0 = rawLevel0 as zarr.Array<"int16", zarr.FetchStore>;
    const ga = grp.attrs as Record<string, unknown>;
    const channels = parseChannels(ga.channels);
    const nChannels = channels.length;
    if (typeof ga.n_channels === "number" && Number.isFinite(ga.n_channels) && ga.n_channels !== nChannels) {
      console.warn(
        `[eeg-viewer] group "${name}": attrs.n_channels=${ga.n_channels} but parsed ${nChannels} channels; using ${nChannels}`,
      );
    }
    const nSamples = num(ga.n_samples, level0.shape[level0.shape.length - 1]);
    const rate = num(ga.rate, 250);
    return {
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
      viewLevels,
    };
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
): Promise<ViewLevel[]> {
  const levels: ViewLevel[] = [];
  for (let base = 1; base <= VIEW_PROBE_MAX; base += VIEW_PROBE_BATCH) {
    const probes = await Promise.allSettled(
      Array.from({ length: VIEW_PROBE_BATCH }, (_, i) => base + i).map(async (level) => {
        const rawArray = await zarr.open(root.resolve(`${group}/view/${level}`), {
          kind: "array",
        });
        if (rawArray.dtype !== "int16") {
          throw new Error(
            `unexpected dtype ${rawArray.dtype} at ${group}/view/${level}; expected int16`,
          );
        }
        const array = rawArray as zarr.Array<"int16", zarr.FetchStore>;
        return { level, nTime: array.shape[array.shape.length - 1], array };
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
    const labelMap = ((grp.attrs as Record<string, unknown>).label_map ?? {}) as Record<
      string,
      string
    >;
    return {
      onsetS: Float64Array.from(on.data as ArrayLike<number>),
      durationS: Float64Array.from(du.data as ArrayLike<number>),
      code: Int32Array.from(co.data as ArrayLike<number>),
      labelMap,
    };
  } catch (err) {
    console.warn("[eeg-viewer] readEvents failed; events hidden:", err);
    return null;
  }
}

/** Largest window (samples) we will read from level-0; past it use the pyramid
 * (a sharded level-0 read scales with the window, so this caps transfer). */
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
  if (group.viewLevels.length === 0) return null;
  const view = group.viewLevels[group.viewLevels.length - 1];
  try {
    const region = await zarr.get(view.array, null);
    // region shape: [2, nCh, nTime]
    const nCh = region.shape[1];
    const nTime = region.shape[2];
    return aggregateOverview(
      region.data as Int16Array,
      nCh,
      nTime,
      group.channelsByRow,
    );
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
): Promise<WindowData> {
  const dur = group.durationS;
  const start = Math.max(0, Math.min(startS, dur));
  const end = Math.max(start, Math.min(endS, dur));
  const visibleFraction = dur > 0 ? (end - start) / dur : 1;
  const r0 = Math.max(0, Math.min(rowStart, group.nChannels));
  const r1 = Math.max(r0 + 1, Math.min(rowStart + rowCount, group.nChannels));

  const levelSamples = [group.nSamples, ...group.viewLevels.map((v) => v.nTime)];
  const chosen = pickViewLevel(levelSamples, visibleFraction, pixelWidth);
  // With useSuffixRequest a windowed level-0 read only fetches the window's inner
  // chunks, so level-0 (crisp full-rate lines) is used for narrow windows and the
  // view pyramid (min/max band) for wide overviews -- pickViewLevel already
  // returns 0 only when the window is narrow enough that level-0 is the right
  // resolution. `forceLevel0` (client filters) also needs samples. A hard sample
  // cap keeps an unexpectedly wide level-0 selection from over-fetching; past it
  // we fall back to the finest view level.
  const windowSamples = Math.ceil((end - start) * group.rate);
  const useLevel0 = (chosen === 0 || forceLevel0) && windowSamples <= LEVEL0_MAX_SAMPLES;
  if (useLevel0) return readLevel0(group, start, end, r0, r1);

  // A view level: if pickViewLevel chose level-0 but we won't read it (too wide,
  // or filters off at this zoom), fall back to the finest available pyramid level.
  const view = group.viewLevels[Math.max(1, chosen) - 1];
  if (!view) return readLevel0(group, start, end, r0, r1); // no pyramid -> level-0 anyway
  return readViewLevel(group, view, start, end, r0, r1);
}

async function readLevel0(
  group: GroupHandle,
  startS: number,
  endS: number,
  r0: number,
  r1: number,
): Promise<WindowData> {
  const c0 = Math.floor(startS * group.rate);
  const c1 = Math.min(group.nSamples, Math.max(c0 + 1, Math.ceil(endS * group.rate)));
  const region = await zarr.get(group.level0, [zarr.slice(r0, r1), zarr.slice(c0, c1)]);
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

async function readViewLevel(
  group: GroupHandle,
  view: ViewLevel,
  startS: number,
  endS: number,
  r0: number,
  r1: number,
): Promise<WindowData> {
  const dur = group.durationS || 1;
  const c0 = Math.floor((startS / dur) * view.nTime);
  const c1 = Math.min(view.nTime, Math.max(c0 + 1, Math.ceil((endS / dur) * view.nTime)));
  const region = await zarr.get(view.array, [null, zarr.slice(r0, r1), zarr.slice(c0, c1)]);
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
