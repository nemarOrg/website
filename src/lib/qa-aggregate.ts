import type { QaAggregates } from "./qa";
import { parseLinenoiseDb } from "./qa";

const DEFAULT_DATA_BASE = "https://data.nemar.org";
// Cap simultaneous per-file fetches so a 200-subject dataset doesn't saturate
// data.nemar.org (triggering 429s) or graze Cloudflare Worker subrequest
// ceilings. 25 is comfortable below both and keeps cold-call latency reasonable.
const PER_FILE_CONCURRENCY = 25;

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
 *
 * pipelineStatus classification is a heuristic over field presence: hallu
 * doesn't emit an explicit stage flag, so a future shape change that drops
 * goodDataPercentRaw on a finished file would silently land in `other`.
 * Worth a re-think when hallu#511 follow-ups expose explicit state.
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

  const perFile = await fetchBatched(dataqualUrls, init.signal);
  const valid = perFile.filter((p): p is PerFileDataqual => p != null);
  if (valid.length === 0) return null;
  if (valid.length < dataqualUrls.length) {
    console.warn(
      `[qa-aggregate] ${id}: ${valid.length}/${dataqualUrls.length} per-file dataquals fetched; aggregate may be incomplete`,
    );
  }

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

// Fetch URLs in bounded-concurrency batches. Order preservation matters for
// nothing here (the aggregates are reduced, not aligned), but the simple
// chunked approach keeps the implementation small and dependency-free.
async function fetchBatched(
  urls: string[],
  signal: AbortSignal | undefined,
): Promise<(PerFileDataqual | null)[]> {
  const out: (PerFileDataqual | null)[] = [];
  for (let i = 0; i < urls.length; i += PER_FILE_CONCURRENCY) {
    const batch = urls.slice(i, i + PER_FILE_CONCURRENCY);
    const results = await Promise.all(batch.map((u) => fetchPerFileDataqual(u, signal)));
    out.push(...results);
  }
  return out;
}

async function fetchListing(
  url: string,
  signal: AbortSignal | undefined,
): Promise<ListingResponse | null> {
  try {
    const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[qa-aggregate] listing ${url}: ${res.status} ${res.statusText}`);
      return null;
    }
    const body = (await res.json()) as ListingResponse;
    // A truncated listing means the walker silently saw a partial subtree.
    // Better to surface it than to serve an under-counted aggregate.
    if (body.truncated) {
      console.warn(`[qa-aggregate] listing truncated at ${url}; aggregate may be incomplete`);
    }
    return body;
  } catch (err) {
    console.warn(`[qa-aggregate] listing ${url}: ${(err as Error).message ?? err}`);
    return null;
  }
}

async function fetchPerFileDataqual(
  url: string,
  signal: AbortSignal | undefined,
): Promise<PerFileDataqual | null> {
  try {
    const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[qa-aggregate] file ${url}: ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as PerFileDataqual;
  } catch (err) {
    console.warn(`[qa-aggregate] file ${url}: ${(err as Error).message ?? err}`);
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
