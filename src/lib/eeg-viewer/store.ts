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
 *   events/{onset,duration,code}  + group attrs.label_map {code: description}
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

export interface ChannelWindow {
  /** Dequantized envelope bottom (view levels). */
  min?: Float32Array;
  /** Dequantized envelope top (view levels). */
  max?: Float32Array;
  /** Dequantized single trace (level-0). */
  line?: Float32Array;
}

export interface WindowData {
  /** 0 = level-0 (lines); >=1 = view level (min/max band). */
  level: number;
  isBand: boolean;
  nCols: number;
  channels: ChannelWindow[];
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function parseChannels(raw: unknown): ChannelMeta[] {
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

/** Open a recording store and read all group + event metadata (no signal yet). */
export async function openRecording(url: string): Promise<RecordingStore> {
  const store = new zarr.FetchStore(url);
  const root = await zarr.open(store, { kind: "group" });
  const attrs = root.attrs as Record<string, unknown>;
  const format = typeof attrs.format === "string" ? attrs.format : "";
  const groupNames = Array.isArray(attrs.channel_groups) ? (attrs.channel_groups as string[]) : [];

  const groups: GroupHandle[] = [];
  for (const name of groupNames) {
    const grp = await zarr.open(root.resolve(name), { kind: "group" });
    const ga = grp.attrs as Record<string, unknown>;
    const channels = parseChannels(ga.channels);
    const level0 = (await zarr.open(root.resolve(`${name}/0`), {
      kind: "array",
    })) as zarr.Array<"int16", zarr.FetchStore>;
    const nSamples = num(ga.n_samples, level0.shape[level0.shape.length - 1]);
    const rate = num(ga.rate, 250);

    const viewLevels = await discoverViewLevels(root, name);
    const channelsByRow = [...channels].sort((a, b) => a.rowIndex - b.rowIndex);

    groups.push({
      name,
      modality: typeof ga.modality === "string" ? ga.modality : channels[0]?.modality || "MISC",
      rate,
      originalRate: num(ga.original_rate, rate),
      nChannels: num(ga.n_channels, channels.length),
      nSamples,
      durationS: nSamples / rate,
      channels,
      channelsByRow,
      level0,
      viewLevels,
    });
  }

  const events = await readEvents(root);
  return { url, format, groups, events };
}

/** Probe view/1, view/2, ... until one is missing. */
async function discoverViewLevels(
  root: zarr.Group<zarr.FetchStore>,
  group: string,
): Promise<ViewLevel[]> {
  const levels: ViewLevel[] = [];
  for (let level = 1; level <= 16; level++) {
    try {
      const array = (await zarr.open(root.resolve(`${group}/view/${level}`), {
        kind: "array",
      })) as zarr.Array<"int16", zarr.FetchStore>;
      levels.push({ level, nTime: array.shape[array.shape.length - 1], array });
    } catch {
      break;
    }
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
  } catch {
    return null;
  }
}

/**
 * Read the signal for `[startS, endS)` of a group, choosing the pyramid level
 * closest to `pixelWidth` columns and dequantizing into physical units.
 */
export async function readWindow(
  group: GroupHandle,
  startS: number,
  endS: number,
  pixelWidth: number,
): Promise<WindowData> {
  const dur = group.durationS;
  const start = Math.max(0, Math.min(startS, dur));
  const end = Math.max(start, Math.min(endS, dur));
  const visibleFraction = dur > 0 ? (end - start) / dur : 1;

  const levelSamples = [group.nSamples, ...group.viewLevels.map((v) => v.nTime)];
  const chosen = pickViewLevel(levelSamples, visibleFraction, pixelWidth);

  if (chosen === 0) {
    return readLevel0(group, start, end);
  }
  return readViewLevel(group, group.viewLevels[chosen - 1], start, end);
}

async function readLevel0(group: GroupHandle, startS: number, endS: number): Promise<WindowData> {
  const c0 = Math.floor(startS * group.rate);
  const c1 = Math.min(group.nSamples, Math.max(c0 + 1, Math.ceil(endS * group.rate)));
  const region = await zarr.get(group.level0, [null, zarr.slice(c0, c1)]);
  const cols = region.shape[1];
  const data = region.data as Int16Array;
  const channels: ChannelWindow[] = group.channelsByRow.map((ch, row) => {
    const line = new Float32Array(cols);
    const base = row * cols;
    for (let c = 0; c < cols; c++) line[c] = (data[base + c] * ch.scale + ch.offset) * ch.siFactor;
    return { line };
  });
  return { level: 0, isBand: false, nCols: cols, channels };
}

async function readViewLevel(
  group: GroupHandle,
  view: ViewLevel,
  startS: number,
  endS: number,
): Promise<WindowData> {
  const dur = group.durationS || 1;
  const c0 = Math.floor((startS / dur) * view.nTime);
  const c1 = Math.min(view.nTime, Math.max(c0 + 1, Math.ceil((endS / dur) * view.nTime)));
  const region = await zarr.get(view.array, [null, null, zarr.slice(c0, c1)]);
  const cols = region.shape[2];
  const data = region.data as Int16Array;
  const nCh = region.shape[1];
  // region is [2, nCh, cols] row-major: index = ((m*nCh)+row)*cols + c.
  const channels: ChannelWindow[] = group.channelsByRow.map((ch, row) => {
    const min = new Float32Array(cols);
    const max = new Float32Array(cols);
    const a0 = (0 * nCh + row) * cols;
    const a1 = (1 * nCh + row) * cols;
    for (let c = 0; c < cols; c++) {
      const v0 = (data[a0 + c] * ch.scale + ch.offset) * ch.siFactor;
      const v1 = (data[a1 + c] * ch.scale + ch.offset) * ch.siFactor;
      min[c] = v0 < v1 ? v0 : v1;
      max[c] = v0 < v1 ? v1 : v0;
    }
    return { min, max };
  });
  return { level: view.level, isBand: true, nCols: cols, channels };
}
