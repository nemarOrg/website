import { describe, expect, it } from "vitest";
import { GET } from "../../src/pages/llms.txt";
import { callRoute, withFetch } from "./harness";

/**
 * Route-level tests for `src/pages/llms.txt.ts` (website#294 fix 10). The
 * body is covered in `src/lib/llms-txt.test.ts`; this covers the wrapper --
 * the media type, the deliberate absence of a host gate, and the cache
 * header.
 */
describe("GET /llms.txt", () => {
  it("serves the body as UTF-8 plain text", async () => {
    const response = await withFetch(
      () => undefined,
      () => callRoute(GET, "https://nemar.org/llms.txt"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const body = await response.text();
    expect(body.startsWith("# NEMAR")).toBe(true);
    expect(body).toContain("## Data");
    expect(body).toContain("## Datasets");
  });

  it("serves the same body on every host, by design", async () => {
    // Unlike sitemap.xml.ts there is no `isNoindexHost` gate: the route does
    // no upstream fetch, so there is nothing expensive to protect, and
    // non-production hosts are already noindexed and Disallow: / anyway.
    const bodies = await withFetch(
      () => undefined,
      async () => {
        const hosts = ["https://nemar.org", "https://test.nemar.org", "http://localhost:4321"];
        return await Promise.all(
          hosts.map(async (origin) => (await callRoute(GET, `${origin}/llms.txt`)).text()),
        );
      },
    );
    expect(new Set(bodies).size).toBe(1);
  });

  it("is edge-cacheable (website#294 fix 11)", async () => {
    const response = await withFetch(
      () => undefined,
      () => callRoute(GET, "https://nemar.org/llms.txt"),
    );
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("makes no upstream request", async () => {
    const calls = await withFetch(
      () => undefined,
      async (calls) => {
        await callRoute(GET, "https://nemar.org/llms.txt");
        return calls;
      },
    );
    expect(calls).toEqual([]);
  });
});
