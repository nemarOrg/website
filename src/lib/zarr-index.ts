import { zarrCacheToken, zarrIndexUrl, zarrKeyUrl, zarrStoreUrl } from "./zarr-base";

/**
 * biosigIO's per-file account of what the BIDS `channels.tsv` `units` column
 * did (biosigio#125, schema `store.units_report`). Republished in index.json
 * so a unit that could NOT be adopted is visible without opening the store.
 * Parsed loosely (passthrough-cast, like `groups` below) since the viewer
 * only ever reads `kept_importer_unit`.
 */
export interface ZarrUnitsReport {
  converted?: number;
  relabelled?: number;
  kept_importer_unit?: number;
  units_column_present?: boolean;
  sidecar?: string;
  sidecar_supplied?: boolean;
}

export interface ZarrIndexStore {
  path: string;
  zarr: string;
  groups?: Array<{
    name?: string;
    view_levels?: unknown;
    viewLevels?: unknown;
    n_channels?: number | null;
  }>;
  /** v3 only. Always "raw" today (ADR 0027 discovery is raw-only). */
  source_tree?: string;
  /** v3 only. True for a processed signal (e.g. an ADR 0028 SSS MEG store). */
  derived?: boolean;
  /** v3 only. Absent on a v1 store or when no channels.tsv applies. */
  units_report?: ZarrUnitsReport;
  /** v3 only. True when an applicable channels.tsv exists but could not be
   *  read, so the store carries the importer's units rather than the
   *  sidecar's. Distinct from an absent `units_report`. */
  channels_tsv_read_error?: boolean;
}

/**
 * A recording the producer could not convert, for a reason that is a property of
 * the DATA (a trial-averaged/epoched derivative, a corrupt/truncated file, an
 * unsupported format). The producer (`scripts/zarr/generate_zarr.py`) records
 * these so the viewer can explain *why* there is no viewer instead of a blank
 * "not available". Transient/infra failures are NOT listed here (they retry
 * as a `pending` entry on v3 — see {@link ZarrIndexPending}), so on a v1
 * index a recording absent from both `stores` and `failures` is simply still
 * generating.
 */
export interface ZarrIndexFailure {
  path: string;
  zarr?: string;
  code?: string;
  reason?: string;
  /** v3 only. Operator-facing cause (exception class + first message line,
   *  paths stripped) — what makes an opaque `file_read_error` diagnosable. */
  detail?: string | null;
  /** v3 only. Conversion attempts before this recording was given up on. */
  attempts?: number;
}

/** The three reasons `generate_zarr.py` records for a v3 `pending` entry.
 *  Kept as a type for documentation; {@link ZarrIndexPending.reason} stays a
 *  plain string so a producer-side addition degrades to "unrecognized"
 *  rather than a parse failure (see `zarrCoverage`'s `unknownPending`). */
export type ZarrPendingReason = "infra_failure" | "memory_budget" | "not_attempted";

/**
 * A v3-only entry for a discovered recording with no store YET that is still
 * expected to convert (schema `$defs.pending`). Recorded rather than omitted
 * so every raw recording is accounted for — before v3 these were silently
 * absent from both `stores` and `failures`, indistinguishable from "still
 * generating" forever.
 */
export interface ZarrIndexPending {
  path: string;
  zarr?: string;
  reason: string;
  attempts: number;
  last_error?: string | null;
  last_attempt_utc?: string | null;
}

interface ZarrIndexCommon {
  dataset_id: string;
  format: string;
  stores: ZarrIndexStore[];
  failures: ZarrIndexFailure[];
  /**
   * When the producer last wrote this index — the cache-busting token for every
   * store URL under it (#240). It changes on every conversion run, which
   * `source_commit` does NOT: a re-conversion at the same dataset commit (the
   * nemarOrg/nemar-cli#1068 fidelity rebuild, exactly) would reuse the commit
   * and bust nothing. Empty for an older index that predates the field, which
   * degrades to the pre-#240 URL (no token) rather than breaking.
   */
  updated_utc: string;
}

/** The index format production and staging still serve today. Every reader
 *  must keep accepting it alongside v3 until the engine-bump wave finishes. */
export interface ZarrIndexV1 extends ZarrIndexCommon {
  format_version: 1;
}

/**
 * format_version 3 (nemarOrg/nemar-cli#1181/#1197; schema at
 * `GET /schemas/zarr-index-v3.json`, mirrored at
 * `epic-zarr-serving/shared/zarr-index.schema.json`). Adds `discovered_count`
 * + `pending[]` (coverage), failure `detail` (diagnosis), and top-level
 * dataset provenance hoisted from the catalog row. `discovered_count ==
 * store_count + failure_count + pending_count` is the producer's own
 * invariant; a document missing/mistyping it degrades to that same sum
 * (`errors` and other run-only counters are not carried — nothing here reads
 * them). Additional top-level fields the schema defines (`contract_base`,
 * `data_base`, `layout`, ...) are intentionally not modeled: no current
 * consumer needs them, and the schema is CLOSED so an unknown field would
 * fail producer-side validation before it ever reaches a client — this
 * parser still ignores anything it doesn't recognize, same as v1.
 */
export interface ZarrIndexV3 extends ZarrIndexCommon {
  format_version: 3;
  discovered_count: number;
  pending: ZarrIndexPending[];
  doi?: string | null;
  license?: string | null;
  citation?: string | null;
  hed_version?: string | null;
}

export type ZarrIndex = ZarrIndexV1 | ZarrIndexV3;

function parseGroups(raw: unknown): ZarrIndexStore["groups"] {
  return Array.isArray(raw)
    ? (raw.filter((g) => g && typeof g === "object") as ZarrIndexStore["groups"])
    : undefined;
}

function parseUnitsReport(raw: unknown): ZarrUnitsReport | undefined {
  return raw && typeof raw === "object" ? (raw as ZarrUnitsReport) : undefined;
}

function parseStores(raw: unknown): ZarrIndexStore[] {
  const stores: ZarrIndexStore[] = [];
  if (!Array.isArray(raw)) return stores;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const s = entry as Record<string, unknown>;
    if (typeof s.path !== "string" || typeof s.zarr !== "string") continue;
    stores.push({
      path: s.path,
      zarr: s.zarr,
      groups: parseGroups(s.groups),
      source_tree: typeof s.source_tree === "string" ? s.source_tree : undefined,
      derived: typeof s.derived === "boolean" ? s.derived : undefined,
      units_report: parseUnitsReport(s.units_report),
      channels_tsv_read_error:
        typeof s.channels_tsv_read_error === "boolean" ? s.channels_tsv_read_error : undefined,
    });
  }
  return stores;
}

// `failures` is optional (older indexes predate it).
function parseFailures(raw: unknown): ZarrIndexFailure[] {
  const failures: ZarrIndexFailure[] = [];
  if (!Array.isArray(raw)) return failures;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const f = entry as Record<string, unknown>;
    if (typeof f.path !== "string") continue;
    failures.push({
      path: f.path,
      zarr: typeof f.zarr === "string" ? f.zarr : undefined,
      code: typeof f.code === "string" ? f.code : undefined,
      reason: typeof f.reason === "string" ? f.reason : undefined,
      detail: typeof f.detail === "string" ? f.detail : null,
      attempts: typeof f.attempts === "number" ? f.attempts : undefined,
    });
  }
  return failures;
}

// `pending` is v3-only and, per ADR 0005 (partial data still serves), treated
// the same tolerant way as `failures`: absent or malformed degrades to an
// empty list rather than rejecting the whole document.
function parsePending(raw: unknown): ZarrIndexPending[] {
  const pending: ZarrIndexPending[] = [];
  if (!Array.isArray(raw)) return pending;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const p = entry as Record<string, unknown>;
    if (typeof p.path !== "string") continue;
    pending.push({
      path: p.path,
      zarr: typeof p.zarr === "string" ? p.zarr : undefined,
      reason: typeof p.reason === "string" ? p.reason : "unknown",
      attempts: typeof p.attempts === "number" ? p.attempts : 0,
      last_error: typeof p.last_error === "string" ? p.last_error : null,
      last_attempt_utc: typeof p.last_attempt_utc === "string" ? p.last_attempt_utc : null,
    });
  }
  return pending;
}

function parseUpdatedUtc(o: Record<string, unknown>): string {
  // An index that simply predates the field is expected and silent. A field that
  // is PRESENT but unusable -- wrong type, or punctuation-only so it sanitizes to
  // nothing -- means the producer regressed, and would disable cache-busting for
  // this dataset with no other symptom than the #240 bug quietly coming back. The
  // producer has emitted `updated_utc` since the pipeline's first commit, so in
  // practice this branch IS the regression detector, not the legacy path.
  if (typeof o.updated_utc === "string") {
    if (o.updated_utc !== "" && zarrCacheToken(o.updated_utc) === "") {
      console.warn(
        `[zarr-index] ${o.dataset_id}: updated_utc "${o.updated_utc}" sanitizes to empty; viewer cache-busting disabled for this dataset`,
      );
    }
    return o.updated_utc;
  }
  if (o.updated_utc !== undefined) {
    console.warn(
      `[zarr-index] ${o.dataset_id}: updated_utc has type ${typeof o.updated_utc}, expected string; viewer cache-busting disabled for this dataset`,
    );
  }
  return "";
}

/**
 * Parse a `index.json` document into the discriminated {@link ZarrIndex}
 * shape, or null for a document too malformed to use at all (missing
 * `dataset_id`/`format`/`stores`). Anything else -- an absent optional
 * field, an unrecognized `format_version`, an unknown top-level or nested
 * field -- degrades gracefully rather than rejecting the document (ADR
 * 0005): `format_version` anything other than exactly `3` parses as v1, so
 * this keeps accepting the index production and staging still serve today.
 */
export function parseZarrIndex(raw: unknown): ZarrIndex | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.dataset_id !== "string" || typeof o.format !== "string") return null;
  if (!Array.isArray(o.stores)) return null;

  const stores = parseStores(o.stores);
  const failures = parseFailures(o.failures);
  const updated_utc = parseUpdatedUtc(o);

  if (o.format_version === 3) {
    const pending = parsePending(o.pending);
    const discovered_count =
      typeof o.discovered_count === "number"
        ? o.discovered_count
        : stores.length + failures.length + pending.length;
    return {
      dataset_id: o.dataset_id,
      format: o.format,
      format_version: 3,
      stores,
      failures,
      pending,
      updated_utc,
      discovered_count,
      doi: typeof o.doi === "string" ? o.doi : null,
      license: typeof o.license === "string" ? o.license : null,
      citation: typeof o.citation === "string" ? o.citation : null,
      hed_version: typeof o.hed_version === "string" ? o.hed_version : null,
    };
  }

  return {
    dataset_id: o.dataset_id,
    format: o.format,
    format_version: 1,
    stores,
    failures,
    updated_utc,
  };
}

/**
 * Recording-coverage summary for the dataset-page panel (website#277). Pure
 * and index-only, so it works from an already-fetched index with no new API
 * calls.
 */
export interface ZarrCoverage {
  /** Recordings with a served store — a working viewer. */
  viewable: number;
  /** Recordings that will not convert without a data or converter change. */
  failed: number;
  /** Recordings with no store yet but still expected to convert. Always 0
   *  on a v1 index (it doesn't report pending recordings at all). */
  pending: number;
  /** Raw recordings discovered at `source_commit` — the coverage
   *  denominator. Null on v1, which doesn't report this; callers fall back
   *  to `viewable + failed` and say so (decision in website#277). */
  discovered: number | null;
  /** `failures[]` grouped by machine `code`, in first-seen order. Every
   *  entry in a group shares the same viewer-safe `reason` (it's derived
   *  from the code), so a caller reads it off `entries[0]`. */
  byFailureCode: Record<string, ZarrIndexFailure[]>;
  /** `pending[]` grouped by `reason`, in first-seen order. Empty on v1. */
  byPendingReason: Record<string, ZarrIndexPending[]>;
  /** True when a pending entry's `reason` isn't one of the three the
   *  producer currently documents (infra_failure/memory_budget/
   *  not_attempted) — a forward-compat signal, not an error. */
  unknownPending: boolean;
}

const KNOWN_PENDING_REASONS: ReadonlySet<string> = new Set([
  "infra_failure",
  "memory_budget",
  "not_attempted",
] satisfies ZarrPendingReason[]);

export function zarrCoverage(index: ZarrIndex): ZarrCoverage {
  const pendingList = index.format_version === 3 ? index.pending : [];

  const byFailureCode: Record<string, ZarrIndexFailure[]> = {};
  for (const f of index.failures) {
    const code = f.code ?? "unknown";
    if (!byFailureCode[code]) byFailureCode[code] = [];
    byFailureCode[code].push(f);
  }

  const byPendingReason: Record<string, ZarrIndexPending[]> = {};
  let unknownPending = false;
  for (const p of pendingList) {
    if (!byPendingReason[p.reason]) byPendingReason[p.reason] = [];
    byPendingReason[p.reason].push(p);
    if (!KNOWN_PENDING_REASONS.has(p.reason)) unknownPending = true;
  }

  return {
    viewable: index.stores.length,
    failed: index.failures.length,
    pending: pendingList.length,
    discovered: index.format_version === 3 ? index.discovered_count : null,
    byFailureCode,
    byPendingReason,
    unknownPending,
  };
}

const GENERIC_UNITS_NOTICE =
  "Units are the file's own; the dataset's channels.tsv unit could not be adopted.";

function unitsNoticeSentence(n: number): string {
  return `Units are the file's own; the dataset's channels.tsv unit could not be adopted for ${n} channel${n === 1 ? "" : "s"}.`;
}

/**
 * One-line viewer notice (website#277 decision 4) for a store whose units did
 * NOT come from the dataset's own `channels.tsv`: either some channels kept
 * the importer's raw unit (`units_report.kept_importer_unit > 0`), or the
 * sidecar that applies to this recording exists but could not be read
 * (`channels_tsv_read_error`) — in which case the WHOLE recording falls back
 * to the importer's unit, so the channel count is the store's own total
 * (summed across `groups[].n_channels`) rather than a report-derived count.
 * Null when neither condition holds, or the store/report is absent entirely
 * (a v1 store, or a path with no store at all) — nothing to warn about.
 */
export function unitsNoticeText(store: ZarrIndexStore | null | undefined): string | null {
  if (!store) return null;
  const kept = store.units_report?.kept_importer_unit;
  if (typeof kept === "number" && kept > 0) {
    return unitsNoticeSentence(kept);
  }
  if (store.channels_tsv_read_error) {
    const total = store.groups?.reduce(
      (sum, g) => (typeof g.n_channels === "number" ? sum + g.n_channels : sum),
      0,
    );
    return total ? unitsNoticeSentence(total) : GENERIC_UNITS_NOTICE;
  }
  return null;
}

export function zarrAvailablePaths(index: ZarrIndex): Set<string> {
  return new Set(index.stores.map((s) => s.path));
}

export function zarrStoreByPath(index: ZarrIndex): Map<string, ZarrIndexStore> {
  return new Map(index.stores.map((s) => [s.path, s]));
}

/**
 * Map BIDS recording path -> producer-supplied reason it has no viewer. Keyed by
 * both the recording `path` and (as a fallback) the store-relative `zarr` path,
 * so a lookup by either resolves the reason.
 */
export function zarrFailureReasonByPath(index: ZarrIndex): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of index.failures) {
    if (!f.reason) continue;
    m.set(f.path, f.reason);
    if (f.zarr) m.set(f.zarr, f.reason);
  }
  return m;
}

/**
 * BIDS source paths of every v3 `pending` entry (empty on v1, which doesn't
 * report pending recordings at all). Mirrors `zarrAvailablePaths` /
 * `zarrFailureReasonByPath`'s shape so a caller can recognize a recording
 * regardless of which of the three buckets it's currently in -- notably a
 * directory recording (a 4D/BTi store with no name-derived extension) that
 * is still pending: without this, the tree's dir-recognition pass has no
 * way to know that ordinary-looking directory is a recording at all, and
 * the coverage panel's jump link for it resolves to nothing (PR #278
 * review).
 */
export function zarrPendingPaths(index: ZarrIndex): Set<string> {
  if (index.format_version !== 3) return new Set();
  return new Set(index.pending.map((p) => p.path));
}

export async function fetchZarrIndex(datasetId: string): Promise<ZarrIndex | null> {
  try {
    const res = await fetch(zarrIndexUrl(datasetId), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    return parseZarrIndex(await res.json());
  } catch {
    return null;
  }
}

export function prefetchZarrStoreMetadata(
  datasetId: string,
  bidsPath: string,
  store?: ZarrIndexStore,
  token = "",
): void {
  // Must carry the same token the viewer will use, or the warmup primes URLs
  // the real open never requests -- and `zarrKeyUrl`, not concatenation, because
  // a tokened store URL ends in `?v=...` (#240).
  const base = zarrStoreUrl(datasetId, bidsPath, { token });
  const urls = [zarrKeyUrl(base, "zarr.json")];
  for (const group of store?.groups ?? []) {
    if (!group.name) continue;
    urls.push(zarrKeyUrl(base, `${encodeURIComponent(group.name)}/zarr.json`));
    urls.push(zarrKeyUrl(base, `${encodeURIComponent(group.name)}/0/zarr.json`));
  }
  for (const u of urls) {
    void fetch(u, { headers: { Accept: "application/json" } }).catch(() => {
      // Best-effort warmup only; the real viewer open handles errors.
    });
  }
}
