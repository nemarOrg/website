import {
  DENSITY_BUCKETS,
  type DatasetQuery,
  type DensityBucket,
  type ElectrodeSystem,
  LICENSE_TIERS,
  type LicenseTier,
  MODALITY_CODES,
  type ModalityCode,
  type ModalityOp,
  type SortOption,
  asDensityBucket,
  asElectrodeSystem,
} from "./types";

/**
 * The structural subset a row needs for client-side filtering. Both the full
 * {@link import("./types").Dataset} and the reduced
 * {@link import("./types").SearchResult} satisfy it, so the freetext-search
 * (hybrid endpoint) and browse (list endpoint) paths share one filter pass.
 * License is NOT here: it's filtered server-side via `?license=` (browse) and
 * unsupported by the hybrid search endpoint (search).
 */
export interface FilterableRow {
  modalities: string;
  participants: number;
  /**
   * Channel/montage facts (nemar-cli#854). Present on full {@link
   * import("./types").Dataset} rows (number-or-null), absent (`undefined`) on
   * the reduced search projection. The filter pass distinguishes the two:
   * `undefined` means "unknown, can't evaluate" (skip the predicate), `null`
   * means "known to have no scalp montage" (excluded by a positive filter).
   */
  n_channels?: number | null;
  electrode_system?: string | null;
}

/**
 * Reserved keywords in the search box that auto-toggle a sidebar control.
 * Replicates the legacy /dataexplorer/dataexplorer.js:1415-1427 logic.
 */
const RESERVED_KEYWORDS: Record<string, { kind: "modality" | "flag"; value: string }> = {
  EEG: { kind: "modality", value: "EEG" },
  MEG: { kind: "modality", value: "MEG" },
  IEEG: { kind: "modality", value: "iEEG" },
  EMG: { kind: "modality", value: "EMG" },
  NIRS: { kind: "modality", value: "NIRS" },
  MOTION: { kind: "modality", value: "MOTION" },
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
  /** Inclusive channel count range (raw `c_min`/`c_max`; power-user URLs). */
  channels: { min: number | null; max: number | null };
  /** Channel-density preset (sidebar). Expands to an `n_channels` range. */
  density: DensityBucket | "";
  /** Electrode-system class to keep. "" means no electrode-system filter. */
  electrodeSystem: ElectrodeSystem | "";
  /** Inclusive citation count range. Off by default. */
  citations: { min: number | null; max: number | null };
  hasDataQuality: boolean;
  hasHed: boolean;
  /** Only converted-to-Zarr datasets (nemar-cli#1181 phase 2); server-side
   *  `?has_zarr=1`, mirroring `hasHed`'s round trip. */
  hasZarr: boolean;
  /** Only datasets whose Zarr copy passed the standing fidelity sweep
   *  (nemar-cli#1181 phase 8); server-side `?has_zarr_verified=1`. A strict
   *  narrowing of `hasZarr`, not a replacement for it. */
  hasZarrVerified: boolean;
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
    density: "",
    electrodeSystem: "",
    citations: { min: null, max: null },
    hasDataQuality: false,
    hasHed: false,
    hasZarr: false,
    hasZarrVerified: false,
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
    case "citations":
      return value;
    default:
      return "newest";
  }
}

// The sidebar's checkbox groups submit as REPEATED params on a native GET
// form (?license=a&license=b), while our own links comma-join (?license=a,b).
// Both arrive here via getAll(): each array element is split on comma so the
// two encodings parse identically. Reading only params.get() would silently
// drop every selection after the first.
function parseLicenseTiers(values: string[]): LicenseTier[] {
  const result: LicenseTier[] = [];
  for (const raw of values) {
    for (const part of raw.split(",")) {
      const tier = part.trim().toLowerCase() as LicenseTier;
      if (!tier) continue;
      if (LICENSE_TIERS.includes(tier) && !result.includes(tier)) result.push(tier);
    }
  }
  return result;
}

function parseModalities(values: string[]): ModalityCode[] {
  const result: ModalityCode[] = [];
  for (const raw of values) {
    for (const part of raw.split(",")) {
      const c = part.trim();
      if (!c) continue;
      const norm =
        c.toUpperCase() === "IEEG" ? ("iEEG" as ModalityCode) : (c.toUpperCase() as ModalityCode);
      if (MODALITY_CODES.includes(norm) && !result.includes(norm)) {
        result.push(norm);
      }
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
  s.modalities = parseModalities(params.getAll("modality"));
  s.modalityOp = params.get("modality_op") === "AND" ? "AND" : "OR";
  s.licenseTiers = parseLicenseTiers(params.getAll("license"));
  s.fileFormat = (params.get("format") ?? "").trim();

  s.participants = {
    min: parseIntOrNull(params.get("p_min")),
    max: parseIntOrNull(params.get("p_max")),
  };
  s.channels = {
    min: parseIntOrNull(params.get("c_min")),
    max: parseIntOrNull(params.get("c_max")),
  };
  s.density = asDensityBucket(params.get("density")) ?? "";
  s.electrodeSystem = asElectrodeSystem(params.get("es")) ?? "";
  s.citations = {
    min: parseIntOrNull(params.get("cit_min")),
    max: parseIntOrNull(params.get("cit_max")),
  };

  s.hasDataQuality = params.get("has_qa") === "1";
  s.hasHed = params.get("has_hed") === "1";
  s.hasZarr = params.get("has_zarr") === "1";
  s.hasZarrVerified = params.get("has_zarr_verified") === "1";

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
  if (state.density) sp.set("density", state.density);
  if (state.electrodeSystem) sp.set("es", state.electrodeSystem);
  if (state.citations.min != null) sp.set("cit_min", String(state.citations.min));
  if (state.citations.max != null) sp.set("cit_max", String(state.citations.max));
  if (state.hasDataQuality) sp.set("has_qa", "1");
  if (state.hasHed) sp.set("has_hed", "1");
  if (state.hasZarr) sp.set("has_zarr", "1");
  if (state.hasZarrVerified) sp.set("has_zarr_verified", "1");
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
  if (state.licenseTiers.length > 0) {
    // License filters server-side (OR semantics) against the backend's
    // license_tier column (nemar-cli migration 0034). Doing it here keeps the
    // count + pagination accurate, which per-page client filtering could not.
    q.license = state.licenseTiers.join(",");
  }
  if (state.hasHed) {
    // #869: server-side `?has_hed=1` (the backend filters on datasets.has_hed = 1,
    // excluding 0 and NULL). buildQuery serializes the boolean to `has_hed=true`,
    // which the backend accepts alongside `1`. Server-side keeps count/pagination
    // accurate, like license.
    q.has_hed = true;
  }
  if (state.hasZarr) {
    // nemar-cli#1181 phase 2: same `has_hed` convention, `?has_zarr=1`/`true`.
    // Sent unconditionally even though production's /datasets doesn't
    // understand it yet (the epic branch ships it; production catches up on
    // its own release cadence) -- an unrecognized query param is just
    // ignored server-side, so this degrades to "no filter applied" rather
    // than an error, and the toggle starts working the moment the backend
    // does with no frontend change.
    q.has_zarr = true;
  }
  if (state.hasZarrVerified) {
    // nemar-cli#1181 phase 8. Same production-lag note as has_zarr above.
    q.has_zarr_verified = true;
  }
  return q;
}

/**
 * Apply the parts of the filter state that the server can't enforce. Generic
 * over the row shape so it serves both browse (full Dataset) and freetext
 * search (reduced SearchResult) rows — see {@link FilterableRow}. License is
 * intentionally NOT here: browse filters it server-side via `?license=`, and
 * the hybrid search endpoint doesn't support it at all.
 */
export function applyClientFilters<T extends FilterableRow>(
  datasets: T[],
  state: FilterState,
  opts: { allModalitiesClientSide?: boolean } = {},
): T[] {
  return datasets.filter((d) => {
    // Modality OR/AND. In browse mode a single modality is already enforced
    // server-side, so we only post-filter when 2+ are selected. In search
    // mode the hybrid endpoint doesn't filter by modality, so the caller sets
    // `allModalitiesClientSide` to enforce even a single selection here.
    const modalityThreshold = opts.allModalitiesClientSide ? 1 : 2;
    if (state.modalities.length >= modalityThreshold) {
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

    // Channel count: the density preset expands to a range, and raw c_min/c_max
    // apply independently. Both read `n_channels` (nemar-cli#854). A row whose
    // `n_channels` is `undefined` came from the reduced search projection, which
    // carries no channel facts — skip the predicate rather than drop the row.
    // A row that is `null` is known to have no scalp channel count, so a
    // positive channel filter excludes it.
    const bucket = state.density ? DENSITY_BUCKETS[state.density] : null;
    const channelMin = bucket ? bucket.min : state.channels.min;
    const channelMax = bucket ? bucket.max : state.channels.max;
    const channelFilterActive = bucket != null || channelMin != null || channelMax != null;
    if (channelFilterActive && d.n_channels !== undefined) {
      if (d.n_channels == null) return false;
      if (channelMin != null && d.n_channels < channelMin) return false;
      if (channelMax != null && d.n_channels > channelMax) return false;
    }

    // Electrode system: exact class match. Same undefined/null contract as above.
    if (state.electrodeSystem && d.electrode_system !== undefined) {
      if (d.electrode_system !== state.electrodeSystem) return false;
    }

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
