/**
 * Type shapes for api.nemar.org. Mirrors the response from
 * GET /datasets in nemarOrg/nemar-cli backend/src/routes/datasets.ts.
 */

export interface Dataset {
  dataset_id: string;
  id: string;
  name: string;
  description: string | null;
  status: string;
  visibility: "public" | "private" | string;
  github_repo: string | null;
  concept_doi: string | null;
  doi: string | null;
  created_at: string;
  updated_at: string;
  owner_username: string | null;
  nemar_sync_status: string | null;
  source: "managed" | "catalog" | "nemar.org" | "openneuro" | string | null;
  source_type: "managed" | "catalog" | string | null;
  source_id: string | null;
  modalities: string;
  participants: number;
  tasks: string;
  authors: string;
  file_size: number;
  file_size_formatted: string;
  latest_version: string | null;
  /**
   * Raw license string as returned by api.nemar.org/datasets (e.g. "CC0",
   * "CC-BY-NC-ND-4.0"); backfilled on every catalog row by nemar-cli
   * migration 0034. The website derives the display tier from this via
   * `licenseTier()`; filtering by tier happens server-side through the
   * `?license=` query param. Kept optional for safety against older snapshots.
   */
  license?: string | null;
  // Citation counts from /datasets (nemar-cli #804). Optional until that ships;
  // absent rows render no pill. The per-paper detail is a separate fetch from
  // the citations dashboard API.
  num_citations?: number;
  num_dataset_citations?: number;
  num_datapaper_citations?: number;
}

export interface DatasetListResponse {
  datasets: Dataset[];
  count: number;
  total_count: number;
  limit: number;
  offset: number;
}

/**
 * A single hit from GET /datasets/search (the hybrid lexical+semantic
 * endpoint added in nemar-cli#646 Phase 3). This is a deliberately reduced
 * projection of {@link Dataset}: only ranking-relevant fields are returned,
 * so cards are hydrated to a full Dataset by id before display.
 *
 * `snippet` is the FTS5 `snippet()` highlight (README/body match) wrapped in
 * `<mark>…</mark>`; absent on semantic-only hits with no lexical match.
 */
export interface SearchResult {
  id: string;
  name: string;
  modalities: string;
  participants: number;
  doi: string | null;
  tasks: string;
  authors: string;
  score: number;
  snippet?: string;
}

/**
 * Envelope from GET /datasets/search. `count` is the number of ranked hits,
 * `method` reports which path served the query (`exact_id` | `semantic` |
 * `text_fallback`), and `min_score` is the relevance cutoff applied.
 * The endpoint does NOT support `offset` — pagination is client-side over
 * the ranked list.
 */
export interface DatasetSearchResponse {
  results: SearchResult[];
  count: number;
  method: string;
  min_score: number;
}

export type SortOption = "newest" | "oldest" | "name" | "participants" | "size" | "citations";

export const SORT_OPTIONS: ReadonlyArray<{ value: SortOption; label: string }> = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "name", label: "Name (A-Z)" },
  { value: "participants", label: "Most participants" },
  { value: "size", label: "Largest size" },
  { value: "citations", label: "Most citations" },
];

export type ModalityCode = "EEG" | "MEG" | "iEEG" | "EMG" | "NIRS" | "MOTION";

export const MODALITY_CODES: ReadonlyArray<ModalityCode> = [
  "EEG",
  "MEG",
  "iEEG",
  "EMG",
  "NIRS",
  "MOTION",
];

/**
 * Human-readable label for a modality filter code. Most codes are already the
 * display label (EEG, MEG, ...), but a few carry a friendlier name: NIRS shows
 * as "fNIRS" and MOTION as "Motion". Used by the filter chips so the canonical,
 * match-friendly code stays uppercase while the UI reads naturally.
 */
export const MODALITY_LABELS: Record<ModalityCode, string> = {
  EEG: "EEG",
  MEG: "MEG",
  iEEG: "iEEG",
  EMG: "EMG",
  NIRS: "fNIRS",
  MOTION: "Motion",
};

export type ModalityOp = "AND" | "OR";

/**
 * License permissiveness tiers, most open first. The classification logic
 * (mapping a free-text license string to a tier) lives in src/lib/tags.ts;
 * the type + ordered list live here so both the filter layer (filters.ts)
 * and the tag layer can share one definition.
 */
export type LicenseTier =
  | "public"
  | "attribution"
  | "sharealike"
  | "noncommercial"
  | "noderiv"
  | "unknown";

export const LICENSE_TIERS: ReadonlyArray<LicenseTier> = [
  "public",
  "attribution",
  "sharealike",
  "noncommercial",
  "noderiv",
  "unknown",
];

/**
 * Server-side query params the api.nemar.org /datasets endpoint understands.
 * Fields not in this list (range filters, has-HED toggle, etc.) are applied
 * client-side after the fetch.
 */
export interface DatasetQuery {
  limit?: number;
  offset?: number;
  search?: string;
  modality?: string; // comma-separated, LIKE substring on D1
  /** Comma-separated license tiers; OR semantics, resolved server-side
   *  against the backend's license_tier column (nemar-cli migration 0034). */
  license?: string;
  author?: string;
  task?: string;
  has_doi?: boolean;
  recent?: number; // days
  sort?: SortOption;
}
