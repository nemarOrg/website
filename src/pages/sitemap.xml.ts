import type { APIRoute } from "astro";
import { listAllDatasets } from "../lib/api";
import { buildSitemapXml, datasetSitemapEntries, staticSitemapEntries } from "../lib/sitemap";

/**
 * SSR sitemap (website#284 phase 1, issue #285). Deliberately NOT
 * `@astrojs/sitemap`: that plugin writes the document at build time, so
 * every `lastmod` would freeze at whatever deploy produced it. This route
 * pages the live catalog through `listAllDatasets` on every request instead,
 * so `lastmod` tracks each dataset's own `updated_at`/`created_at`. Response
 * caching (below) keeps that from meaning "hits the API on every crawl".
 *
 * A catalog fetch failure returns 503 with `Cache-Control: no-store`, never
 * an empty `<urlset>` -- an empty sitemap is a positive assertion that the
 * site has no pages, and an edge-cached one would compound the outage.
 */
export const GET: APIRoute = async () => {
  let rows: Awaited<ReturnType<typeof listAllDatasets>>;
  try {
    rows = await listAllDatasets();
  } catch (err) {
    console.error(
      `[sitemap.xml] catalog fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const xml = buildSitemapXml([...staticSitemapEntries(), ...datasetSitemapEntries(rows)]);
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
};
