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

export type SortOption = "newest" | "oldest" | "name" | "participants" | "size" | "citations";

export const SORT_OPTIONS: ReadonlyArray<{ value: SortOption; label: string }> = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "name", label: "Name (A-Z)" },
  { value: "participants", label: "Most participants" },
  { value: "size", label: "Largest size" },
  { value: "citations", label: "Most citations" },
];

export type ModalityCode = "EEG" | "MEG" | "iEEG" | "EMG";

export const MODALITY_CODES: ReadonlyArray<ModalityCode> = ["EEG", "MEG", "iEEG", "EMG"];

export type ModalityOp = "AND" | "OR";

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
