import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { GET } from "../pages/api/dataset/[id]/tree";

/**
 * Endpoint-boundary tests that exercise the synchronous validation gates
 * before any await — no backend mocks needed because the early returns
 * short-circuit `getLandingOutcome` / `getSummary` / `getManifest` entirely.
 * Anything that requires those upstreams to resolve stays out of scope per
 * the project's no-mocks rule and is verified by `/browse` against a real
 * Pages preview instead.
 *
 * Lives in `src/lib/` (not next to the route source) because Astro file-
 * routes anything under `src/pages/**` — a `.test.ts` sibling there gets
 * picked up as a route entry and breaks the Cloudflare Pages build. PR
 * #62 hot-fixed the same class of issue for the /api/v1 proxy by keeping
 * its test under src/lib/.
 */

type Ctx = Pick<APIContext, "params" | "request">;
function ctx(url: string, params: Record<string, string>): Ctx {
  return {
    params,
    request: new Request(url, { method: "GET" }),
  };
}

describe("GET /api/dataset/[id]/tree — validation gates", () => {
  it("returns 400 when v= query parameter is missing", async () => {
    const res = await GET(
      ctx("https://x.test/api/dataset/nm000103/tree", { id: "nm000103" }) as APIContext,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 400 for a malformed subject= parameter", async () => {
    const res = await GET(
      ctx("https://x.test/api/dataset/nm000103/tree?v=v1.0.0&subject=../etc/passwd", {
        id: "nm000103",
      }) as APIContext,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("Invalid subject parameter");
  });

  it("returns 400 for an empty subject= parameter", async () => {
    const res = await GET(
      ctx("https://x.test/api/dataset/nm000103/tree?v=v1.0.0&subject=", {
        id: "nm000103",
      }) as APIContext,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 400 for an underscore label that isn't BIDS-shaped", async () => {
    const res = await GET(
      ctx("https://x.test/api/dataset/nm000103/tree?v=v1.0.0&subject=sub_01", {
        id: "nm000103",
      }) as APIContext,
    );
    expect(res.status).toBe(400);
  });
});
