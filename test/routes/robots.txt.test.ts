import { describe, expect, it } from "vitest";
import { GET } from "../../src/pages/robots.txt";
import { callRoute, withFetch } from "./harness";

/**
 * Route-level tests for `src/pages/robots.txt.ts` (website#294 fix 10). The
 * body itself is covered exhaustively in `src/lib/robots.test.ts`; this
 * covers the wrapper -- that it reads the hostname from the request, does no
 * upstream fetch, and is cacheable at the edge.
 */
describe("GET /robots.txt", () => {
  it("serves the production policy for a production host", async () => {
    const response = await withFetch(
      () => undefined,
      () => callRoute(GET, "https://nemar.org/robots.txt"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    const body = await response.text();
    expect(body).toContain("Sitemap: https://nemar.org/sitemap.xml");
    expect(body).not.toContain("Disallow");
  });

  it("serves the disallow-all policy for a non-production host", async () => {
    const response = await withFetch(
      () => undefined,
      () => callRoute(GET, "https://test.nemar.org/robots.txt"),
    );
    expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("is edge-cacheable (website#294 fix 11)", async () => {
    // Without a `public` + max-age Cache-Control, `isPublicCacheable` in
    // src/middleware.ts refuses to store the response, so every crawler hit
    // rendered a fresh Worker invocation for a body that only changes on
    // deploy.
    const response = await withFetch(
      () => undefined,
      () => callRoute(GET, "https://nemar.org/robots.txt"),
    );
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("makes no upstream request", async () => {
    const calls = await withFetch(
      () => undefined,
      async (calls) => {
        await callRoute(GET, "https://nemar.org/robots.txt");
        return calls;
      },
    );
    expect(calls).toEqual([]);
  });
});
