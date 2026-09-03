import type { APIRoute } from "astro";
import { listAllDatasets } from "../lib/api";
import { isNoindexHost } from "../lib/host";
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
 *
 * Gated on `isNoindexHost` rather than `isProductionHost`, which is the
 * narrower of the two but the right one here. A real non-production deploy
 * (`test.nemar.org`, a `*.pages.dev` preview) has no use for a sitemap: its
 * `robots.txt` never advertises one, the middleware stamps `X-Robots-Tag:
 * noindex`, and its catalog is `nemar-db-dev` -- so a stray probe there
 * would pay a full multi-page catalog fan-out to produce a document nothing
 * should read. Local dev is deliberately NOT gated out, for the same reason
 * `isNoindexHost` exempts it: it is the only place this route is verifiable
 * against the real catalog before it ships.
 */
export const GET: APIRoute = async ({ request }) => {
  if (isNoindexHost(new URL(request.url).hostname)) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

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
