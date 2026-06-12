import { zarrIndexUrl, zarrStoreUrl } from "./zarr-base";

export interface ZarrIndexStore {
  path: string;
  zarr: string;
  groups?: Array<{ name?: string; view_levels?: unknown; viewLevels?: unknown }>;
}

export interface ZarrIndex {
  dataset_id: string;
  format: string;
  stores: ZarrIndexStore[];
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
  return { dataset_id: o.dataset_id, format: o.format, stores };
}

export function zarrAvailablePaths(index: ZarrIndex): Set<string> {
  return new Set(index.stores.map((s) => s.path));
}

export function zarrStoreByPath(index: ZarrIndex): Map<string, ZarrIndexStore> {
  return new Map(index.stores.map((s) => [s.path, s]));
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
