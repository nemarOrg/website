import { describe, expect, it } from "vitest";
import { copySetCookies, dashboardApiBase, readError } from "./api-base";

describe("readError", () => {
  it("extracts code + message from a well-formed error body", async () => {
    const res = new Response(JSON.stringify({ error: "not_found", message: "Gone" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    expect(await readError(res)).toEqual({ code: "not_found", message: "Gone" });
  });

  it("returns empty object for non-JSON HTML body", async () => {
    const res = new Response("<html>oops</html>", {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
    expect(await readError(res)).toEqual({});
  });

  it("returns empty object for an empty body", async () => {
    const res = new Response("", { status: 502 });
    expect(await readError(res)).toEqual({});
  });

  it("omits message when it's empty or missing", async () => {
    const res = new Response(JSON.stringify({ error: "unauthenticated", message: "" }), {
      status: 401,
    });
    const out = await readError(res);
    expect(out.code).toBe("unauthenticated");
    expect(out.message).toBeUndefined();
  });
});

describe("copySetCookies", () => {
  it("copies multiple Set-Cookie headers via getSetCookie() when available", () => {
    const cookies = ["session=abc; Path=/", "csrf=def; Path=/"];
    const src = new Response(null, {
      status: 200,
    }) as Response & { headers: Headers & { getSetCookie?: () => string[] } };
    // Patch getSetCookie on this instance to simulate the Workers runtime.
    (src.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie = () => cookies;
    const dest = new Headers();
    const copied = copySetCookies(src, dest);
    expect(copied).toBe(true);
    // dest.getSetCookie() returns the appended list.
    const out =
      typeof (dest as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (dest as Headers & { getSetCookie: () => string[] }).getSetCookie()
        : [dest.get("set-cookie") ?? ""];
    expect(out).toEqual(cookies);
  });

  it("returns false when there are no Set-Cookie headers", () => {
    const src = new Response(null, { status: 200 });
    const dest = new Headers();
    expect(copySetCookies(src, dest)).toBe(false);
  });

  it("falls back to .get('set-cookie') when getSetCookie is unavailable", () => {
    const src = new Response(null, {
      status: 200,
      headers: { "Set-Cookie": "session=abc; Path=/" },
    });
    // Wipe getSetCookie to force the fallback path.
    Object.defineProperty(src.headers, "getSetCookie", { value: undefined, configurable: true });
    const dest = new Headers();
    expect(copySetCookies(src, dest)).toBe(true);
    expect(dest.get("set-cookie")).toBe("session=abc; Path=/");
  });
});

describe("dashboardApiBase", () => {
  it("returns the same-origin /api/v1 proxy when no cookieHeader is passed (browser path)", () => {
    expect(dashboardApiBase()).toBe("/api/v1");
    expect(dashboardApiBase(undefined)).toBe("/api/v1");
    expect(dashboardApiBase("")).toBe("/api/v1");
  });

  it("returns apiBase() direct when cookieHeader is provided (SSR path)", () => {
    expect(dashboardApiBase("nemar_session=abc")).toBe("https://api.nemar.org");
  });
});
