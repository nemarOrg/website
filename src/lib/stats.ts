/**
 * Landing-hero headline stats: how much data NEMAR actually hosts.
 *
 * The catalog (`api.nemar.org/datasets`) mixes two worlds, distinguished by
 * `source_type`:
 *   - `managed`  — datasets NEMAR hosts itself: `nm*` (NEMAR-native) and
 *                  `on*` (OpenNeuro datasets imported into NEMAR storage).
 *   - `catalog`  — `ds*` rows: browsable index entries whose bytes live
 *                  elsewhere (OpenNeuro). NEMAR does NOT host these.
 *
 * The hero advertises *hosted* scale, so it counts only `managed` rows. The
 * full catalog (managed + catalog) is what the Discover page browses, which
 * is deliberately a larger number.
 *
 * The `/datasets` endpoint has no aggregate route and ignores a `source_type`
 * filter, so we page through the whole catalog (~4 calls of 200) and reduce
 * client-side. The landing page is edge-cached, so this fan-out only runs on
 * a cache miss. A server-side aggregate endpoint (filtered by `source_type`)
 * would collapse this to one call — worth filing upstream in nemar-cli.
 */
import { listDatasets } from "./api";
import type { Dataset } from "./types";

export interface HostedStats {
  /** Count of `managed` (nm* + on*) datasets. */
  datasets: number;
  /** Summed participant counts across hosted datasets. */
  participants: number;
  /** Summed `file_size` (bytes) across hosted datasets. */
  size: number;
}

/**
 * True when NEMAR hosts this dataset's bytes (`nm*` native or `on*` imported
 * OpenNeuro mirror). Both carry `source_type: "managed"`; `ds*` catalog rows
 * carry `"catalog"` and are excluded. Falls back to an id-prefix check for
 * snapshots predating the `source_type` column.
 */
export function isHostedDataset(d: Pick<Dataset, "source_type" | "id">): boolean {
  if (d.source_type === "managed") return true;
  if (d.source_type === "catalog") return false;
  return /^(nm|on)\d/.test(d.id ?? "");
}

/** Sum the hosted (`managed`) subset of a catalog page set. Pure + testable. */
export function aggregateHostedStats(rows: Dataset[]): HostedStats {
  const acc: HostedStats = { datasets: 0, participants: 0, size: 0 };
  for (const d of rows) {
    if (!isHostedDataset(d)) continue;
    acc.datasets += 1;
    acc.participants += d.participants ?? 0;
    acc.size += d.file_size ?? 0;
  }
  return acc;
}

const PAGE_SIZE = 200; // api.nemar.org caps a page at 200.

/**
 * Fetch the whole catalog (paged) and aggregate the hosted subset. The first
 * call surfaces `total_count`; remaining pages are fetched in parallel.
 */
export async function fetchHostedStats(init: { signal?: AbortSignal } = {}): Promise<HostedStats> {
  const first = await listDatasets({ limit: PAGE_SIZE, offset: 0 }, init);
  const total = first.total_count ?? first.count ?? first.datasets.length;
  const rows: Dataset[] = [...first.datasets];

  const offsets: number[] = [];
  for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) offsets.push(offset);
  if (offsets.length > 0) {
    const pages = await Promise.all(
      offsets.map((offset) => listDatasets({ limit: PAGE_SIZE, offset }, init)),
    );
    for (const page of pages) rows.push(...page.datasets);
  }

  return aggregateHostedStats(rows);
}
