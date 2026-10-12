import { describe, expect, it } from "vitest";
import {
  SESSION_CACHE_CONTROL,
  STALE_DATA_CACHE_CONTROL,
  discoverCacheControl,
  discoverRetryAfter,
  privateIfPublicHtml,
  withStaleDataHeaders,
} from "./response-cache-policy";

const page = (headers: Record<string, string>, init: ResponseInit = {}) =>
  new Response("body", { ...init, headers });

describe("withStaleDataHeaders", () => {
  it("marks the response and keeps it at the shared cache for a minute, not an hour", async () => {
    const res = withStaleDataHeaders(
      page({ "Cache-Control": "public, max-age=60, s-maxage=3600, stale-while-revalidate=600" }),
    );
    expect(res.headers.get("x-nemar-data")).toBe("stale");
    expect(res.headers.get("Cache-Control")).toBe(STALE_DATA_CACHE_CONTROL);
    expect(STALE_DATA_CACHE_CONTROL).toBe("public, max-age=0, s-maxage=60");
    expect(await res.text()).toBe("body");
  });

  it.each(["no-store", "private, max-age=0", "no-store, private"])(
    "marks a response whose header is %s and leaves the header alone",
    (cacheControl) => {
      const res = withStaleDataHeaders(page({ "Cache-Control": cacheControl }));
      expect(res.headers.get("x-nemar-data")).toBe("stale");
      expect(res.headers.get("Cache-Control")).toBe(cacheControl);
    },
  );

  it("does not invent a cache header for a response that had none", () => {
    const res = withStaleDataHeaders(page({}));
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("x-nemar-data")).toBe("stale");
  });

  it("keeps the status and the other headers, a redirect included", () => {
    const res = withStaleDataHeaders(
      new Response(null, {
        status: 302,
        headers: { Location: "/x", "Cache-Control": "public, s-maxage=600" },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/x");
  });
});

describe("privateIfPublicHtml", () => {
  const PUBLIC = "public, max-age=60, s-maxage=3600";

  it("makes a public HTML page private", () => {
    const res = privateIfPublicHtml(
      page({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": PUBLIC }),
    );
    expect(res.headers.get("Cache-Control")).toBe(SESSION_CACHE_CONTROL);
    expect(SESSION_CACHE_CONTROL).toBe("private, max-age=0, must-revalidate");
  });

  it.each([
    ["an immutable stylesheet", "text/css", "public, max-age=31536000, immutable"],
    ["a JSON response", "application/json", PUBLIC],
    ["an HTML page that is already no-store", "text/html", "no-store"],
    ["an HTML page that is already private", "text/html", "private, max-age=0"],
  ])("leaves %s alone", (_name, type, cacheControl) => {
    const original = page({ "Content-Type": type, "Cache-Control": cacheControl });
    const res = privateIfPublicHtml(original);
    expect(res.headers.get("Cache-Control")).toBe(cacheControl);
    expect(res).toBe(original); // not even rebuilt
  });

  it("leaves a response with no content type alone", () => {
    expect(
      privateIfPublicHtml(page({ "Cache-Control": PUBLIC })).headers.get("Cache-Control"),
    ).toBe(PUBLIC);
  });
});

describe("withStaleDataHeaders: only ever shortens", () => {
  it.each([
    ["public, s-maxage=30", "public, s-maxage=30"],
    ["public, max-age=5, s-maxage=60", "public, max-age=5, s-maxage=60"],
  ])("leaves %s as it is, because it already asks for no more than a minute", (value, expected) => {
    expect(
      withStaleDataHeaders(new Response("x", { headers: { "Cache-Control": value } })).headers.get(
        "Cache-Control",
      ),
    ).toBe(expected);
  });

  it.each([
    "public, s-maxage=61",
    "public, max-age=60, s-maxage=3600, stale-while-revalidate=600",
    "public, max-age=3600",
  ])("shortens %s to a minute", (value) => {
    expect(
      withStaleDataHeaders(new Response("x", { headers: { "Cache-Control": value } })).headers.get(
        "Cache-Control",
      ),
    ).toBe(STALE_DATA_CACHE_CONTROL);
  });
});

describe("discoverCacheControl", () => {
  const base = { failed: false, degraded: false, search: false };

  it("never stores a failed load", () => {
    expect(discoverCacheControl({ ...base, failed: true })).toBe("no-store");
    expect(discoverCacheControl({ ...base, failed: true, degraded: true, search: true })).toBe(
      "no-store",
    );
  });

  it("keeps a page with cards that fell back to the search projection to a minute", () => {
    expect(discoverCacheControl({ ...base, degraded: true })).toBe(STALE_DATA_CACHE_CONTROL);
    expect(discoverCacheControl({ ...base, degraded: true, search: true })).toBe(
      STALE_DATA_CACHE_CONTROL,
    );
  });

  it("keeps a browse page an hour at the edge and a search half that, with a short browser window", () => {
    expect(discoverCacheControl(base)).toBe(
      "public, max-age=60, s-maxage=3600, stale-while-revalidate=600",
    );
    expect(discoverCacheControl({ ...base, search: true })).toBe(
      "public, max-age=60, s-maxage=1800, stale-while-revalidate=600",
    );
  });
});

describe("discoverRetryAfter", () => {
  it("asks for a minute when the API's budget is spent, and a short wait otherwise", () => {
    expect(discoverRetryAfter(true)).toBe("60");
    expect(discoverRetryAfter(false)).toBe("15");
  });
});
