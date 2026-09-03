import { MARKETING_BASE_URL } from "./host";
import { escapeXml } from "./og-chrome";
import type { Dataset } from "./types";

/**
 * Pure helpers behind `src/pages/sitemap.xml.ts` (website#284 phase 1,
 * issue #285). No I/O here -- the route fetches the catalog and hands rows
 * to `datasetSitemapEntries`, so this file stays unit-testable against
 * captured fixtures.
 */

export interface SitemapEntry {
  readonly loc: string;
  /** W3C datetime string, or null to omit `<lastmod>` entirely. */
  readonly lastmod: string | null;
}

/**
 * Public marketing routes with no dataset-specific `lastmod`. App-host
 * routes (login, dashboard, upload, settings, admin, auth) are never
 * listed -- a sitemap only advertises the anonymous, edge-cacheable
 * marketing surface.
 */
const STATIC_MARKETING_ROUTES: readonly string[] = [
  "/",
  "/discover",
  "/about",
  "/support",
  "/privacy",
  "/terms",
];

export function staticSitemapEntries(): SitemapEntry[] {
  return STATIC_MARKETING_ROUTES.map((path) => ({
    loc: `${MARKETING_BASE_URL}${path}`,
    lastmod: null,
  }));
}

/**
 * The exact shape api.nemar.org ships timestamps in: a space separator, no
 * zone, values that are already UTC. `new Date("2026-08-31 11:09:05")`
 * cannot be trusted to parse this the same way everywhere -- V8 treats a
 * space-separated date-time as local time, not UTC, so building a Date
 * straight from the raw string would silently shift every lastmod by the
 * host's offset. Matching this pattern explicitly and building the Date
 * with `Date.UTC` keeps the instant correct regardless of runtime.
 */
const CATALOG_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * Turn a catalog row's `updated_at` (falling back to `created_at`) into a
 * W3C datetime string (`Date.toISOString()`), or null when neither value is
 * present or parses. An omitted `<lastmod>` is correct sitemap XML; a wrong
 * one is not, so anything that doesn't cleanly match the known API shape
 * returns null rather than a best-effort guess.
 */
export function sitemapLastmod(row: {
  readonly updated_at?: string | null;
  readonly created_at?: string | null;
}): string | null {
  const raw = row.updated_at || row.created_at;
  if (!raw) return null;

  const match = CATALOG_TIMESTAMP_RE.exec(raw.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);

  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date.UTC normalizes out-of-range fields (e.g. month 13) instead of
  // rejecting them, so confirm the constructed date reflects the input
  // rather than trusting a value that silently rolled over.
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== s
  ) {
    return null;
  }
  return date.toISOString();
}

const MANAGED_DATASET_ID_RE = /^(nm|on)\d{6}$/;

/**
 * Catalog rows worth listing in the sitemap: active, public, and addressed
 * by a managed id (`nm*`/`on*`). `ds*` rows are deliberately excluded --
 * `/dataset/ds<digits>` 301-redirects to its canonical in `[id].astro`, and
 * a sitemap must never list a URL that redirects.
 */
export function datasetSitemapEntries(rows: readonly Dataset[]): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  for (const row of rows) {
    if (row.status !== "active" || row.visibility !== "public") continue;
    if (!MANAGED_DATASET_ID_RE.test(row.dataset_id)) continue;
    entries.push({
      loc: `${MARKETING_BASE_URL}/dataset/${row.dataset_id}`,
      lastmod: sitemapLastmod(row),
    });
  }
  return entries;
}

/**
 * Renders a valid `<urlset>` sitemap document. Every value is XML-escaped
 * (reusing the OG-card escaper in `og-chrome.ts` rather than a second
 * copy) so a dataset name or id containing `&`/`<` can never break the
 * document.
 */
export function buildSitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries
    .map((entry) => {
      const lastmodTag = entry.lastmod
        ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`
        : "";
      return `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${lastmodTag}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
