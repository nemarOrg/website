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

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: accept },
    });
    if (res.status === 404) return null;
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

/** Build a download URL for the dataset zip archive at a given version. */
export function archiveZipUrl(datasetId: string, version: string, base?: string): string {
  // The archives live at s3://nemar/<id>/archives/<v>.zip. We route the request
  // through data.nemar.org so the worker can issue a presigned URL on demand.
  // Until the worker exposes /archives, the link points at the legacy
  // download/<id>/<v>.zip path; if that 404s, the UI falls back to the manifest.
  const root = (base ?? dataBase()).replace(/\/$/, "");
  return `${root}/${encodeURIComponent(datasetId)}/${encodeURIComponent(version)}.zip`;
}
