/**
 * Every server call that was moved to `apiFetch` must leave over the API service binding naming
 * the visitor, and must not touch the public network (website#449, ADR 0026).
 *
 * A site left on plain `fetch` is invisible at runtime: it still works, it just stays in the
 * API's shared pool, and the first-call report is satisfied by any one site that is counted per
 * visitor. So each site gets its own test. Only the two network boundaries are fixtures: a
 * recording binding, and `globalThis.fetch` as a tripwire that fails the test if anything uses it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCanonical } from "../../src/lib/api";
import { type BodyStore, cachedJson, resetApiCacheStateForTests } from "../../src/lib/api-cache";
import { resetApiFetchWarningsForTests } from "../../src/lib/api-fetch";
import { forwardAuthMutation } from "../../src/lib/auth-proxy";
import { decideDeviceCode, listApiKeys, lookupDeviceCode } from "../../src/lib/device-auth-api";
import { requestDocsGrant } from "../../src/lib/docs-auth-api";
import { proxyOrcidRedirect } from "../../src/lib/orcid-proxy";
import { requestPrivateGrant } from "../../src/lib/private-auth-api";
import { type ApiBinding, runWithRequestContext } from "../../src/lib/request-context";
import { POST as codeRequest } from "../../src/pages/api/auth/code/request";
import { POST as codeVerify } from "../../src/pages/api/auth/code/verify";
import { POST as logout } from "../../src/pages/api/auth/logout";
import { GET as noticesGet } from "../../src/pages/api/notices";
import { GET as v1Get } from "../../src/pages/api/v1/[...path]";
import { GET as newsMedia } from "../../src/pages/news/media/[file]";
import { callRoute } from "./harness";

const VISITOR = "198.51.100.7";
const API = "https://api.nemar.org";
interface Seen {
  url: string;
  method: string;
  xff: string | null;
  cookie: string | null;
}
let seen: Seen[];
let publicCalls: string[];
const realFetch = globalThis.fetch;

function bindingReplying(reply: () => Response): ApiBinding {
  return {
    async fetch(url, init) {
      const h = new Headers(init?.headers);
      seen.push({
        url,
        method: init?.method ?? "GET",
        xff: h.get("x-forwarded-for"),
        cookie: h.get("cookie"),
      });
      return reply();
    },
  };
}
const inRequest = <T>(binding: ApiBinding, fn: () => Promise<T>, extra: object = {}) =>
  runWithRequestContext({ apiBinding: binding, visitorIp: VISITOR, ...extra }, fn);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-RateLimit-Bucket": "site-ip" },
  });

beforeEach(() => {
  seen = [];
  publicCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    publicCalls.push(String(input));
    throw new Error(`unexpected public fetch: ${String(input)}`);
  }) as typeof fetch;
  resetApiFetchWarningsForTests();
  resetApiCacheStateForTests();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("DEV", false);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function expectOneBindingCall(path: string, method = "GET") {
  expect(publicCalls).toEqual([]);
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe(`${API}${path}`);
  expect(seen[0].method).toBe(method);
  expect(seen[0].xff).toBe(VISITOR);
}

describe("converted call sites leave over the API service binding", () => {
  it("api.ts resolveCanonical", async () => {
    const id = await inRequest(
      bindingReplying(() => json({ found: true, dataset_id: "on000001" })),
      () => resolveCanonical("ds002718"),
    );
    expect(id).toBe("on000001");
    expectOneBindingCall("/datasets/resolve/ds002718");
  });

  it("api-cache.ts cachedJson", async () => {
    const store: BodyStore = {
      async get() {
        return undefined;
      },
      async set() {},
      async delete() {},
    };
    const got = await inRequest(
      bindingReplying(() => json({ ok: 1 })),
      () =>
        cachedJson(`${API}/datasets?limit=1`, {
          signal: AbortSignal.timeout(5000),
          label: "list datasets",
          store,
        }),
    );
    expect(got).toEqual({ ok: 1 });
    expectOneBindingCall("/datasets?limit=1");
  });

  it("api-cache.ts: a stale-while-revalidate refresh run after the response still names the visitor who triggered it", async () => {
    const storedAt = 1_000_000;
    const entries = new Map([[`${API}/datasets?limit=10`, { body: '{"n":1}', storedAt }]]);
    const store: BodyStore = {
      async get(k) {
        return entries.get(k);
      },
      async set(k, v) {
        entries.set(k, v);
      },
      async delete(k) {
        entries.delete(k);
      },
    };
    const pending: Promise<unknown>[] = [];
    const got = await inRequest(
      bindingReplying(() => json({ n: 2 })),
      () =>
        cachedJson(`${API}/datasets?limit=10`, {
          signal: AbortSignal.timeout(5000),
          label: "list",
          store,
          now: () => storedAt + 10 * 60_000 + 1,
        }),
      {
        waitUntil: (w: Promise<unknown>) => {
          pending.push(w);
        },
      },
    );
    expect(got).toEqual({ n: 1 });
    await Promise.all(pending);
    expectOneBindingCall("/datasets?limit=10");
  });

  it("auth-proxy.ts forwardAuthMutation: a Headers instance keeps its cookie, a spoofed XFF is replaced", async () => {
    const res = await inRequest(
      bindingReplying(() => json({ ok: true })),
      () =>
        forwardAuthMutation(
          new Request("https://app.nemar.org/api/auth/profile", {
            method: "PATCH",
            headers: { cookie: "nemar_session=a", "X-Forwarded-For": "203.0.113.9" },
            body: "{}",
          }),
          "/auth/profile",
        ),
    );
    expect(res.status).toBe(200);
    expectOneBindingCall("/auth/profile", "PATCH");
    expect(seen[0].cookie).toBe("nemar_session=a");
  });

  it("orcid-proxy.ts keeps redirect: manual and relays the 3xx", async () => {
    const b = bindingReplying(
      () =>
        new Response(null, {
          status: 302,
          headers: {
            Location: "https://orcid.org/oauth/authorize?x=1",
            "X-RateLimit-Bucket": "site-ip",
          },
        }),
    );
    const res = await inRequest(b, () =>
      proxyOrcidRedirect(
        new Request("https://app.nemar.org/auth/orcid/start?next=%2Fdashboard"),
        "/auth/orcid/start",
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://orcid.org/oauth/authorize?x=1");
    expectOneBindingCall("/auth/orcid/start?next=%2Fdashboard");
  });

  it("api/v1/[...path].ts", async () => {
    const res = await inRequest(
      bindingReplying(() => json({ datasets: [] })),
      () =>
        callRoute(
          v1Get,
          "https://app.nemar.org/api/v1/datasets?mine=true",
          { path: "datasets" },
          { headers: { cookie: "nemar_session=a", "X-Forwarded-For": "203.0.113.9" } },
        ),
    );
    expect(res.status).toBe(200);
    expectOneBindingCall("/datasets?mine=true");
    expect(seen[0].cookie).toBe("nemar_session=a");
  });

  it("api/auth/code/request.ts", async () => {
    const res = await inRequest(
      bindingReplying(() => json({ ok: true })),
      () =>
        callRoute(
          codeRequest,
          "https://app.nemar.org/api/auth/code/request",
          {},
          {
            method: "POST",
            body: JSON.stringify({ email: "a@example.org" }),
            headers: { Origin: "https://app.nemar.org" },
          },
        ),
    );
    expect(res.status).toBe(200);
    expectOneBindingCall("/auth/code/request", "POST");
  });

  it("api/auth/code/verify.ts", async () => {
    const res = await inRequest(
      bindingReplying(() => json({ user: {} })),
      () =>
        callRoute(
          codeVerify,
          "https://app.nemar.org/api/auth/code/verify",
          {},
          {
            method: "POST",
            body: JSON.stringify({ email: "a@example.org", code: "123456" }),
            headers: { Origin: "https://app.nemar.org" },
          },
        ),
    );
    expect(res.status).toBe(200);
    expectOneBindingCall("/auth/code/verify", "POST");
  });

  it("api/auth/logout.ts", async () => {
    const res = await inRequest(
      bindingReplying(() => json({ ok: true })),
      () =>
        callRoute(
          logout,
          "https://app.nemar.org/api/auth/logout",
          {},
          {
            method: "POST",
            headers: { Cookie: "nemar_session=a", Origin: "https://app.nemar.org" },
          },
        ),
    );
    expect(res.status).toBe(200);
    expectOneBindingCall("/auth/logout", "POST");
  });

  it("news/media/[file].ts", async () => {
    const file = `${"ab".repeat(32)}.png`;
    const b = bindingReplying(
      () => new Response("PNG", { status: 200, headers: { "X-RateLimit-Bucket": "site-ip" } }),
    );
    const res = await inRequest(b, () =>
      callRoute(newsMedia, `https://nemar.org/news/media/${file}`, { file }),
    );
    expect(res.status).toBe(200);
    expectOneBindingCall(`/news/media/${file}`);
  });

  it("api/notices.ts", async () => {
    const res = await inRequest(
      bindingReplying(() => json({ notices: [] })),
      () =>
        callRoute(
          noticesGet,
          "https://nemar.org/api/notices",
          {},
          { headers: { cookie: "nemar_session=a" } },
        ),
    );
    expect(res.status).toBe(200);
    expectOneBindingCall("/notices");
  });

  it("docs-auth-api.ts requestDocsGrant; a 3xx comes back as itself", async () => {
    const b = bindingReplying(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://elsewhere.example/", "X-RateLimit-Bucket": "site-ip" },
        }),
    );
    const res = await inRequest(b, () =>
      requestDocsGrant({ origin: "https://app.nemar.org", cookieHeader: "nemar_session=a" }),
    );
    expect(res).toMatchObject({ status: 302 });
    expectOneBindingCall("/auth/docs/grant", "POST");
    expect(seen[0].cookie).toBe("nemar_session=a");
  });

  it("private-auth-api.ts requestPrivateGrant", async () => {
    const res = await inRequest(
      bindingReplying(() => json({ code: "c", expires_in: 60 })),
      () =>
        requestPrivateGrant({
          origin: "https://app.nemar.org",
          state: "s",
          cookieHeader: "nemar_session=a",
        }),
    );
    expect(res).toMatchObject({ status: 200 });
    expectOneBindingCall("/auth/private/grant", "POST");
  });

  it("device-auth-api.ts lookup, decide and key list", async () => {
    await inRequest(
      bindingReplying(() => json({ ok: true })),
      async () => {
        await lookupDeviceCode("ABCD-EFGH", { cookieHeader: "nemar_session=a" });
        await decideDeviceCode("authorize", "ABCD-EFGH", {
          origin: "https://app.nemar.org",
          cookieHeader: "nemar_session=a",
        });
        await listApiKeys({ origin: "https://app.nemar.org", cookieHeader: "nemar_session=a" });
      },
    );
    expect(publicCalls).toEqual([]);
    expect(seen.map((c) => [c.method, new URL(c.url).pathname, c.xff])).toEqual([
      ["GET", "/auth/device/lookup", VISITOR],
      ["POST", "/auth/device/confirm", VISITOR],
      ["GET", "/auth/keys", VISITOR],
    ]);
  });
});
