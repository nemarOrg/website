/**
 * Every server call that was moved to `apiFetch` must leave over the API service binding naming
 * the visitor, and must not touch the public network (website#449, ADR 0026).
 *
 * A site left on plain `fetch` is invisible at runtime: it still works, it just stays in the
 * API's shared pool, and the first-call report is satisfied by any one site that is counted per
 * visitor. So each site gets its own test. Only the two network boundaries are fixtures: a
 * recording binding, and `globalThis.fetch` as a tripwire that fails the test if anything uses it.
 *
 * The news reads are the other kind of site: `news-api.ts` also runs in the browser (the news
 * editor), so it cannot import `apiFetch` and defaults to `fetch`, and each server caller passes
 * `fetch: apiFetch` itself (ADR 0026). The three routes among them are run like the sites above;
 * the three pages are `.astro` files, which have no rendering harness here, so a source-level
 * guard reads every caller of the public news readers and fails on one that does not pass it.
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
import { GET as newsFeed } from "../../src/pages/news/feed.xml";
import { GET as newsMedia } from "../../src/pages/news/media/[file]";
import { GET as ogNewsCard } from "../../src/pages/og/news/[slug].png";
import { GET as sitemapGet } from "../../src/pages/sitemap.xml";
import catalogNm000103 from "../fixtures/jsonld-catalog-nm000103.json";
import newsList from "../fixtures/news-list-production.json";
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

function bindingReplying(reply: (url: string) => Response): ApiBinding {
  return {
    async fetch(url, init) {
      const h = new Headers(init?.headers);
      seen.push({
        url,
        method: init?.method ?? "GET",
        xff: h.get("x-forwarded-for"),
        cookie: h.get("cookie"),
      });
      return reply(url);
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

  it("api/v1/[...path].ts says so when a request with a body is answered with a redirect, instead of passing on a bare 3xx", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = bindingReplying(
      () =>
        new Response(null, {
          status: 308,
          headers: { Location: "https://api.nemar.org/elsewhere" },
        }),
    );
    const res = await inRequest(b, () =>
      callRoute(
        v1Get,
        "https://app.nemar.org/api/v1/datasets/x",
        { path: "datasets/x" },
        { method: "POST", body: "{}" },
      ),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_redirect" });
    expect(res.headers.get("location")).toBeNull();
    expect(seen).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("308"));
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

  it("news/feed.xml.ts", async () => {
    const res = await inRequest(
      bindingReplying(() => json(newsList)),
      () => callRoute(newsFeed, "https://nemar.org/news/feed.xml"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(newsList.posts[0].title);
    expectOneBindingCall("/news?limit=20");
  });

  it("sitemap.xml.ts: the news list and the catalog both name the visitor", async () => {
    const reply = (url: string) =>
      json(
        new URL(url).pathname === "/news"
          ? { ...newsList, total_count: newsList.posts.length }
          : { datasets: [catalogNm000103], count: 1, total_count: 1 },
      );
    const res = await inRequest(bindingReplying(reply), () =>
      callRoute(sitemapGet, "https://nemar.org/sitemap.xml"),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`/news/${newsList.posts[0].slug}</loc>`);
    expect(body).toContain("<loc>https://nemar.org/dataset/nm000103</loc>");
    expect(publicCalls).toEqual([]);
    expect(seen.map((c) => [new URL(c.url).pathname, c.xff]).sort()).toEqual([
      ["/datasets", VISITOR],
      ["/news", VISITOR],
    ]);
  });

  it("og/news/[slug].png.ts: only the site's own card is looked up on the public network", async () => {
    const post = { ...newsList.posts[0], body: "The body." };
    const res = await inRequest(
      bindingReplying(() => json({ post })),
      () =>
        callRoute(ogNewsCard, `https://nemar.org/og/news/${post.slug}.png`, { slug: post.slug }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(post.banner_url);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${API}/news/${post.slug}`);
    expect(seen[0].xff).toBe(VISITOR);
    // The HEAD for the rendered card is the site's own file, not the API; the tripwire turns it
    // into "no card yet", so the redirect above is to the banner.
    expect(publicCalls).toEqual([`https://nemar.org/og/news-card/${post.slug}.png`]);
  });
});

/**
 * The three pages that read the public news cannot be run here, so the guard reads them (and
 * everything else in `src`) as text: every call to `listNews`, `listAllNews` or `getNewsPost`
 * outside `news-api.ts` must hand over `fetch: apiFetch`, and each call site that exists today is
 * named, so a scan that quietly found nothing would fail too. A new caller fails the first test
 * until it passes `apiFetch`, and the second until it is added to the list. A caller in the
 * browser cannot import `apiFetch` (`client-bundle-guard.test.ts`); one would be given an
 * explicit exemption here, with the reason, rather than the guard being loosened.
 */
describe("every server caller of the public news reads passes apiFetch", () => {
  const sources = import.meta.glob("/src/**/*.{astro,ts}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const READERS = ["listNews", "listAllNews", "getNewsPost"];
  const KNOWN_CALLS: Record<string, number> = {
    "/src/pages/index.astro": 1,
    "/src/pages/news/index.astro": 1,
    "/src/pages/news/[slug].astro": 2,
    "/src/pages/news/feed.xml.ts": 1,
    "/src/pages/sitemap.xml.ts": 1,
    "/src/pages/og/news/[slug].png.ts": 1,
  };

  /** Drop comments, so the prose that names a function is not read as a call to it. */
  const withoutComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /** The text between the parentheses of each call to `name`. */
  function argumentsOfCalls(code: string, name: string): string[] {
    const found: string[] = [];
    const open = new RegExp(`\\b${name}\\(`, "g");
    for (let m = open.exec(code); m; m = open.exec(code)) {
      const start = open.lastIndex;
      let depth = 1;
      let end = start;
      while (end < code.length && depth > 0) {
        if (code[end] === "(") depth++;
        else if (code[end] === ")") depth--;
        end++;
      }
      found.push(code.slice(start, end - 1));
    }
    return found;
  }

  const calls = Object.entries(sources)
    .filter(([file]) => file !== "/src/lib/news-api.ts" && !file.endsWith(".test.ts"))
    .flatMap(([file, source]) => {
      const code = withoutComments(source);
      return READERS.flatMap((name) =>
        argumentsOfCalls(code, name).map((args) => ({
          file,
          name,
          args: args.replace(/\s+/g, " "),
          importsApiFetch:
            /import\s*\{[^}]*\bapiFetch\b[^}]*\}\s*from\s*["'][./]*\/lib\/api-fetch["']/.test(code),
        })),
      );
    });

  it("passes `fetch: apiFetch` and imports it", () => {
    const offenders = calls
      .filter((c) => !/\bfetch:\s*apiFetch\b/.test(c.args) || !c.importsApiFetch)
      .map((c) => `${c.file}: ${c.name}(${c.args})`);
    expect(offenders).toEqual([]);
  });

  it("finds the call sites that exist today, and no others", () => {
    const perFile: Record<string, number> = {};
    for (const c of calls) perFile[c.file] = (perFile[c.file] ?? 0) + 1;
    expect(perFile).toEqual(KNOWN_CALLS);
  });
});
