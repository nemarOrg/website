/**
 * The two dataset columns of the landing page's highlights section: the
 * most cited datasets and the latest ones (website#371). Pure, so the
 * ranking and the dates are unit-tested; the page does the fetching.
 */
import { splitModalities } from "./format";
import { isHostedDataset } from "./stats";
import type { Dataset } from "./types";

/** The citation tracker's public dashboard (nemarOrg/nemar-citations). */
export const CITATION_DASHBOARD_URL = "https://dashboard.nemar.org/citations/";

/** A dataset's page on the citation dashboard: every citing work, with confidence. */
export function citationDashboardUrl(datasetId: string): string {
  return `${CITATION_DASHBOARD_URL}dataset/${encodeURIComponent(datasetId)}/`;
}

/**
 * A catalog timestamp as a Date.
 *
 * The catalog serves SQLite's `YYYY-MM-DD HH:MM:SS`, which is UTC but carries
 * no zone, and `new Date()` reads a zoneless date-time as local time. A
 * Worker runs in UTC so the server would get it right by accident, while a
 * test run or a browser in San Diego would be seven hours off. Values that
 * already carry a zone (RFC3339) parse as they are.
 */
export function parseCatalogTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(trimmed);
  const date = new Date(zoneless ? `${trimmed.replace(" ", "T")}Z` : trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface CitedDataset {
  readonly id: string;
  readonly name: string;
  readonly citations: number;
  /** This dataset's count as a fraction of the top count, for the bar under it. */
  readonly share: number;
  readonly href: string;
}

/** Ascending by dataset id: a total order for datasets with equal counts. */
function compareIds(a: Dataset, b: Dataset): number {
  const x = a.dataset_id || a.id;
  const y = b.dataset_id || b.id;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The top `limit` datasets by `num_citations`, most cited first, from any rows
 * (the landing page passes catalog rows whose counts may be the dashboard's,
 * see citation-counts.ts). Sorted here whatever the input order, because the
 * order is what the column claims. Datasets with the same count are ordered by
 * id, so which of several tied datasets shows does not depend on the order the
 * catalog happened to return them in. Rows with no citations are left out: a
 * zero in a "most cited" list says nothing.
 */
export function mostCited(rows: readonly Dataset[], limit: number): CitedDataset[] {
  const ranked = rows
    .map((d) => ({ d, citations: d.num_citations ?? 0 }))
    .filter(({ citations }) => Number.isFinite(citations) && citations > 0)
    .sort((a, b) => b.citations - a.citations || compareIds(a.d, b.d))
    .slice(0, limit);
  const top = ranked[0]?.citations ?? 0;
  return ranked.map(({ d, citations }) => ({
    id: d.dataset_id || d.id,
    name: d.name?.trim() || d.dataset_id || d.id,
    citations,
    share: top > 0 ? citations / top : 0,
    href: citationDashboardUrl(d.dataset_id || d.id),
  }));
}

export interface LatestDataset {
  readonly id: string;
  readonly name: string;
  readonly modalities: readonly string[];
  readonly participants: number | null;
  readonly publishedAt: Date | null;
  readonly href: string;
}

/** Modalities worth a tag in a compact row: `BEH` and `ANAT` describe companions, not the recording. */
const COMPANION_MODALITIES: ReadonlySet<string> = new Set(["BEH", "ANAT"]);

/**
 * The newest `limit` datasets NEMAR hosts, from rows the API sorted with
 * `sort=newest`. `ds*` catalog pointers are skipped: they are OpenNeuro's
 * datasets, listed here for search, not ones NEMAR published. The date shown
 * is when the dataset went public, falling back to when it was created,
 * which is the same order the API sorted by.
 */
export function latestDatasets(rows: readonly Dataset[], limit: number): LatestDataset[] {
  return rows
    .filter(isHostedDataset)
    .slice(0, limit)
    .map((d) => {
      const all = splitModalities(d.modalities);
      const recorded = all.filter((m) => !COMPANION_MODALITIES.has(m.toUpperCase()));
      return {
        id: d.dataset_id || d.id,
        name: d.name?.trim() || d.dataset_id || d.id,
        modalities: (recorded.length > 0 ? recorded : all).slice(0, 3),
        participants:
          typeof d.participants === "number" && d.participants > 0 ? d.participants : null,
        publishedAt: parseCatalogTimestamp(d.first_published_at ?? d.created_at),
        href: `/dataset/${encodeURIComponent(d.dataset_id || d.id)}`,
      };
    });
}
