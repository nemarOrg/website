/**
 * Route-level test for the sign-out proxy's defensive clear (`api/auth/logout.ts`;
 * nemar-cli ADR 0119, decision 10), in the style of `api-auth-keys.test.ts`: only the network
 * boundary is stubbed, every line of route logic is real.
 *
 * The API clears the session cookie itself and the proxy mirrors that. When the API cannot be
 * reached, or answers without a Set-Cookie, the proxy clears the cookie on its own so the browser
 * does not keep a session the API will refuse. While the API's cookie moves from `nemar_session`
 * to `__Host-nemar_session` a browser can hold either, so the fallback clears both.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../src/pages/api/auth/logout";
import { callRoute } from "./harness";

const URL_ = "https://app.nemar.org/api/auth/logout";
const NEW_CLEAR = "__Host-nemar_session=; Max-Age=0; Path=/; SameSite=Lax; Secure";
const LEGACY_CLEAR = "nemar_session=; Max-Age=0; Path=/; SameSite=Lax; Secure";

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
  it("clears both names after an unreachable API (an HTML sign-out form)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("the API is unreachable");
    }) as unknown as typeof fetch;
    const res = await callRoute(POST, URL_, {}, init("text/html"));
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie()).toEqual([NEW_CLEAR, LEGACY_CLEAR]);
  });

  it("clears both names after an unreachable API (a fetch caller)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("the API is unreachable");
    }) as unknown as typeof fetch;
    const res = await callRoute(POST, URL_, {}, init("application/json"));
    expect(res.status).toBe(502);
    expect(res.headers.getSetCookie()).toEqual([NEW_CLEAR, LEGACY_CLEAR]);
  });

  it("clears both names when the API answers without a Set-Cookie", async () => {
    globalThis.fetch = (async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const res = await callRoute(POST, URL_, {}, init("text/html"));
    expect(res.headers.getSetCookie()).toEqual([NEW_CLEAR, LEGACY_CLEAR]);
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
