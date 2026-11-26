/**
 * `nemar.signal-window` version 1 (neuroschema 0.6.0 `docs/views/presets.md`): a window of the
 * recording as the serving copy holds it, opened in the signal viewer with the floor's decisions
 * marked, its bad channels and its bad segments. Loaded with the panel's Signal tab.
 *
 * Nine checks, in this order, and the first that fails draws nothing (a window with its marks
 * missing could pass for clean data): the declaration; the tables named as the recording's
 * (`table_location_mismatch`); the tables' files, channels first; the store digest
 * (`store_digest_mismatch`, else the state `matches` or `not_checked`); the store's rate
 * (`rate_invalid`); the tables' grammar, columns and cells; each bad channel a store row
 * (`bad_channel_unknown`); each store row a row of the channels table (`channel_row_missing`); and
 * a window that holds a sample (`window_outside`). `views/vectors/preset-checks.v1.json` holds it
 * to `neuroschema.views.presets.check_signal_window`.
 */

import {
  CAPS,
  type FileDecl,
  type FileSource,
  type ModelOptions,
  Reader,
  type ViewDecl,
  ViewRefused,
  subtleSha256,
} from "./model";
import { PresetRefused } from "./preset-refused";
import type { SignalStore } from "./presets";
import { KindRefused, type Tsv, cellValue, cells, readTsv } from "./read";

export const NO_BAD_SEGMENT_TABLE = "no_bad_segment_table";

export interface BadSegment {
  readonly onset: number;
  readonly duration: number;
  readonly label: string;
}

export interface SignalWindow {
  readonly state: "matches" | "not_checked";
  /** The window's first sample and its count of samples. */
  readonly first: number;
  readonly count: number;
  /** The channels the floor marked bad, in file order. */
  readonly bad_channels: string[];
  readonly segments: BadSegment[];
  readonly notes: string[];
}

/** The samples k (0 <= k < samples) whose time k / rate lies in [start, start + duration). */
export function windowSamples(
  startS: number,
  durationS: number,
  samples: number,
  rate: number,
): { first: number; count: number } {
  const end = startS + durationS;
  /** The least k with k / rate >= t (bisect_left over the times). */
  const firstAtOrAfter = (t: number): number => {
    let lo = 0;
    let hi = samples;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (mid / rate < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const first = firstAtOrAfter(startS);
  return { first, count: Math.max(firstAtOrAfter(end) - first, 0) };
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const dirname = (path: string): string => {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at).replace(/\/+$/, "") || path.slice(0, at);
};

/** nemar-process's `naming.product_stem`: the recording's name without its last `_<suffix>.<ext>`,
 *  its first `desc-<x>` becoming `desc-<x><label>`, or `_desc-<label>` appended. */
export function productStem(recording: string, label: string): string {
  const name = basename(recording);
  const parts = name.slice(0, name.includes("_") ? name.lastIndexOf("_") : name.length).split("_");
  const at = parts.findIndex((part) => /^desc-[^_]*$/.test(part));
  if (at >= 0) {
    parts[at] = `${parts[at]}${label}`;
    return parts.join("_");
  }
  return [...parts, `desc-${label}`].join("_");
}

/** Whether a table lies beside the recording, named `<stem>_<suffix>.tsv` with the stem the
 *  recipe of `label` gives the recording's products. */
export function tableIsRecordings(
  location: string,
  recording: string,
  label: string,
  suffix: string,
): boolean {
  const found = /^(.+)_([A-Za-z0-9]+)\.tsv$/.exec(basename(location));
  if (!found || dirname(location) !== dirname(recording) || !basename(recording).includes("_")) {
    return false;
  }
  return found[2] === suffix && found[1] === productStem(recording, label);
}

type Input = {
  readonly role: string;
  readonly file?: FileDecl;
  readonly store?: Record<string, unknown>;
};
const inputOf = (view: ViewDecl, role: string): Input | undefined =>
  (view.inputs as readonly Input[] | undefined)?.find((i) => i.role === role);

/** One of the floor's tables: its columns present in order, `numbers` columns finite numbers. */
function readTable(
  tsv: Tsv,
  columns: readonly string[],
  numbers: readonly string[],
  cellCap: number,
): Record<string, string | number>[] {
  if (tsv.rows.length * tsv.header.length > cellCap) {
    throw new KindRefused("cap_exceeded", `${tsv.rows.length} rows`);
  }
  for (const name of columns) {
    if (!tsv.header.includes(name)) throw new KindRefused("column_missing", name);
  }
  const values: Record<string, (string | number)[]> = {};
  for (const name of columns) values[name] = cells(tsv, name);
  for (const name of numbers)
    values[name] = values[name].map((t) => cellValue(String(t), "number"));
  return tsv.rows.map((_, k) => Object.fromEntries(columns.map((name) => [name, values[name][k]])));
}

/** The checks of a signal window, in order; `PresetRefused` (outcome `nothing`) on the first fault. */
export async function checkSignalWindow(
  view: ViewDecl,
  source: FileSource,
  store: SignalStore,
  options: Pick<ModelOptions, "caps" | "sha256" | "checks">,
): Promise<SignalWindow> {
  const caps = options.caps ?? CAPS;
  const signal = (inputOf(view, "signal")?.store ?? {}) as {
    recording?: string;
    content_sha256?: string | null;
  };
  const recipe = (view as { source?: { recipe?: { name?: string } } }).source?.recipe?.name;
  const label = recipe === undefined ? null : recipe.replaceAll("-", "");
  for (const role of ["channels", "badsegments"]) {
    const file = inputOf(view, role)?.file;
    if (!file) continue;
    if (label === null || !tableIsRecordings(file.location, signal.recording ?? "", label, role)) {
      throw new PresetRefused("table_location_mismatch", "nothing");
    }
  }
  const reader = new Reader(view, source, caps, options.sha256 ?? subtleSha256, options.checks);
  const tables: Record<string, Uint8Array> = {};
  for (const role of ["channels", "badsegments"]) {
    const file = inputOf(view, role)?.file;
    if (!file) continue;
    try {
      tables[role] = await reader.verified(file);
    } catch (error) {
      if (error instanceof KindRefused || error instanceof ViewRefused) {
        throw new PresetRefused(error.word, "nothing");
      }
      throw error;
    }
  }
  const declared = signal.content_sha256 ?? null;
  let state: SignalWindow["state"] = "not_checked";
  if (declared !== null && store.published_sha256 !== null) {
    if (declared !== store.published_sha256)
      throw new PresetRefused("store_digest_mismatch", "nothing");
    state = "matches";
  }
  if (!(typeof store.rate === "number" && Number.isFinite(store.rate) && store.rate > 0)) {
    throw new PresetRefused("rate_invalid", "nothing");
  }
  let channels: Record<string, string | number>[] = [];
  let segments: BadSegment[] = [];
  try {
    if (tables.channels) {
      channels = readTable(readTsv(tables.channels), ["name", "status"], [], caps.cells_per_role);
      for (const row of channels) {
        if (!["good", "bad", "n/a"].includes(row.status as string)) {
          throw new KindRefused("channel_status_unknown", String(row.status));
        }
      }
    }
    if (tables.badsegments) {
      segments = readTable(
        readTsv(tables.badsegments),
        ["onset", "duration", "label"],
        ["onset", "duration"],
        caps.cells_per_role,
      ) as unknown as BadSegment[];
      for (const row of segments) {
        if (!(row.duration > 0))
          throw new KindRefused("duration_not_positive", String(row.duration));
      }
    }
  } catch (error) {
    if (error instanceof KindRefused) throw new PresetRefused(error.word, "nothing");
    throw error;
  }
  const bad = channels.filter((row) => row.status === "bad").map((row) => row.name as string);
  for (const name of bad) {
    if (!store.labels.includes(name)) throw new PresetRefused("bad_channel_unknown", "nothing");
  }
  if (tables.channels) {
    const named = new Set(channels.map((row) => row.name));
    for (const name of store.labels) {
      if (!named.has(name as string)) throw new PresetRefused("channel_row_missing", "nothing");
    }
  }
  const parameters = view.parameters as { start_s: number; duration_s: number };
  const { first, count } = windowSamples(
    parameters.start_s,
    parameters.duration_s,
    store.samples,
    store.rate,
  );
  if (count === 0) throw new PresetRefused("window_outside", "nothing");
  return {
    state,
    first,
    count,
    bad_channels: bad,
    segments,
    notes: tables.badsegments ? [] : [NO_BAD_SEGMENT_TABLE],
  };
}
