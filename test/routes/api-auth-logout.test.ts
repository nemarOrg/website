/**
 * Route-level test for the sign-out proxy's defensive clear (`api/auth/logout.ts`;
 * nemar-cli ADR 0119, decision 10), in the style of `api-auth-keys.test.ts`: only the network
 * boundary is stubbed, every line of route logic is real.
 *
 * The API clears the session cookie itself and the proxy mirrors that. When the API cannot be
 * reached, or answers without a Set-Cookie, the proxy clears the cookie on its own so the browser
 * does not keep a session the API will refuse. While the API's cookie moves from `nemar_session`
 * to `__Host-nemar_session` a browser can hold either, so the fallback clears both. A browser
 * treats a cookie set with a `Domain` as a different cookie from one set without, and production
 * issues the legacy name with `Domain=app.nemar.org`, so on a `nemar.org` host the legacy name is
 * cleared three ways (no domain, the request's host, `nemar.org`), as the API's own sign-out does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../src/pages/api/auth/logout";
import { callRoute } from "./harness";

const URL_ = "https://app.nemar.org/api/auth/logout";
const NEW_CLEAR = "__Host-nemar_session=; Max-Age=0; Path=/; SameSite=Lax; Secure";
const LEGACY_CLEAR = "nemar_session=; Max-Age=0; Path=/; SameSite=Lax; Secure";
const LEGACY_CLEAR_HOST =
  "nemar_session=; Max-Age=0; Path=/; Domain=app.nemar.org; SameSite=Lax; Secure";
const LEGACY_CLEAR_ZONE =
  "nemar_session=; Max-Age=0; Path=/; Domain=nemar.org; SameSite=Lax; Secure";
const ALL_CLEARS_APP = [NEW_CLEAR, LEGACY_CLEAR, LEGACY_CLEAR_HOST, LEGACY_CLEAR_ZONE];

const originalFetch = globalThis.fetch;

function init(accept: string): RequestInit {
  return { method: "POST", headers: { Accept: accept, Cookie: "__Host-nemar_session=abc" } };
}

beforeEach(() => {
  vi.stubEnv("DEV", false);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/auth/logout, when the API sends no cookie", () => {
  it("clears every scope of both names after an unreachable API (an HTML sign-out form)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("the API is unreachable");
    }) as unknown as typeof fetch;
    const res = await callRoute(POST, URL_, {}, init("text/html"));
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie()).toEqual(ALL_CLEARS_APP);
  });

  it("clears every scope of both names after an unreachable API (a fetch caller)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("the API is unreachable");
    }) as unknown as typeof fetch;
    const res = await callRoute(POST, URL_, {}, init("application/json"));
    expect(res.status).toBe(502);
    expect(res.headers.getSetCookie()).toEqual(ALL_CLEARS_APP);
  });

  it("clears every scope of both names when the API answers without a Set-Cookie", async () => {
    globalThis.fetch = (async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const res = await callRoute(POST, URL_, {}, init("text/html"));
    expect(res.headers.getSetCookie()).toEqual(ALL_CLEARS_APP);
  });
});

describe("POST /api/auth/logout, the fallback clear by request host", () => {
  const unreachable = () => {
    globalThis.fetch = (async () => {
      throw new Error("the API is unreachable");
    }) as unknown as typeof fetch;
  };

  it("sends no Domain on the host-prefixed clear", async () => {
    unreachable();
    const res = await callRoute(POST, URL_, {}, init("text/html"));
    const hostPrefixed = res.headers.getSetCookie().filter((c) => c.startsWith("__Host-"));
    expect(hostPrefixed).toEqual([NEW_CLEAR]);
    expect(hostPrefixed[0]).not.toMatch(/Domain=/i);
  });

  it("clears the legacy name once for the zone when the host is nemar.org itself", async () => {
    unreachable();
    const res = await callRoute(POST, "https://nemar.org/api/auth/logout", {}, init("text/html"));
    expect(res.headers.getSetCookie()).toEqual([NEW_CLEAR, LEGACY_CLEAR, LEGACY_CLEAR_ZONE]);
  });

  it("clears the legacy name with the request's own subdomain", async () => {
    unreachable();
    const res = await callRoute(
      POST,
      "https://staging.nemar.org/api/auth/logout",
      {},
      init("text/html"),
    );
    expect(res.headers.getSetCookie()).toEqual([
      NEW_CLEAR,
      LEGACY_CLEAR,
      "nemar_session=; Max-Age=0; Path=/; Domain=staging.nemar.org; SameSite=Lax; Secure",
      LEGACY_CLEAR_ZONE,
    ]);
  });

  it.each([
    "http://localhost:4321/api/auth/logout",
    "http://127.0.0.1:4321/api/auth/logout",
    "https://nemar-website.pages.dev/api/auth/logout",
    "https://evilnemar.org/api/auth/logout",
  ])("sends no Domain at all to %s", async (url) => {
    unreachable();
    const res = await callRoute(POST, url, {}, init("text/html"));
    expect(res.headers.getSetCookie()).toEqual([NEW_CLEAR, LEGACY_CLEAR]);
  });
});

describe("POST /api/auth/logout, a hostname that is not plain", () => {
  // The URL parser strips CR, LF, space, %-escapes and userinfo from a host but keeps `;` and `,`,
  // so the hostname must never reach a `Domain=` attribute unless it is a plain name.
  it.each([
    "a;Domain=evil.com;x=.nemar.org",
    "a;b.nemar.org",
    "a,b.nemar.org",
    "a%3Bb.nemar.org",
    "-.nemar.org",
    "a-.nemar.org",
    "a_b.nemar.org",
    "a..nemar.org",
    ".nemar.org",
  ])("sends no Domain to https://%s/", async (host) => {
    globalThis.fetch = (async () => {
      throw new Error("the API is unreachable");
    }) as unknown as typeof fetch;
    const res = await callRoute(POST, `https://${host}/api/auth/logout`, {}, init("text/html"));
    const cookies = res.headers.getSetCookie();
    expect(cookies).toEqual([NEW_CLEAR, LEGACY_CLEAR]);
    for (const c of cookies) {
      expect(c).not.toMatch(/Domain=/i);
      // Only the four attribute separators every clear has, none brought in by the host.
      expect(c.split(";")).toHaveLength(5);
    }
  });

  it("still clears for a deeper subdomain", async () => {
    globalThis.fetch = (async () => {
      throw new Error("the API is unreachable");
    }) as unknown as typeof fetch;
    const res = await callRoute(
      POST,
      "https://a.b.nemar.org/api/auth/logout",
      {},
      init("text/html"),
    );
    expect(res.headers.getSetCookie()).toEqual([
      NEW_CLEAR,
      LEGACY_CLEAR,
      "nemar_session=; Max-Age=0; Path=/; Domain=a.b.nemar.org; SameSite=Lax; Secure",
      LEGACY_CLEAR_ZONE,
    ]);
  });
});

describe("POST /api/auth/logout, when the API clears the cookie itself", () => {
  it("mirrors the API's Set-Cookie headers unchanged and adds nothing", async () => {
    const fromApi = [
      "__Host-nemar_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
      "nemar_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=app.nemar.org; Max-Age=0",
      "nemar_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    ];
    globalThis.fetch = (async () => {
      const headers = new Headers({ "Content-Type": "application/json" });
      for (const c of fromApi) headers.append("Set-Cookie", c);
      return new Response('{"ok":true}', { status: 200, headers });
    }) as unknown as typeof fetch;
    const res = await callRoute(POST, URL_, {}, init("text/html"));
    expect(res.headers.getSetCookie()).toEqual(fromApi);
  });
});
