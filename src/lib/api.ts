import { apiBase } from "./api-base";
import type {
  Dataset,
  DatasetListResponse,
  DatasetQuery,
  DatasetSearchResponse,
  SearchResult,
} from "./types";

/**
 * Project a reduced {@link SearchResult} into a full {@link Dataset} shape.
 * Used as the graceful fallback when per-id hydration of a search hit fails:
 * the card still renders name/modalities/participants/authors/snippet, just
 * without the detail-only facts (size, version, updated). Fields the search
 * projection doesn't carry default to the same null-ish values the catalog
 * ships for sparse rows, which the card and formatters already tolerate.
 */
export function searchResultToDataset(r: SearchResult): Dataset {
  return {
    dataset_id: r.id,
    id: r.id,
    name: r.name,
    description: null,
    status: "active",
    visibility: "public",
    github_repo: null,
    concept_doi: null,
    doi: r.doi,
    created_at: "",
    updated_at: "",
    owner_username: null,
    nemar_sync_status: null,
    source: null,
    source_type: null,
    source_id: null,
    modalities: r.modalities,
    participants: r.participants,
    tasks: r.tasks,
    authors: r.authors,
    file_size: 0,
    file_size_formatted: "",
    latest_version: null,
  };
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
  init: { signal?: AbortSignal } = {},
): Promise<DatasetListResponse> {
  const url = `${apiBase()}/datasets${buildQuery(query)}`;
  const res = await fetch(url, {
    signal: init.signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`[api] listDatasets: ${res.status} ${res.statusText}`);
    throw new Error(`api.nemar.org list datasets failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as DatasetListResponse;
  return json;
}

/**
 * Hybrid lexical+semantic dataset search (nemar-cli#646 Phase 3, closes
 * website#12). Hits GET /datasets/search, which fuses an FTS5 lexical index
 * (typo/stem tolerance, README-body match, author match, `snippet()`
 * highlights) with Vectorize semantic recall via reciprocal rank fusion and
 * returns id-keyed hits ranked by relevance.
 *
 * Unlike {@link listDatasets} this endpoint returns a reduced projection and
 * has NO `offset` support, so callers paginate client-side over the ranked
 * list and hydrate the visible page to full {@link Dataset} rows by id.
 */
export async function searchDatasets(
  q: string,
  init: { limit?: number; signal?: AbortSignal } = {},
): Promise<DatasetSearchResponse> {
  const sp = new URLSearchParams({ q });
  if (init.limit != null) sp.set("limit", String(init.limit));
  const url = `${apiBase()}/datasets/search?${sp.toString()}`;
  const res = await fetch(url, {
    signal: init.signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    // Log before throwing so a backend outage is visible in Worker logs even
    // if the caller's catch only surfaces a sanitized message.
    console.error(`[api] searchDatasets q="${q}": ${res.status} ${res.statusText}`);
    throw new Error(`api.nemar.org search failed: ${res.status} ${res.statusText}`);
  }
  try {
    return (await res.json()) as DatasetSearchResponse;
  } catch {
    // A 2xx with a non-JSON body (e.g. an edge timeout HTML page) lands here.
    console.error(`[api] searchDatasets q="${q}": response body was not valid JSON`);
    throw new Error("api.nemar.org search returned an invalid response");
  }
}

/**
 * Whether `GET /datasets/:id` will accept this id. The catalog detail
 * endpoint only serves managed datasets (`nm*` backend-created, `on*`
 * OpenNeuro mirrors); legacy `ds*` catalog rows return 400 ("Invalid dataset
 * ID format") there and are reached via data.nemar.org / canonical redirect
 * instead. Search hydration uses this to skip doomed per-id fetches for `ds*`
 * hits and render them from the reduced projection.
 */
export function isManagedDatasetId(id: string): boolean {
  return /^(nm|on)\d{6}$/.test(id);
}

export async function getDataset(
  id: string,
  init: { signal?: AbortSignal } = {},
): Promise<Dataset> {
  const url = `${apiBase()}/datasets/${encodeURIComponent(id)}`;
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
  init: { signal?: AbortSignal } = {},
): Promise<string | null> {
  const url = `${apiBase()}/datasets/resolve/${encodeURIComponent(sourceId)}`;
  const res = await fetch(url, {
    signal: init.signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    // 404 is the normal "no mirror" case — skip the log. Anything else
    // is a real upstream blip worth surfacing so degradation is visible.
    if (res.status !== 404) {
      console.warn(`[api] resolveCanonical ${sourceId}: ${res.status} ${res.statusText}`);
    }
    return null;
  }
  const json = (await res.json()) as { found?: boolean; dataset_id?: string };
  return json.found && json.dataset_id ? json.dataset_id : null;
}
