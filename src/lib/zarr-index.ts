import { zarrCacheToken, zarrIndexUrl, zarrKeyUrl, zarrStoreUrl } from "./zarr-base";

export interface ZarrIndexStore {
  path: string;
  zarr: string;
  groups?: Array<{ name?: string; view_levels?: unknown; viewLevels?: unknown }>;
}

/**
 * A recording the producer could not convert, for a reason that is a property of
 * the DATA (a trial-averaged/epoched derivative, a corrupt/truncated file, an
 * unsupported format). The producer (`scripts/zarr/generate_zarr.py`) records
 * these so the viewer can explain *why* there is no viewer instead of a blank
 * "not available". Transient/infra failures are NOT listed (they retry), so a
 * recording absent from both `stores` and `failures` is simply still generating.
 */
export interface ZarrIndexFailure {
  path: string;
  zarr?: string;
  code?: string;
  reason?: string;
}

export interface ZarrIndex {
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

export function parseZarrIndex(raw: unknown): ZarrIndex | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.dataset_id !== "string" || typeof o.format !== "string") return null;
  if (!Array.isArray(o.stores)) return null;
  const stores: ZarrIndexStore[] = [];
  for (const entry of o.stores) {
    if (!entry || typeof entry !== "object") continue;
    const s = entry as Record<string, unknown>;
    if (typeof s.path !== "string" || typeof s.zarr !== "string") continue;
    stores.push({
      path: s.path,
      zarr: s.zarr,
      groups: Array.isArray(s.groups)
        ? (s.groups.filter((g) => g && typeof g === "object") as ZarrIndexStore["groups"])
        : undefined,
    });
  }
  // `failures` is optional (older indexes predate it).
  const failures: ZarrIndexFailure[] = [];
  if (Array.isArray(o.failures)) {
    for (const entry of o.failures) {
      if (!entry || typeof entry !== "object") continue;
      const f = entry as Record<string, unknown>;
      if (typeof f.path !== "string") continue;
      failures.push({
        path: f.path,
        zarr: typeof f.zarr === "string" ? f.zarr : undefined,
        code: typeof f.code === "string" ? f.code : undefined,
        reason: typeof f.reason === "string" ? f.reason : undefined,
      });
    }
  }
  // An index that simply predates the field is expected and silent. A field that
  // is PRESENT but unusable -- wrong type, or punctuation-only so it sanitizes to
  // nothing -- means the producer regressed, and would disable cache-busting for
  // this dataset with no other symptom than the #240 bug quietly coming back. The
  // producer has emitted `updated_utc` since the pipeline's first commit, so in
  // practice this branch IS the regression detector, not the legacy path.
  let updated_utc = "";
  if (typeof o.updated_utc === "string") {
    updated_utc = o.updated_utc;
    if (o.updated_utc !== "" && zarrCacheToken(o.updated_utc) === "") {
      console.warn(
        `[zarr-index] ${o.dataset_id}: updated_utc "${o.updated_utc}" sanitizes to empty; viewer cache-busting disabled for this dataset`,
      );
    }
  } else if (o.updated_utc !== undefined) {
    console.warn(
      `[zarr-index] ${o.dataset_id}: updated_utc has type ${typeof o.updated_utc}, expected string; viewer cache-busting disabled for this dataset`,
    );
  }

  return { dataset_id: o.dataset_id, format: o.format, stores, failures, updated_utc };
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
