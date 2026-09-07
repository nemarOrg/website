/**
 * URL/method/header wiring for the device-authorization client
 * (epic #1272 phase 2). Each function is driven with a handed-in `fetch`
 * that returns a real `Response` — the `account-api.test.ts` pattern — so
 * what's under test is the request this module builds, not a stand-in for
 * backend logic.
 */

import { describe, expect, it } from "vitest";
import { decideDeviceCode, listApiKeys, lookupDeviceCode } from "./device-auth-api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Captures the single request `fetch` was called with, alongside a fixed
 *  response to answer it with. */
function captureFetch(response: Response): {
  fetch: typeof fetch;
  calls: RequestInit[];
  urls: string[];
} {
  const calls: RequestInit[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(typeof input === "string" ? input : input.toString());
    calls.push(init ?? {});
    return response;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls, urls };
}

function headerMap(init: RequestInit): Record<string, string> {
  const h = init.headers as Record<string, string> | Headers | undefined;
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  return h;
}

describe("lookupDeviceCode", () => {
  it("GETs the lookup URL with Cookie + Accept and no Origin", async () => {
    const { fetch: fetchImpl, calls, urls } = captureFetch(jsonResponse({ ok: true }));
    const result = await lookupDeviceCode("BCDF-GHJK", {
      fetch: fetchImpl,
      cookieHeader: "nemar_session=abc",
    });
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(urls[0]).toBe("https://api.nemar.org/auth/device/lookup?code=BCDF-GHJK");
    expect(calls[0]?.method).toBe("GET");
    const headers = headerMap(calls[0]);
    expect(headers.Accept).toBe("application/json");
    expect(headers.Cookie).toBe("nemar_session=abc");
    expect(headers.Origin).toBeUndefined();
  });

  it("URL-encodes the code", async () => {
    const { fetch: fetchImpl, urls } = captureFetch(jsonResponse({}));
    await lookupDeviceCode("weird code/&=", { fetch: fetchImpl });
    expect(urls[0]).toBe(
      `https://api.nemar.org/auth/device/lookup?code=${encodeURIComponent("weird code/&=")}`,
    );
  });

  it("omits Cookie when no cookieHeader is given", async () => {
    const { fetch: fetchImpl, calls } = captureFetch(jsonResponse({}));
    await lookupDeviceCode("BCDF-GHJK", { fetch: fetchImpl });
    expect(headerMap(calls[0]).Cookie).toBeUndefined();
  });

  it("becomes { status: 'network' } on a rejected fetch", async () => {
    const fetchImpl = (() => Promise.reject(new Error("network"))) as unknown as typeof fetch;
    expect(await lookupDeviceCode("BCDF-GHJK", { fetch: fetchImpl })).toEqual({
      status: "network",
    });
  });

  it("becomes body: null for a non-JSON response", async () => {
    const fetchImpl = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof fetch;
    expect(await lookupDeviceCode("BCDF-GHJK", { fetch: fetchImpl })).toEqual({
      status: 200,
      body: null,
    });
  });
});

describe("decideDeviceCode", () => {
  it("POSTs confirm with Cookie, Origin, JSON content-type and { code } body", async () => {
    const {
      fetch: fetchImpl,
      calls,
      urls,
    } = captureFetch(jsonResponse({ ok: true, machine_name: "x" }));
    const result = await decideDeviceCode("authorize", "BCDF-GHJK", {
      fetch: fetchImpl,
      cookieHeader: "nemar_session=abc",
      origin: "https://app.nemar.org",
    });
    expect(result).toEqual({ status: 200, body: { ok: true, machine_name: "x" } });
    expect(urls[0]).toBe("https://api.nemar.org/auth/device/confirm");
    expect(calls[0]?.method).toBe("POST");
    const headers = headerMap(calls[0]);
    expect(headers.Cookie).toBe("nemar_session=abc");
    expect(headers.Origin).toBe("https://app.nemar.org");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.body).toBe(JSON.stringify({ code: "BCDF-GHJK" }));
  });

  it("POSTs deny to the deny route", async () => {
    const { fetch: fetchImpl, urls } = captureFetch(jsonResponse({ ok: true }));
    await decideDeviceCode("deny", "BCDF-GHJK", {
      fetch: fetchImpl,
      origin: "https://app.nemar.org",
    });
    expect(urls[0]).toBe("https://api.nemar.org/auth/device/deny");
  });

  it("becomes { status: 'network' } on a rejected fetch", async () => {
    const fetchImpl = (() => Promise.reject(new Error("network"))) as unknown as typeof fetch;
    expect(
      await decideDeviceCode("authorize", "BCDF-GHJK", {
        fetch: fetchImpl,
        origin: "https://app.nemar.org",
      }),
    ).toEqual({ status: "network" });
  });

  it("becomes body: null for a non-JSON response", async () => {
    const fetchImpl = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof fetch;
    expect(
      await decideDeviceCode("authorize", "BCDF-GHJK", {
        fetch: fetchImpl,
        origin: "https://app.nemar.org",
      }),
    ).toEqual({ status: 200, body: null });
  });
});

describe("listApiKeys", () => {
  it("GETs /auth/keys with Cookie + Origin", async () => {
    const { fetch: fetchImpl, calls, urls } = captureFetch(jsonResponse({ keys: [] }));
    const result = await listApiKeys({
      fetch: fetchImpl,
      cookieHeader: "nemar_session=abc",
      origin: "https://test.nemar.org",
    });
    expect(result).toEqual({ status: 200, body: { keys: [] } });
    expect(urls[0]).toBe("https://api.nemar.org/auth/keys");
    expect(calls[0]?.method).toBe("GET");
    const headers = headerMap(calls[0]);
    expect(headers.Cookie).toBe("nemar_session=abc");
    expect(headers.Origin).toBe("https://test.nemar.org");
  });

  it("becomes { status: 'network' } on a rejected fetch", async () => {
    const fetchImpl = (() => Promise.reject(new Error("network"))) as unknown as typeof fetch;
    expect(await listApiKeys({ fetch: fetchImpl, origin: "https://app.nemar.org" })).toEqual({
      status: "network",
    });
  });

  it("becomes body: null for a non-JSON response", async () => {
    const fetchImpl = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof fetch;
    expect(await listApiKeys({ fetch: fetchImpl, origin: "https://app.nemar.org" })).toEqual({
      status: 200,
      body: null,
    });
  });
});
