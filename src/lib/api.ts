import { apiBase } from "./api-base";
import { cachedJson } from "./api-cache";
import type {
  Dataset,
  DatasetListResponse,
  DatasetQuery,
  DatasetSearchResponse,
  SearchFilters,
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
    latest_version_at: null,
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

/** Whether `value` is a plain object, for the shape checks below. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// What each catalog endpoint returns, as far as a stored body must satisfy it
// to be allowed to replace a good one (api-cache.ts). The pages do the detailed
// null-handling; this only keeps `null`, `{}`, and an error envelope out of the
// cache.
const isListResponse = (p: unknown): boolean => isRecord(p) && Array.isArray(p.datasets);
const isSearchResponse = (p: unknown): boolean => isRecord(p) && Array.isArray(p.results);
const isDatasetResponse = (p: unknown): boolean =>
  isRecord(p) && (isRecord(p.dataset) || typeof p.dataset_id === "string");

export async function listDatasets(
  query: DatasetQuery = {},
  init: { signal?: AbortSignal; timeoutMs?: number; fresh?: boolean } = {},
): Promise<DatasetListResponse> {
  const url = `${apiBase()}/datasets${buildQuery(query)}`;
  return cachedJson<DatasetListResponse>(url, {
    signal: resolveSignal(init),
    label: "list datasets",
    accept: isListResponse,
    store: init.fresh ? null : undefined,
  });
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
  init: { signal?: AbortSignal; timeoutMs?: number; fresh?: boolean } = {},
): Promise<Dataset[]> {
  const PAGE = 200; // api.nemar.org clamps `limit` to 200 per request

  const readPages = async (fresh: boolean): Promise<DatasetListResponse[]> => {
    const opts = { ...init, fresh };
    const first = await listDatasets({ ...query, limit: PAGE, offset: 0 }, opts);
    const total = first.total_count ?? first.count ?? first.datasets.length;
    const offsets: number[] = [];
    for (let off = PAGE; off < total; off += PAGE) offsets.push(off);
    const rest = await Promise.all(
      offsets.map((off) => listDatasets({ ...query, limit: PAGE, offset: off }, opts)),
    );
    return [first, ...rest];
  };

  let pages = await readPages(init.fresh ?? false);

  // The pages are cached one by one, so after a partial refresh they can come
  // from different moments, and a row that moved across a page boundary in
  // between would be dropped. Each page reports the catalog's size as of its
  // own moment: if they disagree, read them again past the cache.
  const sizes = new Set(
    pages.map((p) => p.total_count).filter((n): n is number => typeof n === "number"),
  );
  if (sizes.size > 1 && !init.fresh) {
    console.warn(
      `[api] list all datasets: pages disagree on the catalog size (${[...sizes].join(", ")}); reading them again past the cache`,
    );
    try {
      pages = await readPages(true);
    } catch (err) {
      // The API is refusing right now; a list stitched from two moments beats none.
      console.warn(
        `[api] list all datasets: fresh read failed, keeping the mixed pages: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // De-duplicate by id in case the window shifts between requests.
  const byId = new Map<string, Dataset>();
  for (const p of pages) for (const d of p.datasets) byId.set(d.dataset_id, d);
  return [...byId.values()];
}

/**
 * Hybrid lexical+semantic dataset search (nemar-cli#646 Phase 3, closes
 * website#12). Hits GET /datasets/search, which fuses an FTS5 lexical index
 * (typo/stem tolerance, README-body match, author match, `snippet()`
 * highlights) with Vectorize semantic recall via reciprocal rank fusion and
 * returns id-keyed hits ranked by relevance.
 *
 * Unlike {@link listDatasets} this endpoint returns a reduced projection, so
 * callers hydrate the visible page to full {@link Dataset} rows by id. It
 * pages with `limit` (at most 100) and `offset`, and enforces `filters`
 * server-side (nemar-cli#683), so `count` is the true number of matches. It
 * ranks by relevance and ignores `sort`.
 */
export async function searchDatasets(
  q: string,
  init: {
    limit?: number;
    offset?: number;
    filters?: SearchFilters;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<DatasetSearchResponse> {
  const sp = new URLSearchParams({ q });
  // buildQuery drops the filters that are unset and serializes booleans the
  // way the backend accepts them.
  const rest = buildQuery({ ...init.filters, limit: init.limit, offset: init.offset });
  for (const [key, value] of new URLSearchParams(rest)) sp.set(key, value);
  const url = `${apiBase()}/datasets/search?${sp.toString()}`;
  return cachedJson<DatasetSearchResponse>(url, {
    signal: resolveSignal(init),
    label: "search",
    accept: isSearchResponse,
  });
}

/**
 * Whether `GET /datasets/:id` will accept this id. The catalog detail
 * endpoint only serves managed datasets (`nm*` backend-created, `on*`
 * OpenNeuro mirrors, `xx*` sandbox, which on staging includes the exemplar
 * fleet); legacy `ds*` catalog rows return 400 ("Invalid dataset ID format")
 * there and are reached via data.nemar.org / canonical redirect instead. Search
 * hydration uses this to skip doomed per-id fetches for `ds*` hits and render
 * them from the reduced projection. The same three prefixes as the backend's
 * `isValidDatasetId` (nemar-cli `backend/src/services/datasetId.ts`): leaving
 * `xx` out kept every exemplar page on staging from reading its catalog row,
 * so none showed its Zarr tag (nemar-cli#1496).
 */
export function isManagedDatasetId(id: string): boolean {
  return /^(nm|on|xx)\d{6}$/.test(id);
}

/**
 * `fresh: true` reads past the cache. A page that decides who may do what from
 * the row (the collaborators page reads `owner_username`) must not act on a
 * copy that is hours or days old.
 */
export async function getDataset(
  id: string,
  init: { signal?: AbortSignal; timeoutMs?: number; fresh?: boolean } = {},
): Promise<Dataset> {
  const url = `${apiBase()}/datasets/${encodeURIComponent(id)}`;
  // The endpoint returns { dataset: {...} } whereas the list endpoint
  // returns { datasets: [...] }. Unwrap so callers always get a Dataset.
  const raw = await cachedJson<Dataset | { dataset: Dataset }>(url, {
    signal: resolveSignal(init),
    label: "get dataset",
    accept: isDatasetResponse,
    store: init.fresh ? null : undefined,
  });
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
