/**
 * Types and client for the `data.nemar.org/<id>/qa/*` endpoints.
 * The backend aggregation endpoint is tracked at nemarOrg/nemar-cli#511;
 * QualityPanel renders an empty state for datasets without an existing
 * qa/ tree, so no frontend changes are needed when that ships.
 */

/**
 * Dataset-level QA aggregate, precomputed by the hallu sync (#511 deliverable).
 * Arrays carry one entry per analyzed .set file; charts compute their own
 * bins/buckets from the raw arrays.
 */
export interface QaAggregates {
  /** Number of .set files analyzed (== length of every per-file array below). */
  files: number;
  pipelineStatus: {
    finished: number;
    cleaning: number;
    failed: number;
    other: number;
  };
  /** Per-file: percent of data frames retained after cleaning (0-100). */
  goodDataPercent: number[];
  /** Per-file: percent of channels retained after rejection (0-100). */
  goodChansPercent: number[];
  /** Per-file: percent of ICs flagged as brain components (0-100). */
  goodICAPercent: number[];
  /** Per-file: line-noise magnitude at 60Hz, in dB. */
  linenoiseDb: number[];
  /** Optional: derived from participants.tsv enrichment. */
  demographics?: {
    ages: number[];
    sexes: Array<"M" | "F" | "O" | null>;
  };
}

/**
 * Min/max ranges from hallu's existing `dataqual.json`. Kept for completeness;
 * the website mostly prefers the richer aggregates above.
 */
export interface QaSummary {
  goodDataPercentMin: number;
  goodDataPercentMax: number;
  goodChansPercentMin: number;
  goodChansPercentMax: number;
  goodICAPercentMin: number;
  goodICAPercentMax: number;
}

/**
 * Per-file QA summary from hallu — JSON sibling to each .set file.
 * Numeric fields are stringified (e.g. "609,120"); raw fields are the
 * unformatted percentages the charts need.
 */
export interface FileQa {
  nGoodData: string;
  goodDataPercent: string;
  goodDataPercentRaw: string;
  nGoodChans: number;
  goodChansPercent: string;
  goodChansPercentRaw: string;
  icaFail: number;
  nICs: number;
  nGoodICs: number;
  goodICA: string;
  goodICAPercentRaw: string;
  /** e.g. "14.40dB" — needs parsing to a number for chart axes. */
  linenoise_magn: string;
}

/** HED token-frequency map for the wordcloud. */
export interface HedSummary {
  eventFiles: number;
  totalEvents: number;
  tags: Array<{
    tag: string;
    count: number;
    category?: string;
  }>;
}

/** The 5 SVG plots produced per .set file by the hallu pipeline. */
export const FILE_PLOT_KINDS = [
  "eegplot_mid-sample",
  "icaact",
  "icahist",
  "icamaps",
  "spectopo",
] as const;
export type FilePlotKind = (typeof FILE_PLOT_KINDS)[number];

export const FILE_PLOT_LABELS: Record<FilePlotKind, string> = {
  "eegplot_mid-sample": "Cleaned scalp channel data (mid 2-sec window)",
  icaact: "Independent component activations",
  icahist: "Independent component histogram",
  icamaps: "Independent component topomaps",
  spectopo: "Channel log spectra with topomaps",
};

const DEFAULT_DATA_BASE = "https://data.nemar.org";

function dataBase(envOverride?: string): string {
  if (envOverride) return envOverride.replace(/\/$/, "");
  const fromEnv =
    (typeof import.meta.env !== "undefined" && import.meta.env.PUBLIC_DATA_BASE_URL) || null;
  return (fromEnv ?? DEFAULT_DATA_BASE).replace(/\/$/, "");
}

interface FetchInit {
  signal?: AbortSignal;
  timeoutMs?: number;
  dataBase?: string;
}

async function jsonOrNull<T>(url: string, init: FetchInit): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 4_000);
  const onParentAbort = () => controller.abort();
  if (init.signal) init.signal.addEventListener("abort", onParentAbort);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      console.warn(`QA fetch ${url}: ${res.status} ${res.statusText}; rendering empty state`);
      return null;
    }
    if (!res.ok) {
      throw new Error(`QA fetch ${url}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`QA fetch ${url} failed:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener("abort", onParentAbort);
  }
}

export async function getQaSummary(id: string, init: FetchInit = {}): Promise<QaSummary | null> {
  return jsonOrNull<QaSummary>(
    `${dataBase(init.dataBase)}/${encodeURIComponent(id)}/qa/dataqual.json`,
    init,
  );
}

export async function getQaAggregates(
  id: string,
  init: FetchInit = {},
): Promise<QaAggregates | null> {
  // hallu emits per-file dataqual.json files but no pre-computed aggregate.
  // The aggregator walks the tree and builds QaAggregates at request time;
  // [id].astro's Cache-Control absorbs the fan-out cost for repeat visits.
  const { buildQaAggregates } = await import("./qa-aggregate");
  return buildQaAggregates(id, init);
}

export async function getFileQa(
  id: string,
  bidsPath: string,
  init: FetchInit = {},
): Promise<FileQa | null> {
  // bidsPath ends with the .set basename; the per-file QA sibling is
  // <basename>_dataqual.json in the same dir, mirrored under qa/.
  const stripped = bidsPath.replace(/\.set$/, "");
  return jsonOrNull<FileQa>(
    `${dataBase(init.dataBase)}/${encodeURIComponent(id)}/qa/${encodePath(stripped)}_dataqual.json`,
    init,
  );
}

export async function getHedSummary(id: string, init: FetchInit = {}): Promise<HedSummary | null> {
  return jsonOrNull<HedSummary>(
    `${dataBase(init.dataBase)}/${encodeURIComponent(id)}/qa/hed-summary.json`,
    init,
  );
}

/** Build the public URL for one of the 5 per-file plots. */
export function filePlotUrl(
  id: string,
  bidsPath: string,
  kind: FilePlotKind,
  base?: string,
): string {
  const stripped = bidsPath.replace(/\.set$/, "");
  const root = (base ?? dataBase()).replace(/\/$/, "");
  return `${root}/${encodeURIComponent(id)}/qa/${encodePath(stripped)}_${kind}.svg`;
}

function encodePath(p: string): string {
  return p
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

// -----------------------------------------------------------------------------
// Pure helpers used by the chart components (unit-tested in qa.test.ts).
// -----------------------------------------------------------------------------

/** Parse "14.40dB" → 14.4. Returns null on malformed input. */
export function parseLinenoiseDb(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const m = /-?\d+(\.\d+)?/.exec(raw);
  return m ? Number(m[0]) : null;
}

/**
 * Build histogram bins from a numeric array.
 * @param values - numeric samples
 * @param binCount - number of bins (default 10)
 * @param domain - optional [min, max]; defaults to data range
 * @returns array of { label, lo, hi, count }
 */
export interface HistogramBin {
  lo: number;
  hi: number;
  label: string;
  count: number;
}

export function buildHistogram(
  values: number[],
  binCount = 10,
  domain?: [number, number],
): HistogramBin[] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [];
  const min = domain?.[0] ?? Math.min(...finite);
  const max = domain?.[1] ?? Math.max(...finite);
  if (min === max) {
    return [{ lo: min, hi: max, label: `${min}`, count: finite.length }];
  }
  const step = (max - min) / binCount;
  const bins: HistogramBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lo = min + i * step;
    const hi = i === binCount - 1 ? max : lo + step;
    bins.push({
      lo,
      hi,
      label: `${Math.round(lo)}-${Math.round(hi)}`,
      count: 0,
    });
  }
  for (const v of finite) {
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((v - min) / step)));
    bins[idx].count++;
  }
  return bins;
}

/**
 * Bucket ages into 10-year ranges (e.g., 0-9, 10-19, ...), split by sex.
 */
export interface AgeBucket {
  label: string;
  lo: number;
  hi: number;
  M: number;
  F: number;
  O: number;
}

export function bucketAgesBySex(
  ages: number[],
  sexes: Array<"M" | "F" | "O" | null>,
  bucketWidth = 10,
): AgeBucket[] {
  const validAges = ages.filter((a) => Number.isFinite(a) && a >= 0);
  if (validAges.length === 0) return [];
  const max = Math.max(...validAges);
  const top = Math.ceil((max + 1) / bucketWidth) * bucketWidth;
  const buckets: AgeBucket[] = [];
  for (let lo = 0; lo < top; lo += bucketWidth) {
    const hi = lo + bucketWidth - 1;
    buckets.push({ label: `${lo}-${hi}`, lo, hi, M: 0, F: 0, O: 0 });
  }
  for (let i = 0; i < ages.length; i++) {
    const a = ages[i];
    if (!Number.isFinite(a) || a < 0) continue;
    const idx = Math.min(buckets.length - 1, Math.floor(a / bucketWidth));
    const sex = sexes[i] ?? "O";
    if (sex === "M") buckets[idx].M++;
    else if (sex === "F") buckets[idx].F++;
    else buckets[idx].O++;
  }
  return buckets;
}
