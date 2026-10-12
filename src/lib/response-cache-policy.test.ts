import { describe, expect, it } from "vitest";
import {
  SESSION_CACHE_CONTROL,
  STALE_DATA_CACHE_CONTROL,
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
