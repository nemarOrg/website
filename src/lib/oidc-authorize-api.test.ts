/**
 * Request wiring for the two calls `/oauth/authorize` makes to the API.
 *
 * Driven with a handed-in `fetch` returning a real `Response`, the `private-auth-api.test.ts`
 * pattern, so what is under test is the request this module builds: the route, the pinned `Origin`
 * (the API refuses a missing one before it looks at the session), the forwarded `Cookie`, the body,
 * and that a redirect is never followed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { OIDC_AUTHORIZE_CALLER_HEADER, OIDC_AUTHORIZE_CALLER_VALUE } from "./oidc-authorize";
import { requestOidcCheck, requestOidcConsent } from "./oidc-authorize-api";

const REQUEST = "client_id=oc_0123456789abcdef01234567&state=secret-state-value";
const TOKEN = "1999999999.secret-token-value";

afterEach(() => {
  vi.restoreAllMocks();
});

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
  return (init.headers as Record<string, string> | undefined) ?? {};
}

const BASE = { origin: "https://app.nemar.org" } as const;

describe("requestOidcCheck", () => {
  it("posts the request, and only it, as JSON to the check route", async () => {
    const cap = captureFetch(jsonResponse({ kind: "login", request: REQUEST }));
    const result = await requestOidcCheck({ ...BASE, request: REQUEST, fetch: cap.fetch });
    expect(cap.urls[0].endsWith("/auth/oidc/authorize")).toBe(true);
    expect(cap.urls[0]).not.toContain("secret-state-value");
    expect(cap.calls[0].method).toBe("POST");
    expect(JSON.parse(cap.calls[0].body as string)).toEqual({ request: REQUEST });
    expect(headerMap(cap.calls[0])["Content-Type"]).toBe("application/json");
    // The marker the API requires, which the browser proxy never forwards.
    expect(headerMap(cap.calls[0])[OIDC_AUTHORIZE_CALLER_HEADER]).toBe(OIDC_AUTHORIZE_CALLER_VALUE);
    expect(result).toEqual({ status: 200, body: { kind: "login", request: REQUEST } });
  });

  it("pins the caller's Origin, and forwards the visitor's Cookie only when there is one", async () => {
    const withCookie = captureFetch(jsonResponse({}));
    await requestOidcCheck({
      ...BASE,
      origin: "https://test.nemar.org",
      cookieHeader: "__Host-nemar_session=abc",
      request: REQUEST,
      fetch: withCookie.fetch,
    });
    expect(headerMap(withCookie.calls[0]).Origin).toBe("https://test.nemar.org");
    expect(headerMap(withCookie.calls[0]).Cookie).toBe("__Host-nemar_session=abc");

    const without = captureFetch(jsonResponse({}));
    await requestOidcCheck({ ...BASE, request: REQUEST, fetch: without.fetch });
    expect(headerMap(without.calls[0]).Cookie).toBeUndefined();
  });

  it("never follows a redirect, so the cookie and the request cannot be resent elsewhere", async () => {
    const cap = captureFetch(
      new Response(null, { status: 307, headers: { Location: "https://elsewhere.example/" } }),
    );
    expect(await requestOidcCheck({ ...BASE, request: REQUEST, fetch: cap.fetch })).toEqual({
      status: 307,
      body: null,
    });
    expect(cap.calls[0].redirect).toBe("manual");
  });
});

describe("requestOidcConsent", () => {
  it("posts the request, the consent token and the decision to the consent route", async () => {
    const cap = captureFetch(jsonResponse({ kind: "redirect", location: "https://x.example/cb" }));
    await requestOidcConsent({
      ...BASE,
      cookieHeader: "__Host-nemar_session=abc",
      request: REQUEST,
      consentToken: TOKEN,
      decision: "deny",
      fetch: cap.fetch,
    });
    expect(cap.urls[0].endsWith("/auth/oidc/consent")).toBe(true);
    expect(cap.urls[0]).not.toContain("secret");
    expect(JSON.parse(cap.calls[0].body as string)).toEqual({
      request: REQUEST,
      consent_token: TOKEN,
      decision: "deny",
    });
    expect(headerMap(cap.calls[0]).Origin).toBe("https://app.nemar.org");
    expect(headerMap(cap.calls[0]).Cookie).toBe("__Host-nemar_session=abc");
    expect(cap.calls[0].redirect).toBe("manual");
    expect(headerMap(cap.calls[0])[OIDC_AUTHORIZE_CALLER_HEADER]).toBe(OIDC_AUTHORIZE_CALLER_VALUE);
  });
});

describe("failures", () => {
  it("a network failure is the network sentinel, and nothing of the call is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cap = captureFetch(async () => {
      throw new TypeError(`fetch failed for ${REQUEST}`);
    });
    expect(
      await requestOidcConsent({
        ...BASE,
        request: REQUEST,
        consentToken: TOKEN,
        decision: "allow",
        fetch: cap.fetch,
      }),
    ).toEqual({ status: "network" });
    expect(warn.mock.calls.flat().map(String).join("\n")).not.toMatch(/secret/);
  });

  it("a body that is not JSON comes back as null with its status", async () => {
    const cap = captureFetch(new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await requestOidcCheck({ ...BASE, request: REQUEST, fetch: cap.fetch })).toEqual({
      status: 502,
      body: null,
    });
  });
});
