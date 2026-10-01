/**
 * Request wiring for the private-site grant client.
 *
 * Driven with a handed-in `fetch` returning a real `Response`, the `docs-auth-api.test.ts`
 * pattern, so what is under test is the request this module builds: the route, the pinned
 * `Origin` (the backend refuses a missing one before it looks at the session), the forwarded
 * `Cookie`, and the `state` in the body, which is the only place it may travel.
 */

import { describe, expect, it, vi } from "vitest";
import { requestPrivateGrant } from "./private-auth-api";

const STATE = "PrivateSiteState_0123456789-abcdefghijklmn";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureFetch(response: Response | (() => Promise<Response>)): {
  fetch: typeof fetch;
  calls: RequestInit[];
  urls: string[];
} {
  const calls: RequestInit[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(typeof input === "string" ? input : input.toString());
    calls.push(init ?? {});
    return typeof response === "function" ? await response() : response;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls, urls };
}

function headerMap(init: RequestInit): Record<string, string> {
  const h = init.headers as Record<string, string> | Headers | undefined;
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  return h;
}

const BASE = { origin: "https://app.nemar.org", state: STATE } as const;

describe("requestPrivateGrant", () => {
  it("posts the state, and only the state, as JSON to the grant route", async () => {
    const cap = captureFetch(jsonResponse({ code: "abc", expires_in: 60 }));
    await requestPrivateGrant({ ...BASE, fetch: cap.fetch });
    expect(cap.urls[0].endsWith("/auth/private/grant")).toBe(true);
    expect(cap.calls[0].method).toBe("POST");
    expect(JSON.parse(cap.calls[0].body as string)).toEqual({ state: STATE });
    expect(headerMap(cap.calls[0])["Content-Type"]).toBe("application/json");
  });

  it("never follows a redirect, so the cookie and state cannot be resent elsewhere", async () => {
    const cap = captureFetch(
      new Response(null, { status: 307, headers: { Location: "https://elsewhere.example/" } }),
    );
    expect(await requestPrivateGrant({ ...BASE, fetch: cap.fetch })).toEqual({
      status: 307,
      body: null,
    });
    expect(cap.calls[0].redirect).toBe("manual");
  });

  it("never puts the state in the URL", async () => {
    const cap = captureFetch(jsonResponse({ code: "abc", expires_in: 60 }));
    await requestPrivateGrant({ ...BASE, fetch: cap.fetch });
    expect(cap.urls[0]).not.toContain(STATE);
  });

  it("pins the caller's Origin, which the backend checks before authentication", async () => {
    const cap = captureFetch(jsonResponse({ code: "abc", expires_in: 60 }));
    await requestPrivateGrant({ ...BASE, fetch: cap.fetch, origin: "https://test.nemar.org" });
    expect(headerMap(cap.calls[0]).Origin).toBe("https://test.nemar.org");
  });

  it("forwards the visitor's Cookie header when there is one, and sends none otherwise", async () => {
    const withCookie = captureFetch(jsonResponse({ code: "abc", expires_in: 60 }));
    await requestPrivateGrant({
      ...BASE,
      fetch: withCookie.fetch,
      cookieHeader: "nemar_session=x",
    });
    expect(headerMap(withCookie.calls[0]).Cookie).toBe("nemar_session=x");
    const without = captureFetch(jsonResponse({ code: "abc", expires_in: 60 }));
    await requestPrivateGrant({ ...BASE, fetch: without.fetch });
    expect("Cookie" in headerMap(without.calls[0])).toBe(false);
  });

  it("returns every status with its parsed body, never throwing on a refusal", async () => {
    for (const [status, body] of [
      [200, { code: "abc", expires_in: 60 }],
      [400, { error: "invalid_request" }],
      [401, { error: "unauthenticated" }],
      [403, { error: "Account not approved", status: "pending" }],
      [429, { error: "Rate limit exceeded" }],
    ] as const) {
      const cap = captureFetch(jsonResponse(body, status));
      expect(await requestPrivateGrant({ ...BASE, fetch: cap.fetch })).toEqual({ status, body });
    }
  });

  it("reports a non-JSON body as null, keeping the status", async () => {
    const cap = captureFetch(new Response("<html>maintenance</html>", { status: 503 }));
    expect(await requestPrivateGrant({ ...BASE, fetch: cap.fetch })).toEqual({
      status: 503,
      body: null,
    });
  });

  it("answers the network sentinel on a transport failure, and logs no state", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cap = captureFetch(async () => {
        throw new TypeError("connection refused");
      });
      expect(await requestPrivateGrant({ ...BASE, fetch: cap.fetch })).toEqual({
        status: "network",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(STATE);
    } finally {
      warn.mockRestore();
    }
  });
});
