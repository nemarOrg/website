import { describe, expect, it } from "vitest";
import { GET } from "../../src/pages/sitemap.xml";
import catalogNm000103 from "../fixtures/jsonld-catalog-nm000103.json";
import { callRoute, jsonResponse, withFetch } from "./harness";

/**
 * Route-level tests for `src/pages/sitemap.xml.ts` (website#294 fix 10). The
 * pure helpers it calls are covered in `src/lib/sitemap.test.ts`; what is
 * covered here is the wrapper's own behaviour, which had no tests at all:
 * the noindex-host gate, the 503-not-empty-document failure mode, and the
 * cache headers.
 *
 * The catalog row is the real captured nm000103 row the JSON-LD tests use, so
 * the shape being paged is the shape api.nemar.org actually returns.
 */

const CATALOG_LIST = "https://api.nemar.org/datasets?limit=200&offset=0";

function catalogPage(rows: unknown[]): Response {
  return jsonResponse({ datasets: rows, count: rows.length, total_count: rows.length });
}

describe("GET /sitemap.xml", () => {
  it("serves the catalog as a urlset on a production host", async () => {
    const response = await withFetch(
      (url) => (url === CATALOG_LIST ? catalogPage([catalogNm000103]) : undefined),
      () => callRoute(GET, "https://nemar.org/sitemap.xml"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("<loc>https://nemar.org/dataset/nm000103</loc>");
    // Real `lastmod` from the row's own updated_at, which is the entire
    // reason this route is SSR rather than @astrojs/sitemap.
    expect(body).toContain("<lastmod>2026-07-10T21:42:34.000Z</lastmod>");
  });

  it("is edge-cacheable", async () => {
    const response = await withFetch(
      (url) => (url === CATALOG_LIST ? catalogPage([catalogNm000103]) : undefined),
      () => callRoute(GET, "https://nemar.org/sitemap.xml"),
    );
    const cacheControl = response.headers.get("Cache-Control") ?? "";
    // `isPublicCacheable` in src/middleware.ts requires `public` plus a
    // max-age before the middleware will store the response at the edge.
    expect(cacheControl).toContain("public");
    expect(cacheControl).toMatch(/max-age=\d+/);
    expect(cacheControl).not.toContain("no-store");
  });

  it("returns 503 with no-store when the catalog fetch fails", async () => {
    // Never an empty <urlset>: that is a positive assertion that the site has
    // no pages, and an edge-cached one would outlive the outage.
    const response = await withFetch(
      () => new Response("upstream down", { status: 500 }),
      () => callRoute(GET, "https://nemar.org/sitemap.xml"),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("returns 503 when the catalog fetch rejects outright", async () => {
    const response = await withFetch(
      () => undefined,
      () => callRoute(GET, "https://nemar.org/sitemap.xml"),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("404s on a noindex host without touching the catalog", async () => {
    // test.nemar.org's robots.txt advertises no sitemap and its catalog is
    // nemar-db-dev, so a stray probe there must not pay a full catalog
    // fan-out.
    for (const host of ["test.nemar.org", "fa9dbfa0.nemar-website.pages.dev"]) {
      const { response, calls } = await withFetch(
        () => undefined,
        async (calls) => ({
          response: await callRoute(GET, `https://${host}/sitemap.xml`),
          calls,
        }),
      );
      expect(response.status, host).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(calls, host).toEqual([]);
    }
  });

  it("still serves localhost, which isNoindexHost deliberately exempts", async () => {
    // Local dev is the only place this route can be checked against the real
    // catalog before it ships, so it must not be gated out.
    const response = await withFetch(
      (url) => (url === CATALOG_LIST ? catalogPage([catalogNm000103]) : undefined),
      () => callRoute(GET, "http://localhost:4321/sitemap.xml"),
    );
    expect(response.status).toBe(200);
  });
});
