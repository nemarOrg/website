import type { QaAggregates } from "./qa";
import { parseLinenoiseDb } from "./qa";

const DEFAULT_DATA_BASE = "https://data.nemar.org";

interface ListingNode {
  kind: "dir" | "file";
  name: string;
}

interface ListingResponse {
  dataset_id: string;
  path: string;
  kind: "directory";
  children: ListingNode[];
  truncated?: boolean;
}

interface PerFileDataqual {
  goodDataPercentRaw?: string | number;
  goodChansPercentRaw?: string | number;
  goodICAPercentRaw?: string | number;
  linenoise_magn?: string | number;
  icaFail?: number;
}

/**
 * The hallu pipeline writes per-file dataqual.json under
 * <id>/qa/sub-XXX/<modality>/<file>_dataqual.json plus a min/max-only
 * dataqual.json at the qa/ root. Phase 3's QualityPanel needs per-file
 * arrays; this walker enumerates the tree and parses each per-file JSON.
 * Returns null when the dataset has no QA tree at all (most datasets
 * today). Skips the root summary file -- it does not have the per-file
 * fields we need.
 */
export async function buildQaAggregates(
  id: string,
  init: { signal?: AbortSignal; dataBase?: string } = {},
): Promise<QaAggregates | null> {
  const base = (init.dataBase ?? DEFAULT_DATA_BASE).replace(/\/$/, "");
  // Directory listings require a trailing slash; the bare path returns a 308
  // redirect that resolves to a 404 path. Keep the unslashed form for
  // child-URL composition and append "/" only at fetch time.
  const root = `${base}/${encodeURIComponent(id)}/qa`;

  const rootDir = await fetchListing(`${root}/`, init.signal);
  if (!rootDir || rootDir.children.length === 0) return null;

  const dataqualUrls = await collectDataqualUrls(root, rootDir, init.signal);
  if (dataqualUrls.length === 0) return null;

  const perFile = await Promise.all(
    dataqualUrls.map((url) => fetchPerFileDataqual(url, init.signal)),
  );

  const valid = perFile.filter((p): p is PerFileDataqual => p != null);
  if (valid.length === 0) return null;

  const goodDataPercent: number[] = [];
  const goodChansPercent: number[] = [];
  const goodICAPercent: number[] = [];
  const linenoiseDb: number[] = [];
  let finished = 0;
  let cleaning = 0;
  let failed = 0;
  let other = 0;

  for (const p of valid) {
    const data = pctNumber(p.goodDataPercentRaw);
    const chans = pctNumber(p.goodChansPercentRaw);
    const ica = pctNumber(p.goodICAPercentRaw);
    const lineNoise = parseLinenoiseDb(p.linenoise_magn);
    if (data != null) goodDataPercent.push(data);
    if (chans != null) goodChansPercent.push(chans);
    if (ica != null) goodICAPercent.push(ica);
    if (lineNoise != null) linenoiseDb.push(lineNoise);

    // icaFail > 0 means the ICA stage failed for that file; everything else
    // we treat as "finished" since hallu only writes dataqual.json on
    // pipeline completion. Future shapes may expose explicit stage state.
    if ((p.icaFail ?? 0) > 0) failed += 1;
    else if (data == null && chans == null) other += 1;
    else if (ica == null) cleaning += 1;
    else finished += 1;
  }

  return {
    files: valid.length,
    pipelineStatus: { finished, cleaning, failed, other },
    goodDataPercent,
    goodChansPercent,
    goodICAPercent,
    linenoiseDb,
    // demographics omitted: hallu doesn't compute participants.tsv aggregates.
  };
}

async function fetchListing(
  url: string,
  signal: AbortSignal | undefined,
): Promise<ListingResponse | null> {
  try {
    const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as ListingResponse;
  } catch {
    return null;
  }
}

async function fetchPerFileDataqual(
  url: string,
  signal: AbortSignal | undefined,
): Promise<PerFileDataqual | null> {
  try {
    const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as PerFileDataqual;
  } catch {
    return null;
  }
}

// Walk the qa tree recursively to find every per-file dataqual.json. BIDS
// structure varies: some datasets are sub-XXX/<modality>/, others are
// sub-XXX/ses-YY/<modality>/. Descend any subdirectory; at every level,
// collect _dataqual.json files. Each level fans out in parallel.
async function collectDataqualUrls(
  qaRoot: string,
  rootDir: ListingResponse,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  // Skip the qa-root summary dataqual.json -- it does not have the per-file
  // fields we need, only min/max aggregates.
  const childDirs = rootDir.children.filter((c) => c.kind === "dir");
  const perSubject = await Promise.all(
    childDirs.map((c) => walkForDataqual(`${qaRoot}/${encodeURIComponent(c.name)}`, signal)),
  );
  return perSubject.flat();
}

async function walkForDataqual(
  url: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const listing = await fetchListing(`${url}/`, signal);
  if (!listing) return [];

  const files = listing.children
    .filter((c) => c.kind === "file" && c.name.endsWith("_dataqual.json"))
    .map((c) => `${url}/${encodeURIComponent(c.name)}`);

  const dirs = listing.children.filter((c) => c.kind === "dir");
  if (dirs.length === 0) return files;

  const nested = await Promise.all(
    dirs.map((d) => walkForDataqual(`${url}/${encodeURIComponent(d.name)}`, signal)),
  );
  return [...files, ...nested.flat()];
}

function pctNumber(raw: string | number | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const n = Number.parseFloat(raw.replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
