/**
 * The front page's "Most cited datasets" ranks from the citation dashboard's
 * own counts manifest, not from the catalog's `num_citations`.
 *
 * The catalog copy is written once a day by nemar-cli's cron, so it trails a
 * nightly run by most of a day, and a dataset that left the dashboard manifest
 * kept its old count there (the BCCWJ-MEG card read 335 after the gate left it
 * none). The dashboard manifest is what the dashboard itself shows, and it
 * updates within about an hour of the nightly run.
 *
 * The manifest carries ids and counts only, so the names come from the public
 * catalog rows the page has already downloaded for the hero stats. Those rows
 * are exactly the datasets the catalog lists (public, active, not a sandbox),
 * so a dataset that is not public cannot reach the card, and no extra request
 * is made. When the manifest cannot be used, the same rows rank by the
 * catalog's own counts, as the card did before.
 */
import { CITATION_DASHBOARD_URL, type CitedDataset, mostCited } from "./highlights";
import { resolveSignal } from "./request-deadline";
import { isHostedDataset } from "./stats";
import type { Dataset } from "./types";

export const CITATION_COUNTS_URL = `${CITATION_DASHBOARD_URL}api/index.json`;

/** The manifest schema this code reads; another version falls back to the catalog. */
const COUNTS_SCHEMA = "nemar-citations/counts@1";

export interface CountRow {
  readonly dataset_id: string;
  readonly num_citations: number;
}

/** The rows of a counts manifest. Throws when the body is not a `counts@1`
 * manifest; a malformed row is skipped, not trusted. */
export function parseCountsManifest(body: unknown): CountRow[] {
  const manifest = body as { schema?: unknown; datasets?: unknown } | null;
  if (manifest?.schema !== COUNTS_SCHEMA) {
    throw new Error(`citation counts manifest is not ${COUNTS_SCHEMA}`);
  }
  if (!Array.isArray(manifest.datasets)) {
    throw new Error("citation counts manifest has no datasets array");
  }
  const rows: CountRow[] = [];
  for (const row of manifest.datasets as Array<Partial<CountRow> | null>) {
    if (
      typeof row?.dataset_id === "string" &&
      typeof row.num_citations === "number" &&
      Number.isFinite(row.num_citations)
    ) {
      rows.push({ dataset_id: row.dataset_id, num_citations: row.num_citations });
    }
  }
  return rows;
}

export async function fetchCountsManifest(
  init: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CountRow[]> {
  const res = await fetch(CITATION_COUNTS_URL, {
    signal: resolveSignal(init),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`citation counts manifest failed: ${res.status} ${res.statusText}`);
  }
  return parseCountsManifest(await res.json());
}

export interface MostCitedResult {
  readonly cited: CitedDataset[];
  /** False when the card fell back to the catalog's own counts. */
  readonly fromDashboard: boolean;
}

/**
 * The card's rows. The hosted catalog rows supply the datasets and their
 * names; the manifest (when there is one) supplies the counts, and a dataset
 * the manifest does not list counts as zero, so it is left out. Falls back to
 * the catalog's counts when the manifest is missing or no served dataset has a
 * count above zero (an empty, all-zero or unreadable-row manifest).
 *
 * The manifest is joined on the dataset id alone. nemar-cli's own sync also
 * matches a `ds*` manifest row to its `on*` mirror through `source_id`; no
 * nonzero `ds*` row has a served mirror today, so the card does not.
 */
export function mostCitedRows(
  catalog: readonly Dataset[],
  manifest: readonly CountRow[] | null,
  limit: number,
): MostCitedResult {
  const hosted = catalog.filter(isHostedDataset);
  if (manifest !== null) {
    // The largest count when a manifest lists an id twice.
    const counts = new Map<string, number>();
    for (const r of manifest) {
      counts.set(r.dataset_id, Math.max(counts.get(r.dataset_id) ?? 0, r.num_citations));
    }
    const ranked = mostCited(
      hosted.map((d) => ({ ...d, num_citations: counts.get(d.dataset_id || d.id) ?? 0 })),
      limit,
    );
    if (ranked.length > 0) {
      return { cited: ranked, fromDashboard: true };
    }
  }
  return { cited: mostCited(hosted, limit), fromDashboard: false };
}
