/**
 * The date a dataset card shows as "Updated": when its latest version was
 * released, not when its catalog row was last touched.
 *
 * `updated_at` is bumped by anything that writes the row (an enrichment
 * reindex, a DOI sync, a finalize), so after a catalog-wide sweep every card
 * would read "today" although no dataset changed. The API's
 * `latest_version_at` is the creation time of the latest version row, which
 * moves only when a new version is released.
 */
import { parseCatalogTimestamp } from "./highlights";
import type { Dataset } from "./types";

/**
 * The latest release date as "Oct 9, 2025", or "" when the row carries none.
 *
 * Deliberately has no fallback to `updated_at`: a row without a version date
 * (a draft, a catalog-only dataset, or an API that predates the field) shows
 * no "Updated" fact rather than a misleading one. Returns "" so the caller's
 * `if (value) push(...)` skips the row, the same contract as `formatDate`.
 *
 * The date is formatted in UTC because the API's timestamp is UTC; a reader
 * in another zone would otherwise see the previous or next calendar day.
 */
export function formatReleaseDate(row: Pick<Dataset, "latest_version_at">): string {
  const date = parseCatalogTimestamp(row.latest_version_at);
  if (!date) return "";
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
