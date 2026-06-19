import { zarrIndexUrl, zarrStoreUrl } from "./zarr-base";

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
  return { dataset_id: o.dataset_id, format: o.format, stores, failures };
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
): void {
  const url = `${zarrStoreUrl(datasetId, bidsPath)}zarr.json`;
  const urls = [url];
  for (const group of store?.groups ?? []) {
    if (!group.name) continue;
    const base = zarrStoreUrl(datasetId, bidsPath);
    urls.push(`${base}${encodeURIComponent(group.name)}/zarr.json`);
    urls.push(`${base}${encodeURIComponent(group.name)}/0/zarr.json`);
  }
  for (const u of urls) {
    void fetch(u, { headers: { Accept: "application/json" } }).catch(() => {
      // Best-effort warmup only; the real viewer open handles errors.
    });
  }
}
