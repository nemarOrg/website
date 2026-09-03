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
   * EEG channel count, derived during enrichment (measured `channels.tsv` EEG
   * count, with the `*_eeg.json` `EEGChannelCount` sidecar as fallback);
   * nemar-cli#854. NULL for non-EEG datasets and EEG rows not yet probed —
   * keep it optional + nullable (sparse `on*`/legacy rows ship null).
   */
  n_channels?: number | null;
  /**
   * Electrode-system class: "10-20" | "10-10" | "10-05" | "biosemi" |
   * "egi-geodesic" | "other" (nemar-cli#854). NULL when no scalp montage was
   * resolvable. Filtering by it is client-side (the catalog API has no
   * server-side param for it — verified prod).
   */
  electrode_system?: string | null;
  /**
   * HED (Hierarchical Event Descriptors) presence of the latest version
   * (nemar-cli#869): 1 = has HED annotations, 0 = checked/none, NULL = not yet
   * classified. Filterable server-side via `?has_hed=1`. Optional + nullable
   * since older snapshots and unswept rows ship null.
   */
  has_hed?: number | null;
  /** Declared `HEDVersion` of the latest version (nemar-cli#869), or null. */
  hed_version?: string | null;
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
  /**
   * The standing Zarr fidelity verification sweep's verdict (nemar-cli#1181
   * phase 8, issue #1068): null until the daily sweep reaches a
   * freshly-converted dataset, or when it has no Zarr copy at all. Drives
   * the coverage badge (website#277) — see `tags.ts`'s `ZARR_VERIFY_*`
   * lookups for the label/tooltip per status.
   */
  zarr_verify_status?: "verified" | "failed" | "unverifiable" | null;
  /**
   * Zarr conversion state (nemar-cli#1181, ADR 0033/0034): "ready" once at
   * least one store has been produced. Combined with `zarr_store_count > 0`
   * this is the documented definition of `has_zarr` — see AGENTS.md. Optional
   * + nullable since older snapshots and never-converted rows ship null.
   */
  zarr_status?: string | null;
  /** Number of Zarr stores produced for this dataset's latest conversion.
   *  Zero or null means no viewable Zarr copy yet, regardless of `zarr_status`. */
  zarr_store_count?: number | null;
  /**
   * Absolute URL of this dataset's `index.json` (format v3's mandatory entry
   * point), derived server-side. Non-null only when `zarr_status` is "ready".
   * Null/absent falls back to `zarrIndexUrl(id)` in `lib/zarr-base.ts`.
   */
  zarr_index_url?: string | null;
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
 * Electrode-system classes emitted by the catalog's channel/montage enrichment
 * (nemar-cli#854, `Dataset.electrode_system`). The values are the exact strings
 * the backend stores; the labels are the display text for the discover filter.
 */
export type ElectrodeSystem = "10-20" | "10-10" | "10-05" | "biosemi" | "egi-geodesic" | "other";

export const ELECTRODE_SYSTEMS: ReadonlyArray<{ value: ElectrodeSystem; label: string }> = [
  { value: "10-20", label: "10-20" },
  { value: "10-10", label: "10-10" },
  { value: "10-05", label: "10-05" },
  { value: "biosemi", label: "BioSemi" },
  { value: "egi-geodesic", label: "EGI geodesic" },
  { value: "other", label: "Other" },
];

const ELECTRODE_SYSTEM_VALUES: ReadonlySet<string> = new Set(ELECTRODE_SYSTEMS.map((s) => s.value));

/** Narrow an arbitrary string to a known {@link ElectrodeSystem}, else null. */
export function asElectrodeSystem(value: string | null | undefined): ElectrodeSystem | null {
  return value && ELECTRODE_SYSTEM_VALUES.has(value) ? (value as ElectrodeSystem) : null;
}

/**
 * Channel-density presets for the discover sidebar. Each bucket maps to an
 * inclusive `n_channels` range; the sidebar exposes these instead of raw
 * min/max inputs because users think in cap classes, not channel counts.
 */
export type DensityBucket = "low" | "standard" | "high" | "hd";

export const DENSITY_BUCKETS: Record<
  DensityBucket,
  { min: number | null; max: number | null; label: string }
> = {
  low: { min: null, max: 32, label: "Low (≤32)" },
  standard: { min: 33, max: 64, label: "Standard (33–64)" },
  high: { min: 65, max: 128, label: "High (65–128)" },
  hd: { min: 129, max: null, label: "High-density (129+)" },
};

/** Narrow an arbitrary string to a known {@link DensityBucket}, else null. */
export function asDensityBucket(value: string | null | undefined): DensityBucket | null {
  return value && value in DENSITY_BUCKETS ? (value as DensityBucket) : null;
}

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
  /** Only datasets with HED annotations; server-side `?has_hed=1` (nemar-cli#869). */
  has_hed?: boolean;
  /** Only converted-to-Zarr datasets; server-side `?has_zarr=1`
   *  (nemar-cli#1181 phase 2). */
  has_zarr?: boolean;
  /** Only datasets whose Zarr copy passed the fidelity sweep; server-side
   *  `?has_zarr_verified=1` (nemar-cli#1181 phase 8). */
  has_zarr_verified?: boolean;
  recent?: number; // days
  sort?: SortOption;
}
