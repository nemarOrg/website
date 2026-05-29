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
   * License string for the dataset. NOT yet returned by api.nemar.org/datasets
   * (it lives only in per-dataset metadata.json today) — optional here so the
   * license filter lights up automatically once nemar-cli backfills it into
   * the catalog row. See the backend dependency note in AGENTS.md.
   */
  license?: string | null;
}

export interface DatasetListResponse {
  datasets: Dataset[];
  count: number;
  total_count: number;
  limit: number;
  offset: number;
}

export type SortOption = "newest" | "oldest" | "name" | "participants" | "size";

export const SORT_OPTIONS: ReadonlyArray<{ value: SortOption; label: string }> = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "name", label: "Name (A-Z)" },
  { value: "participants", label: "Most participants" },
  { value: "size", label: "Largest size" },
];

export type ModalityCode = "EEG" | "MEG" | "iEEG" | "EMG";

export const MODALITY_CODES: ReadonlyArray<ModalityCode> = ["EEG", "MEG", "iEEG", "EMG"];

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
  author?: string;
  task?: string;
  has_doi?: boolean;
  recent?: number; // days
  sort?: SortOption;
}
