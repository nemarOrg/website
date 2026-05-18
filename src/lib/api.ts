import type { Dataset, DatasetListResponse, DatasetQuery } from "./types";

const DEFAULT_API_BASE = "https://api.nemar.org";

/**
 * Resolve the API base URL at call time. Cloudflare Pages exposes env vars
 * via runtime; falling back to PUBLIC_API_BASE_URL for local dev.
 */
function apiBase(envOverride?: string): string {
  if (envOverride) return envOverride.replace(/\/$/, "");
  const fromEnv =
    (typeof import.meta.env !== "undefined" && import.meta.env.PUBLIC_API_BASE_URL) || null;
  return (fromEnv ?? DEFAULT_API_BASE).replace(/\/$/, "");
}

function buildQuery(params: DatasetQuery): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "boolean") {
      sp.set(key, value ? "true" : "false");
    } else {
      sp.set(key, String(value));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export async function listDatasets(
  query: DatasetQuery = {},
  init: { signal?: AbortSignal; apiBase?: string } = {},
): Promise<DatasetListResponse> {
  const url = `${apiBase(init.apiBase)}/datasets${buildQuery(query)}`;
  const res = await fetch(url, {
    signal: init.signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`api.nemar.org list datasets failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as DatasetListResponse;
  return json;
}

export async function getDataset(
  id: string,
  init: { signal?: AbortSignal; apiBase?: string } = {},
): Promise<Dataset> {
  const url = `${apiBase(init.apiBase)}/datasets/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    signal: init.signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`api.nemar.org get dataset failed: ${res.status} ${res.statusText}`);
  }
  // The endpoint returns { dataset: {...} } whereas the list endpoint
  // returns { datasets: [...] }. Unwrap so callers always get a Dataset.
  const raw = (await res.json()) as Dataset | { dataset: Dataset };
  return "dataset" in raw ? raw.dataset : raw;
}

/**
 * Resolve an OpenNeuro source id (ds*) to its canonical NEMAR dataset id (on*),
 * when a mirror exists in the catalog. Returns null when the id has no mirror
 * yet or the endpoint is unreachable -- callers should treat null as
 * "no canonical, render as-is".
 */
export async function resolveCanonical(
  sourceId: string,
  init: { signal?: AbortSignal; apiBase?: string } = {},
): Promise<string | null> {
  const url = `${apiBase(init.apiBase)}/datasets/resolve/${encodeURIComponent(sourceId)}`;
  const res = await fetch(url, {
    signal: init.signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    return null;
  }
  const json = (await res.json()) as { found?: boolean; dataset_id?: string };
  return json.found && json.dataset_id ? json.dataset_id : null;
}
