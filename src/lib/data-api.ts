import type { LandingPayload, Manifest, NeuroschemaDataset } from "./neuroschema";

const DEFAULT_DATA_BASE = "https://data.nemar.org";

export interface SummaryTotals {
  files?: number;
  bytes?: number;
  subjects?: number;
}

export interface SummaryReadme {
  path?: string;
}

export interface Summary {
  schema_version?: string;
  dataset_id: string;
  version: string;
  doi?: string;
  concept_doi?: string;
  created?: string;
  totals?: SummaryTotals;
  modalities?: string[];
  subjects?: string[];
  readme?: SummaryReadme;
  paths: string[];
}

function dataBase(envOverride?: string): string {
  if (envOverride) return envOverride.replace(/\/$/, "");
  const fromEnv =
    (typeof import.meta.env !== "undefined" && import.meta.env.PUBLIC_DATA_BASE_URL) || null;
  return (fromEnv ?? DEFAULT_DATA_BASE).replace(/\/$/, "");
}

export interface DataApiInit {
  signal?: AbortSignal;
  dataBase?: string;
  timeoutMs?: number;
}

async function jsonFetch<T>(
  url: string,
  init: DataApiInit,
  accept = "application/json",
): Promise<T | null> {
  const controller = new AbortController();
  const timeout = init.timeoutMs ?? 5_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  const onParentAbort = () => controller.abort();
  if (init.signal) init.signal.addEventListener("abort", onParentAbort);

  async function attempt(): Promise<Response> {
    return fetch(url, { signal: controller.signal, headers: { Accept: accept } });
  }

  try {
    let res = await attempt();
    if (res.status === 429) {
      // Rate-limited. Wait the Retry-After header (or 1s default) and try once more.
      const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "1", 10);
      const waitMs = Math.min(Math.max(retryAfter, 1) * 1000, 5_000);
      await new Promise((r) => setTimeout(r, waitMs));
      res = await attempt();
    }
    if (res.status === 404) return null;
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      // Treat persistent rate-limiting / upstream errors as "data unavailable"
      // rather than 500ing the entire page. The caller renders an empty state.
      console.warn(`data.nemar.org ${url}: ${res.status} ${res.statusText}; rendering empty state`);
      return null;
    }
    if (!res.ok) {
      throw new Error(`data.nemar.org ${url}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener("abort", onParentAbort);
  }
}

export async function getLanding(
  datasetId: string,
  init: DataApiInit = {},
): Promise<LandingPayload | null> {
  const url = `${dataBase(init.dataBase)}/${encodeURIComponent(datasetId)}/`;
  return jsonFetch<LandingPayload>(url, init);
}

/**
 * Returns true when the landing payload indicates the dataset has no published
 * version yet.
 *
 * Returns false on null — a missing/unreachable dataset is distinct from an
 * unpublished one and we don't want to mask 404/5xx as "not yet published."
 *
 * Uses OR (either signal missing → unpublished) rather than AND because the
 * conservative call is to show "not yet published" briefly during a publish
 * race; the alternative (treating an inconsistent payload as published) lets
 * the caller fall through to the manifest path and surface the 5s-timeout-500
 * symptom we are specifically trying to fix.
 */
export function isUnpublished(landing: LandingPayload | null): boolean {
  if (!landing) return false;
  return !landing.latest || landing.versions.length === 0;
}

export async function getMetadata(
  datasetId: string,
  init: DataApiInit = {},
): Promise<NeuroschemaDataset | null> {
  const url = `${dataBase(init.dataBase)}/${encodeURIComponent(datasetId)}/metadata.json`;
  return jsonFetch<NeuroschemaDataset>(url, init);
}

export async function getSummary(
  datasetId: string,
  version: string,
  init: DataApiInit = {},
): Promise<Summary | null> {
  const url = `${dataBase(init.dataBase)}/${encodeURIComponent(datasetId)}/${encodeURIComponent(
    version,
  )}/summary.json`;
  return jsonFetch<Summary>(url, { ...init, timeoutMs: init.timeoutMs ?? 1_500 });
}

export async function getManifest(
  datasetId: string,
  version: string,
  init: DataApiInit = {},
): Promise<Manifest | null> {
  const url = `${dataBase(init.dataBase)}/${encodeURIComponent(datasetId)}/${encodeURIComponent(
    version,
  )}/manifest.json`;
  return jsonFetch<Manifest>(url, init);
}

/**
 * Fetch the bytes behind a presigned manifest entry URL (used for README).
 * Returns null if absent or the fetch times out.
 */
export async function fetchManifestEntryText(
  url: string,
  init: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = init.timeoutMs ?? 3_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  const onParentAbort = () => controller.abort();
  if (init.signal) init.signal.addEventListener("abort", onParentAbort);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[data-api] manifest entry ${url}: ${res.status} ${res.statusText}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`[data-api] manifest entry ${url}: ${(err as Error).message ?? err}`);
    return null;
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Locate the README path in a summary. Priority:
 *   1. Explicit `summary.readme.path` (the publisher's authoritative pick,
 *      may point at a non-root README like `docs/README.md`)
 *   2. Root-level README in `summary.paths` matched case-insensitively
 *      against {readme.md, readme, readme.txt}. Subdirectory READMEs are
 *      intentionally NOT matched here — BIDS treats only the root one
 *      as the dataset README.
 */
export function findReadmePathInSummary(summary: Summary): string | null {
  if (summary.readme?.path) return summary.readme.path;
  const candidates = ["readme.md", "readme", "readme.txt"];
  for (const p of summary.paths) {
    if (candidates.includes(p.toLowerCase())) return p;
  }
  return null;
}

/** Find the README entry in a manifest by case-insensitive name match. */
export function findReadmeEntry(manifest: Manifest): Manifest[number] | null {
  const candidates = ["readme.md", "readme", "readme.txt"];
  for (const entry of manifest) {
    const lower = entry.path.toLowerCase();
    if (candidates.includes(lower)) return entry;
  }
  return null;
}

/**
 * Best-effort fetch of the README from the dataset's GitHub repo, used when
 * the data.nemar.org manifest doesn't list one (git-annex manifests typically
 * carry annexed content only, not git-tracked files like README.md at root).
 * Races HEAD/main/master across README.md/README/README.txt/readme.md in
 * parallel; first 200 wins. Returns null on any failure. SSR-only — no CORS.
 */
export async function fetchGithubReadme(
  githubUrl: string,
  init: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const match = /github\.com\/([^/]+)\/([^/?#]+)/.exec(githubUrl);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/, "");
  const branches = ["HEAD", "main", "master"];
  const filenames = ["README.md", "README", "README.txt", "readme.md"];

  const controller = new AbortController();
  const timeout = init.timeoutMs ?? 1_500;
  const timer = setTimeout(() => controller.abort(), timeout);
  const onParentAbort = () => controller.abort();
  if (init.signal) init.signal.addEventListener("abort", onParentAbort);

  const urls: string[] = [];
  for (const branch of branches) {
    for (const filename of filenames) {
      urls.push(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`);
    }
  }

  try {
    return await Promise.any(
      urls.map(async (url) => {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`${url}: ${res.status}`);
        return res.text();
      }),
    );
  } catch (err) {
    // AggregateError when all 12 candidate URLs fail; flatten its inner
    // errors so a GitHub outage or rename leaves a triageable tail-log
    // entry instead of a silent null.
    const detail =
      err instanceof AggregateError
        ? err.errors.map((e) => (e as Error).message).join(" | ")
        : ((err as Error).message ?? String(err));
    console.warn(`[data-api] github readme ${owner}/${repo}: ${detail}`);
    return null;
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener("abort", onParentAbort);
  }
}

/** Build a download URL for the dataset zip archive at a given version. */
export function archiveZipUrl(datasetId: string, version: string, base?: string): string {
  // The archives live at s3://nemar/<id>/archives/<v>.zip. We route the request
  // through data.nemar.org so the worker can issue a presigned URL on demand.
  // Until the worker exposes /archives, the link points at the legacy
  // download/<id>/<v>.zip path; if that 404s, the UI falls back to the manifest.
  const root = (base ?? dataBase()).replace(/\/$/, "");
  return `${root}/${encodeURIComponent(datasetId)}/${encodeURIComponent(version)}.zip`;
}
