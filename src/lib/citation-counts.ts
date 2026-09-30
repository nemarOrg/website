/**
 * The front page's "Most cited datasets" ranks from the citation dashboard's
 * own counts manifest, not from the catalog's `num_citations`.
 *
 * The catalog copy is written once a day by nemar-cli's cron, so it trails a
 * nightly run by most of a day, and a dataset that fell to zero used to keep
 * its old count there (the BCCWJ-MEG card read 335 after the gate left it
 * none). The dashboard manifest is what the dashboard itself shows, and it
 * updates within about an hour of the nightly run.
 *
 * The manifest carries ids and counts only, so the names come from the public
 * catalog, which also keeps a dataset that is not public off the card: the
 * dashboard counts every dataset it has a file for, and the catalog answers
 * 404 for one that is not public. The page falls back to the catalog ranking
 * when the manifest cannot be read.
 */
import { getDataset } from "./api";
import { type CitedDataset, mostCited } from "./highlights";
import type { Dataset } from "./types";

export const CITATION_COUNTS_URL = "https://dashboard.nemar.org/citations/api/index.json";

/** Datasets NEMAR hosts: managed (nm) and NEMAR-imported OpenNeuro (on). */
const HOSTED_ID = /^(?:nm|on)\d{6}$/;

/** Extra candidates looked up beyond the list length, so a few that the
 * catalog does not serve (not public yet) do not shorten the card. */
const CANDIDATE_SLACK = 3;

export interface CountRow {
  readonly dataset_id: string;
  readonly num_citations: number;
}

/** The rows of a counts manifest (`nemar-citations/counts@1`). Throws when the
 * body is not one; a malformed row is skipped, not trusted. */
export function parseCountsManifest(body: unknown): CountRow[] {
  const datasets = (body as { datasets?: unknown } | null)?.datasets;
  if (!Array.isArray(datasets)) {
    throw new Error("citation counts manifest has no datasets array");
  }
  const rows: CountRow[] = [];
  for (const row of datasets as Array<Partial<CountRow> | null>) {
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

/** The `limit` best-cited hosted datasets, most cited first. A dataset with
 * nothing counted is left out, as is any id NEMAR does not host. */
export function rankCandidates(rows: readonly CountRow[], limit: number): CountRow[] {
  return rows
    .filter((r) => HOSTED_ID.test(r.dataset_id) && r.num_citations > 0)
    .sort(
      (a, b) =>
        b.num_citations - a.num_citations ||
        (a.dataset_id < b.dataset_id ? -1 : a.dataset_id > b.dataset_id ? 1 : 0),
    )
    .slice(0, limit);
}

export async function fetchCountsManifest(
  init: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CountRow[]> {
  const res = await fetch(CITATION_COUNTS_URL, {
    signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 5000),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`citation counts manifest failed: ${res.status} ${res.statusText}`);
  }
  return parseCountsManifest(await res.json());
}

/** The card's rows: ranked by the dashboard's counts, named by the catalog.
 * The manifest read and the name lookups share one deadline (`timeoutMs`), so
 * a slow dashboard costs the page that long once, not once per request. Throws
 * when nothing can be shown, so the caller can fall back. */
export async function mostCitedFromDashboard(
  limit: number,
  init: { timeoutMs?: number } = {},
): Promise<CitedDataset[]> {
  const signal = AbortSignal.timeout(init.timeoutMs ?? 5000);
  const candidates = rankCandidates(await fetchCountsManifest({ signal }), limit + CANDIDATE_SLACK);
  const looked = await Promise.allSettled(
    candidates.map((c) => getDataset(c.dataset_id, { signal })),
  );
  const named: Dataset[] = [];
  looked.forEach((result, i) => {
    if (result.status === "fulfilled") {
      named.push({ ...result.value, num_citations: candidates[i]?.num_citations ?? 0 });
    }
  });
  if (named.length === 0) {
    throw new Error("no cited dataset from the counts manifest is served by the catalog");
  }
  return mostCited(named, limit);
}
