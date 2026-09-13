/**
 * Request wiring for the docs-handoff grant client (nemar-cli#1338).
 *
 * Driven with a handed-in `fetch` returning a real `Response`, the
 * `device-auth-api.test.ts` pattern, so what is under test is the request this
 * module builds rather than a stand-in for backend logic.
 *
 * WHY THIS FILE EXISTS AT ALL, since the module is thirty lines of plumbing.
 * It shipped without one, and review found what that cost: deleting the
 * `Origin` header at `docs-auth-api.ts:61` left every other test in the PR
 * green while turning the whole handoff into `403 {"error":"Origin not
 * allowed"}` from the backend, which reads as an outage rather than as a
 * missing header. A server-side `fetch` sends no Origin of its own and
 * `isAllowedOrigin` refuses an absent one, so that header is load-bearing and
 * nothing was holding it down. `test/docs-authorize-ui.test.ts` proves only
 * that the PAGE passes an `origin` field in; it cannot see what the client
 * does with it.
 */

import { describe, expect, it } from "vitest";
import { requestDocsGrant } from "./docs-auth-api";

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

describe("requestDocsGrant", () => {
  it("pins the caller's Origin, which the backend checks before authentication", async () => {
    const cap = captureFetch(jsonResponse({ code: "abc", expires_in: 60 }));
    await requestDocsGrant({ fetch: cap.fetch, origin: "https://app.nemar.org" });
    // The assertion the missing file cost us. Without this header the backend
    // answers 403 with a perfectly valid session attached.
    expect(headerMap(cap.calls[0]).Origin).toBe("https://app.nemar.org");
  });

  it("posts to the grant route with a JSON body", async () => {
    const cap = captureFetch(jsonResponse({ code: "abc", expires_in: 60 }));
    await requestDocsGrant({ fetch: cap.fetch, origin: "https://app.nemar.org" });
    expect(cap.urls[0].endsWith("/auth/docs/grant")).toBe(true);
    expect(cap.calls[0].method).toBe("POST");
    expect(cap.calls[0].body).toBe("{}");
    expect(headerMap(cap.calls[0])["Content-Type"]).toBe("application/json");
  });

  it("forwards the visitor's Cookie header when the caller has one", async () => {
    const cap = captureFetch(jsonResponse({ code: "abc", expires_in: 60 }));
    await requestDocsGrant({
      fetch: cap.fetch,
      origin: "https://app.nemar.org",
      cookieHeader: "nemar_session=xyz",
    });
    expect(headerMap(cap.calls[0]).Cookie).toBe("nemar_session=xyz");
  });

  it("sends no Cookie header when the caller has none", async () => {
    // Rather than an empty one: `undefined` and `""` reach the backend
    // differently, and only the absent case is what a cookieless SSR render is.
    const cap = captureFetch(jsonResponse({ code: "abc", expires_in: 60 }));
    await requestDocsGrant({ fetch: cap.fetch, origin: "https://app.nemar.org" });
    expect("Cookie" in headerMap(cap.calls[0])).toBe(false);
  });

  it("returns the real status alongside the parsed body", async () => {
    const cap = captureFetch(jsonResponse({ code: "abc", expires_in: 60 }));
    const result = await requestDocsGrant({ fetch: cap.fetch, origin: "https://app.nemar.org" });
    expect(result).toEqual({ status: 200, body: { code: "abc", expires_in: 60 } });
  });

  it("passes a 404 through as a status rather than treating it as an error", async () => {
    // A signed-in non-admin. `docsGrantOutcome` turns this into `/404`, so it
    // has to arrive as a status and not as a throw or a network sentinel.
    const cap = captureFetch(jsonResponse({ error: "not_found" }, 404));
    const result = await requestDocsGrant({ fetch: cap.fetch, origin: "https://app.nemar.org" });
    expect(result).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("reports a non-JSON body as a null body, keeping the status", async () => {
    const cap = captureFetch(new Response("<html>maintenance</html>", { status: 502 }));
    const result = await requestDocsGrant({ fetch: cap.fetch, origin: "https://app.nemar.org" });
    expect(result).toEqual({ status: 502, body: null });
  });

  it("answers the network sentinel when the fetch never returns a response", async () => {
    const cap = captureFetch(async () => {
      throw new TypeError("connection refused");
    });
    const result = await requestDocsGrant({ fetch: cap.fetch, origin: "https://app.nemar.org" });
    expect(result).toEqual({ status: "network" });
  });

  it("never throws, whatever the transport does", async () => {
    const cap = captureFetch(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(
      requestDocsGrant({ fetch: cap.fetch, origin: "https://app.nemar.org" }),
    ).resolves.toEqual({ status: "network" });
  });
});
