import type { LandingPayload, Manifest, NeuroschemaDataset } from "./neuroschema";

const DEFAULT_DATA_BASE = "https://data.nemar.org";

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

export async function getMetadata(
  datasetId: string,
  init: DataApiInit = {},
): Promise<NeuroschemaDataset | null> {
  const url = `${dataBase(init.dataBase)}/${encodeURIComponent(datasetId)}/metadata.json`;
  return jsonFetch<NeuroschemaDataset>(url, init);
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
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener("abort", onParentAbort);
  }
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
 * Tries HEAD, then main, then master, with a few common filename variants.
 * Returns null on any failure. SSR-only — no CORS concerns.
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
  const timeout = init.timeoutMs ?? 3_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  const onParentAbort = () => controller.abort();
  if (init.signal) init.signal.addEventListener("abort", onParentAbort);

  try {
    for (const branch of branches) {
      for (const filename of filenames) {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`;
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (res.ok) return await res.text();
        } catch {
          /* try next combination */
        }
      }
    }
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
