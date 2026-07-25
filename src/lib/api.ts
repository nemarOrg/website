import { apiBase } from "./api-base";
import type {
  Dataset,
  DatasetListResponse,
  DatasetQuery,
  DatasetSearchResponse,
  SearchResult,
} from "./types";

/**
 * Default deadline for the public catalog calls below.
 *
 * These run during SSR of pages a visitor is waiting on, so the ceiling is
 * "how long is it acceptable to stall a render", not "how long might the
 * backend reasonably take".
 */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Combines a caller-supplied abort signal with a deadline (website#173).
 *
 * Every fetch in this file previously passed `signal: init.signal`, which is
 * `undefined` whenever the caller omits it — and none of the page callers
 * pass one. A `try/catch` around `fetch` covers a request that *fails*
 * (refused connection, DNS/TLS error); it does **not** cover one that opens
 * and never writes a response. That promise simply never settles, so there
 * is nothing to catch and nothing to time out.
 *
 * That matters most on `resolveCanonical`: it runs during SSR of every
 * `ds*` dataset page, which after the apex cutover (website#190) is the path
 * every legacy citation URL travels. A hung upstream there stalls the render
 * rather than degrading it.
 */
function resolveSignal(init: { signal?: AbortSignal; timeoutMs?: number }): AbortSignal {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
}

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
    // The hybrid search projection carries no channel/montage facts; leave them
    // null so a search card that filters on density/electrode is simply skipped
    // (the controls are disabled while searching anyway).
    n_channels: null,
    electrode_system: null,
  };
}

/**
 * Backfill a hydrated detail row with fields the search projection carries but
 * the `/datasets/:id` endpoint drops. The list + search endpoints return
 * `participants` and `latest_version`, but the per-id detail endpoint returns
 * them as null (a backend inconsistency, nemar-cli#864). Search cards hydrate
 * via the detail endpoint for the richer fields (description, size, citations),
 * so without this merge they would lose their participant count — exactly the
 * "subjects missing" regression on search results. We keep the detail row's
 * values when present and only fall back to the projection where it left a gap.
 */
export function backfillSearchHit(full: Dataset, hit: SearchResult): Dataset {
  const hasParticipants = typeof full.participants === "number" && full.participants > 0;
  return {
    ...full,
    participants: hasParticipants ? full.participants : hit.participants,
    modalities: full.modalities || hit.modalities,
    tasks: full.tasks || hit.tasks,
    authors: full.authors || hit.authors,
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
  init: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<DatasetListResponse> {
  const url = `${apiBase()}/datasets${buildQuery(query)}`;
  const res = await fetch(url, {
    signal: resolveSignal(init),
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
 * Fetch the full (server-prefiltered) catalog for `query`, paging past the
 * api.nemar.org per-request cap of 200 rows. Used by the browse page when a
 * client-only filter (participant/channel range, multi-modality AND/OR) is
 * active: those filters can't run server-side, so the page must hold the whole
 * result set to filter + paginate it client-side and report an honest count.
 * The first page is fetched serially to learn `total_count`; the rest fan out
 * in parallel. Rows are de-duplicated by id in case the window shifts between
 * requests.
 */
export async function listAllDatasets(
  query: DatasetQuery = {},
  init: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Dataset[]> {
  const PAGE = 200; // api.nemar.org clamps `limit` to 200 per request
  const first = await listDatasets({ ...query, limit: PAGE, offset: 0 }, init);
  const total = first.total_count ?? first.count ?? first.datasets.length;
  const byId = new Map<string, Dataset>();
  for (const d of first.datasets) byId.set(d.dataset_id, d);

  const offsets: number[] = [];
  for (let off = PAGE; off < total; off += PAGE) offsets.push(off);
  if (offsets.length > 0) {
    const pages = await Promise.all(
      offsets.map((off) => listDatasets({ ...query, limit: PAGE, offset: off }, init)),
    );
    for (const p of pages) for (const d of p.datasets) byId.set(d.dataset_id, d);
  }
  return [...byId.values()];
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
  init: { limit?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<DatasetSearchResponse> {
  const sp = new URLSearchParams({ q });
  if (init.limit != null) sp.set("limit", String(init.limit));
  const url = `${apiBase()}/datasets/search?${sp.toString()}`;
  const res = await fetch(url, {
    signal: resolveSignal(init),
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
  init: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Dataset> {
  const url = `${apiBase()}/datasets/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    signal: resolveSignal(init),
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
  init: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const url = `${apiBase()}/datasets/resolve/${encodeURIComponent(sourceId)}`;
  const res = await fetch(url, {
    signal: resolveSignal(init),
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
