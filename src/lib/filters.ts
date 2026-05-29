import { licenseTier } from "./tags";
import {
  type Dataset,
  type DatasetQuery,
  LICENSE_TIERS,
  type LicenseTier,
  MODALITY_CODES,
  type ModalityCode,
  type ModalityOp,
  type SortOption,
} from "./types";

/**
 * Reserved keywords in the search box that auto-toggle a sidebar control.
 * Replicates the legacy /dataexplorer/dataexplorer.js:1415-1427 logic.
 */
const RESERVED_KEYWORDS: Record<string, { kind: "modality" | "flag"; value: string }> = {
  EEG: { kind: "modality", value: "EEG" },
  MEG: { kind: "modality", value: "MEG" },
  IEEG: { kind: "modality", value: "iEEG" },
  EMG: { kind: "modality", value: "EMG" },
  HED: { kind: "flag", value: "hed" },
};

export interface FilterState {
  q: string;
  /** Modalities currently selected. Order preserved. */
  modalities: ModalityCode[];
  /** AND across modalities, or OR (default OR matches legacy default). */
  modalityOp: ModalityOp;
  /** License permissiveness tiers to keep. OR semantics (a dataset has one
   *  license -> one tier). Empty means no license filter. */
  licenseTiers: LicenseTier[];
  /** Comma-separated file format filter (legacy "all" -> ""). */
  fileFormat: string;
  /** Inclusive participant count range. */
  participants: { min: number | null; max: number | null };
  /** Inclusive channel count range. */
  channels: { min: number | null; max: number | null };
  /** Inclusive citation count range. Off by default. */
  citations: { min: number | null; max: number | null };
  hasDataQuality: boolean;
  hasHed: boolean;
  has10_20: boolean;
  sort: SortOption;
  page: number; // 1-based
  pageSize: number;
}

export const DEFAULT_PAGE_SIZE = 10;

export function defaultFilterState(): FilterState {
  return {
    q: "",
    modalities: [],
    modalityOp: "OR",
    licenseTiers: [],
    fileFormat: "",
    participants: { min: null, max: null },
    channels: { min: null, max: null },
    citations: { min: null, max: null },
    hasDataQuality: false,
    hasHed: false,
    has10_20: false,
    sort: "newest",
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  };
}

function parseIntOrNull(value: string | null): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function parseSort(value: string | null): SortOption {
  switch (value) {
    case "oldest":
    case "name":
    case "participants":
    case "size":
      return value;
    default:
      return "newest";
  }
}

function parseLicenseTiers(value: string | null): LicenseTier[] {
  if (!value) return [];
  const result: LicenseTier[] = [];
  for (const raw of value.split(",")) {
    const tier = raw.trim().toLowerCase() as LicenseTier;
    if (LICENSE_TIERS.includes(tier) && !result.includes(tier)) result.push(tier);
  }
  return result;
}

function parseModalities(value: string | null): ModalityCode[] {
  if (!value) return [];
  const candidates = value.split(",").map((s) => s.trim());
  const result: ModalityCode[] = [];
  for (const c of candidates) {
    const norm =
      c.toUpperCase() === "IEEG" ? ("iEEG" as ModalityCode) : (c.toUpperCase() as ModalityCode);
    if (MODALITY_CODES.includes(norm) && !result.includes(norm)) {
      result.push(norm);
    }
  }
  return result;
}

/**
 * Deserialize URL search params into a FilterState. Unknown keys are
 * ignored. Empty input returns the default state.
 */
export function filterStateFromURL(params: URLSearchParams): FilterState {
  const s = defaultFilterState();
  s.q = (params.get("q") ?? "").trim();
  s.modalities = parseModalities(params.get("modality"));
  s.modalityOp = params.get("modality_op") === "AND" ? "AND" : "OR";
  s.licenseTiers = parseLicenseTiers(params.get("license"));
  s.fileFormat = (params.get("format") ?? "").trim();

  s.participants = {
    min: parseIntOrNull(params.get("p_min")),
    max: parseIntOrNull(params.get("p_max")),
  };
  s.channels = {
    min: parseIntOrNull(params.get("c_min")),
    max: parseIntOrNull(params.get("c_max")),
  };
  s.citations = {
    min: parseIntOrNull(params.get("cit_min")),
    max: parseIntOrNull(params.get("cit_max")),
  };

  s.hasDataQuality = params.get("has_qa") === "1";
  s.hasHed = params.get("has_hed") === "1";
  s.has10_20 = params.get("has_1020") === "1";

  s.sort = parseSort(params.get("sort"));

  const page = parseIntOrNull(params.get("page"));
  s.page = page && page > 0 ? page : 1;
  const pageSize = parseIntOrNull(params.get("page_size"));
  if (pageSize && pageSize >= 1 && pageSize <= 100) {
    s.pageSize = pageSize;
  }

  return s;
}

/**
 * Serialize a FilterState back to URL search params, omitting defaults
 * so the URL stays short and shareable.
 */
export function filterStateToURL(state: FilterState): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.q) sp.set("q", state.q);
  if (state.modalities.length > 0) sp.set("modality", state.modalities.join(","));
  if (state.modalityOp !== "OR") sp.set("modality_op", state.modalityOp);
  if (state.licenseTiers.length > 0) sp.set("license", state.licenseTiers.join(","));
  if (state.fileFormat) sp.set("format", state.fileFormat);
  if (state.participants.min != null) sp.set("p_min", String(state.participants.min));
  if (state.participants.max != null) sp.set("p_max", String(state.participants.max));
  if (state.channels.min != null) sp.set("c_min", String(state.channels.min));
  if (state.channels.max != null) sp.set("c_max", String(state.channels.max));
  if (state.citations.min != null) sp.set("cit_min", String(state.citations.min));
  if (state.citations.max != null) sp.set("cit_max", String(state.citations.max));
  if (state.hasDataQuality) sp.set("has_qa", "1");
  if (state.hasHed) sp.set("has_hed", "1");
  if (state.has10_20) sp.set("has_1020", "1");
  if (state.sort !== "newest") sp.set("sort", state.sort);
  if (state.page > 1) sp.set("page", String(state.page));
  if (state.pageSize !== DEFAULT_PAGE_SIZE) sp.set("page_size", String(state.pageSize));
  return sp;
}

/**
 * Map the filter state to the subset of params that api.nemar.org
 * accepts server-side. The remaining fields are post-filtered locally.
 */
export function filterStateToAPIQuery(state: FilterState): DatasetQuery {
  const q: DatasetQuery = { sort: state.sort, limit: 200 };
  if (state.q.trim()) q.search = state.q.trim();
  if (state.modalities.length === 1) {
    // Server-side modality is LIKE substring; only useful when exactly
    // one modality is selected. For OR/AND with multiple modalities,
    // fetch wide and post-filter (cheaper than N round-trips).
    q.modality = state.modalities[0];
  }
  return q;
}

/**
 * Whether the catalog batch carries license data yet. The field arrives via
 * nemar-cli#653; until EVERY row has it, license filtering stays inactive (see
 * `applyClientFilters`). One definition shared by the filter and the Discover
 * notice so they can't drift apart.
 */
function licenseDataReady(datasets: Dataset[]): boolean {
  return datasets.every((d) => d.license !== undefined);
}

/**
 * True when the user selected a license tier but the batch isn't synced yet,
 * so `applyClientFilters` left the license filter inactive. Discover shows a
 * "rolling out" notice for this case instead of silently returning unfiltered
 * results.
 */
export function isLicenseFilterPending(datasets: Dataset[], state: FilterState): boolean {
  return state.licenseTiers.length > 0 && !licenseDataReady(datasets);
}

/**
 * Apply the parts of the filter state that the server can't enforce.
 */
export function applyClientFilters(datasets: Dataset[], state: FilterState): Dataset[] {
  // License filtering activates only once EVERY row in the batch carries the
  // `license` field (present — a null/empty value classifies as the "unknown"
  // tier, which is still filterable). Gating on `every` (not `some`) keeps the
  // filter uniformly inactive across all pages during a partial nemar-cli#653
  // backfill, rather than silently dropping not-yet-synced rows on the pages
  // that happen to contain a few licensed ones.
  const licenseActive = state.licenseTiers.length > 0 && licenseDataReady(datasets);
  return datasets.filter((d) => {
    if (licenseActive && !state.licenseTiers.includes(licenseTier(d.license))) return false;
    // Modality OR/AND when 2+ selected (single modality is already on server).
    if (state.modalities.length > 1) {
      const dsMods = (d.modalities || "")
        .split(",")
        .map((m) => m.trim().toUpperCase())
        .filter(Boolean);
      const selected = state.modalities.map((m) => m.toUpperCase());
      if (state.modalityOp === "AND") {
        for (const m of selected) {
          if (!dsMods.includes(m)) return false;
        }
      } else {
        let any = false;
        for (const m of selected) {
          if (dsMods.includes(m)) {
            any = true;
            break;
          }
        }
        if (!any) return false;
      }
    }
    if (state.participants.min != null && d.participants < state.participants.min) return false;
    if (state.participants.max != null && d.participants > state.participants.max) return false;

    // file_size based filters could land here too if/when a slider exists.
    return true;
  });
}

/**
 * Detect any reserved keyword in a search submit and produce a state
 * patch that flips the corresponding sidebar control while stripping
 * the keyword from the freetext box.
 */
export function applyReservedKeyword(
  state: FilterState,
  rawInput: string,
): { state: FilterState; consumed: boolean } {
  const trimmed = rawInput.trim();
  if (!trimmed) return { state, consumed: false };
  const upper = trimmed.toUpperCase();
  const match = RESERVED_KEYWORDS[upper];
  if (!match) return { state, consumed: false };
  const next: FilterState = { ...state };
  if (match.kind === "modality") {
    const code = match.value as ModalityCode;
    if (!next.modalities.includes(code)) {
      next.modalities = [...next.modalities, code];
    }
  } else if (match.kind === "flag" && match.value === "hed") {
    next.hasHed = true;
  }
  return { state: next, consumed: true };
}
