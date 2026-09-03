import { describe, expect, it } from "vitest";
import { GET } from "../../src/pages/dataset/[id].md";
import catalogNm000103 from "../fixtures/jsonld-catalog-nm000103.json";
import landingNm000103 from "../fixtures/jsonld-landing-nm000103.json";
import metadataNm000103 from "../fixtures/jsonld-metadata-nm000103.json";
import { callRoute, jsonResponse, withFetch } from "./harness";

/**
 * Route-level tests for `src/pages/dataset/[id].md.ts` (website#294 fix 10).
 *
 * THE VISIBILITY GATE IS THE POINT. The route has no visibility check of its
 * own by design: `data.nemar.org` 404s both the landing document and
 * `metadata.json` for a private dataset, so `resolveDatasetPageStatus`
 * resolves `not_found` and the mirror 404s with it. That was asserted only in
 * a comment, which cannot fail -- a refactor that started serving the
 * landing document for a private dataset, or that treated one 404 as
 * "partially published", would publish a private dataset's metadata as
 * markdown and no test would notice.
 *
 * The fixtures are the real captured nm000103 documents the JSON-LD and
 * "use this data" tests use, so the success path renders the real shape.
 */

const LANDING = "https://data.nemar.org/nm000103/";
const METADATA = "https://data.nemar.org/nm000103/metadata.json";
const CATALOG = "https://api.nemar.org/datasets/nm000103";

function publicDataset(url: string): Response | undefined {
  if (url === LANDING) return jsonResponse(landingNm000103);
  if (url === METADATA) return jsonResponse(metadataNm000103);
  if (url === CATALOG) return jsonResponse(catalogNm000103);
  return undefined;
}

/** What data.nemar.org actually answers for a dataset the caller may not see:
 *  404 on both signals, indistinguishable from a dataset that never existed.
 *  That indistinguishability is deliberate -- it is what stops the mirror
 *  from confirming a private id exists. */
function notFoundEverywhere(url: string): Response | undefined {
  if (url === LANDING || url === METADATA) return new Response(null, { status: 404 });
  if (url === CATALOG) return new Response(null, { status: 404 });
  return undefined;
}

describe("GET /dataset/[id].md — visibility gate", () => {
  it("404s for a private dataset", async () => {
    const response = await withFetch(notFoundEverywhere, () =>
      callRoute(GET, "https://nemar.org/dataset/nm000103.md", { id: "nm000103" }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // Nothing about the dataset leaks into the body.
    expect(await response.text()).toBe("");
  });

  it("404s for an unknown id, the same way", async () => {
    const response = await withFetch(
      (url) =>
        url.startsWith("https://data.nemar.org/nm999999") ||
        url === "https://api.nemar.org/datasets/nm999999"
          ? new Response(null, { status: 404 })
          : undefined,
      () => callRoute(GET, "https://nemar.org/dataset/nm999999.md", { id: "nm999999" }),
    );
    expect(response.status).toBe(404);
  });

  it("404s when the id is missing entirely", async () => {
    const response = await withFetch(
      () => undefined,
      () => callRoute(GET, "https://nemar.org/dataset/.md", {}),
    );
    expect(response.status).toBe(404);
  });

  it("503s, not 404s, when only one signal fails transiently", async () => {
    // A single not_found could be a partial publish; a 5xx is a data-layer
    // problem. Neither is "this dataset does not exist", so neither may be
    // cached as one.
    const response = await withFetch(
      (url) => {
        if (url === LANDING) return new Response(null, { status: 502 });
        if (url === METADATA) return jsonResponse(metadataNm000103);
        if (url === CATALOG) return jsonResponse(catalogNm000103);
        return undefined;
      },
      () => callRoute(GET, "https://nemar.org/dataset/nm000103.md", { id: "nm000103" }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /dataset/[id].md — success", () => {
  it("serves the markdown mirror with the markdown media type", async () => {
    const response = await withFetch(publicDataset, () =>
      callRoute(GET, "https://nemar.org/dataset/nm000103.md", { id: "nm000103" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    const body = await response.text();
    expect(body.startsWith("# Healthy Brain Network EEG")).toBe(true);
    expect(body).toContain("## How to use the data (for agentic research)");
    expect(body).toContain("nemar dataset download nm000103");
  });

  it("renders even when the catalog row is unavailable", async () => {
    // The row only carries the Zarr facts; losing it must cost that section,
    // not the document.
    const response = await withFetch(
      (url) => (url === CATALOG ? new Response(null, { status: 500 }) : publicDataset(url)),
      () => callRoute(GET, "https://nemar.org/dataset/nm000103.md", { id: "nm000103" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("## How to use the data (for agentic research)");
  });

  it("is noindex and canonicalises to the HTML page (website#294 fix 11)", async () => {
    const response = await withFetch(publicDataset, () =>
      callRoute(GET, "https://nemar.org/dataset/nm000103.md?v=v2.0.0", { id: "nm000103" }),
    );
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    // Query string dropped, matching how the HTML page derives its own
    // canonical URL, so every `?v=` variant points at one indexable URL.
    expect(response.headers.get("Link")).toBe(
      '<https://nemar.org/dataset/nm000103>; rel="canonical"',
    );
  });

  it("is edge-cacheable", async () => {
    const response = await withFetch(publicDataset, () =>
      callRoute(GET, "https://nemar.org/dataset/nm000103.md", { id: "nm000103" }),
    );
    const cacheControl = response.headers.get("Cache-Control") ?? "";
    expect(cacheControl).toContain("public");
    expect(cacheControl).toMatch(/max-age=\d+/);
  });
});

describe("GET /dataset/[id].md — ds* canonical redirect", () => {
  it("301s a ds id to its on* canonical, keeping .md and the query string", async () => {
    const response = await withFetch(
      (url) =>
        url === "https://api.nemar.org/datasets/resolve/ds004496"
          ? jsonResponse({ found: true, dataset_id: "on004496" })
          : undefined,
      () => callRoute(GET, "https://nemar.org/dataset/ds004496.md?v=v1.0.0", { id: "ds004496" }),
    );
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("/dataset/on004496.md?v=v1.0.0");
  });

  it("falls through to the normal path when the ds id has no mirror", async () => {
    const response = await withFetch(
      (url) =>
        url === "https://api.nemar.org/datasets/resolve/ds004496"
          ? jsonResponse({ found: false })
          : new Response(null, { status: 404 }),
      () => callRoute(GET, "https://nemar.org/dataset/ds004496.md", { id: "ds004496" }),
    );
    expect(response.status).toBe(404);
  });
});
