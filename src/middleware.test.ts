import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { BUILD_ID } from "./lib/build-info";
import { APP_HOST, MARKETING_BASE_URL, MARKETING_HOST } from "./lib/host";
import {
  SECURITY_HEADERS,
  applySecurityHeaders,
  contentSecurityPolicy,
  isPublicCacheable,
  onRequest,
  parseAuthMeResponse,
  routeNeedsUnsafeEval,
} from "./middleware";

describe("isPublicCacheable", () => {
  const r = (cc: string | null) =>
    new Response(null, { status: 200, headers: cc ? { "Cache-Control": cc } : {} });

  it("returns false when Cache-Control is missing", () => {
    expect(isPublicCacheable(r(null))).toBe(false);
  });

  it("returns false for private responses", () => {
    expect(isPublicCacheable(r("private, max-age=600"))).toBe(false);
  });

  it("returns false for no-store", () => {
    expect(isPublicCacheable(r("public, no-store, max-age=600"))).toBe(false);
  });

  it("returns false for public without a max-age / s-maxage", () => {
    expect(isPublicCacheable(r("public"))).toBe(false);
  });

  it("returns true for public + max-age", () => {
    expect(isPublicCacheable(r("public, max-age=600"))).toBe(true);
  });

  it("returns true for public + s-maxage", () => {
    expect(isPublicCacheable(r("public, s-maxage=600"))).toBe(true);
  });
});

describe("parseAuthMeResponse", () => {
  it("returns a valid session for a well-formed /auth/me body", () => {
    const out = parseAuthMeResponse({
      user: { id: "u_1", email: "alice@example.com", role: "user", status: "active" },
    });
    expect(out).toEqual({
      user: { id: "u_1", email: "alice@example.com", role: "user", status: "active" },
    });
  });

  it("attaches optional profile fields when present and usable", () => {
    const out = parseAuthMeResponse({
      user: {
        id: "u_2",
        email: "ada@example.com",
        role: "user",
        status: "active",
        given_name: "Ada",
        family_name: "Lovelace",
        orcid: "0000-0002-1825-0097",
        orcid_verified: true,
        github_username: "ada",
        city: "London",
        country: "United Kingdom",
        affiliation: "Analytical Engine Lab",
      },
    });
    expect(out?.user).toMatchObject({
      given_name: "Ada",
      family_name: "Lovelace",
      orcid: "0000-0002-1825-0097",
      orcid_verified: true,
      github_username: "ada",
      city: "London",
      country: "United Kingdom",
      affiliation: "Analytical Engine Lab",
    });
  });

  it("omits blank / wrong-typed optional fields (sparse /auth/me)", () => {
    const out = parseAuthMeResponse({
      user: {
        id: "u_3",
        email: "sparse@example.com",
        role: "user",
        status: "active",
        given_name: "   ",
        orcid: 12345,
        orcid_verified: "yes",
      },
    });
    // Sparse body collapses to exactly the minimal shape — no undefined keys.
    expect(out).toEqual({
      user: { id: "u_3", email: "sparse@example.com", role: "user", status: "active" },
    });
    expect(out?.user).not.toHaveProperty("orcid_verified");
  });

  it("collapses backend role owner to admin while keeping backend_role", () => {
    const out = parseAuthMeResponse({
      user: { id: "u_4", email: "owner@example.com", role: "owner", status: "active" },
    });
    expect(out).toEqual({
      user: {
        id: "u_4",
        email: "owner@example.com",
        role: "admin",
        status: "active",
        backend_role: "owner",
      },
    });
  });

  it("returns null for null / non-object input", () => {
    expect(parseAuthMeResponse(null)).toBeNull();
    expect(parseAuthMeResponse(undefined)).toBeNull();
    expect(parseAuthMeResponse("string")).toBeNull();
    expect(parseAuthMeResponse(42)).toBeNull();
  });

  it("returns null when `user` is missing or null", () => {
    expect(parseAuthMeResponse({})).toBeNull();
    expect(parseAuthMeResponse({ user: null })).toBeNull();
    expect(parseAuthMeResponse({ user: "not-an-object" })).toBeNull();
  });

  it("returns null when `id` is empty, null, or a non-finite number", () => {
    expect(
      parseAuthMeResponse({
        user: { id: "", email: "a@b.com", role: "user", status: "active" },
      }),
    ).toBeNull();
    expect(
      parseAuthMeResponse({
        user: { id: null, email: "a@b.com", role: "user", status: "active" },
      }),
    ).toBeNull();
    expect(
      parseAuthMeResponse({
        user: { id: Number.NaN, email: "a@b.com", role: "user", status: "active" },
      }),
    ).toBeNull();
  });

  it("coerces a numeric id to string (backend's INTEGER PRIMARY KEY shape)", () => {
    const out = parseAuthMeResponse({
      user: { id: 42, email: "a@b.com", role: "user", status: "active" },
    });
    expect(out?.user.id).toBe("42");
  });

  it("accepts backend's default role 'member' as the website's 'user' role", () => {
    const out = parseAuthMeResponse({
      user: { id: 17, email: "researcher@example.com", role: "member", status: "active" },
    });
    expect(out?.user.role).toBe("user");
    expect(out?.user.id).toBe("17");
  });

  it("accepts backend's 'owner' role and maps to website's 'admin' (full admin UI)", () => {
    const out = parseAuthMeResponse({
      user: { id: 1, email: "founder@example.com", role: "owner", status: "active" },
    });
    expect(out?.user.role).toBe("admin");
  });

  it("returns null for unknown role values", () => {
    expect(
      parseAuthMeResponse({
        user: { id: "u", email: "a@b.com", role: "superuser", status: "active" },
      }),
    ).toBeNull();
  });

  it("returns null for unknown status values", () => {
    expect(
      parseAuthMeResponse({
        user: { id: "u", email: "a@b.com", role: "user", status: "deleted" },
      }),
    ).toBeNull();
  });

  it("accepts admin role and pending status", () => {
    const out = parseAuthMeResponse({
      user: { id: "u", email: "boss@example.com", role: "admin", status: "pending" },
    });
    expect(out?.user.role).toBe("admin");
    expect(out?.user.status).toBe("pending");
  });

  it("strips any extra fields the backend might send", () => {
    const out = parseAuthMeResponse({
      user: {
        id: "u",
        email: "a@b.com",
        role: "user",
        status: "active",
        secret_password: "hunter2",
        admin: true,
      },
    });
    expect(out?.user).toEqual({
      id: "u",
      email: "a@b.com",
      role: "user",
      status: "active",
    });
    expect((out?.user as { admin?: unknown }).admin).toBeUndefined();
  });
});

describe("onRequest host dispatch", () => {
  // Minimal APIContext shim. `locals` is observable from the outside so we
  // can verify the marketing-host fast-path sets `session = null` without
  // touching the network. A stale cookie is included on purpose: the fast
  // path must ignore it.
  type TestCtx = APIContext & { locals: { session?: unknown } };
  function ctx(url: string, method = "GET"): TestCtx {
    const request = new Request(url, { method });
    return {
      request,
      locals: {},
      cookies: { get: () => ({ value: "stale-cookie-from-other-host" }) },
    } as unknown as TestCtx;
  }

  /**
   * Same, but genuinely cookie-less. Since website#210 the presence of a
   * session cookie decides whether the app host keeps a marketing route, so
   * "has a cookie" and "has no cookie" are now distinct paths and the default
   * `ctx` above (which always supplies one) can no longer express both.
   */
  function anonCtx(url: string, method = "GET"): TestCtx {
    const request = new Request(url, { method });
    return {
      request,
      locals: {},
      cookies: { get: () => undefined },
    } as unknown as TestCtx;
  }
  const passthrough = async () => new Response("ok", { status: 200 });

  it("301s an app path requested on the marketing host", async () => {
    const res = await onRequest(ctx(`https://${MARKETING_HOST}/dashboard`), passthrough);
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Location")).toBe(`https://${APP_HOST}/dashboard`);
  });

  it("301s a marketing path requested on the app host, preserving query", async () => {
    const res = await onRequest(anonCtx(`https://${APP_HOST}/discover?modality=eeg`), passthrough);
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Location")).toBe(`${MARKETING_BASE_URL}/discover?modality=eeg`);
  });

  // website#210. The same request with a session cookie must NOT redirect: the
  // cookie is scoped to the app host, so bouncing to the marketing host is
  // what signed the user out for clicking their own nav.
  it("serves a marketing path on the app host when a session cookie is present", async () => {
    const res = await onRequest(ctx(`https://${APP_HOST}/discover?modality=eeg`), passthrough);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Location")).toBeNull();
  });

  // The asymmetry that keeps the shared edge cache safe: a cookie must never
  // persuade the marketing host to serve an authenticated route, because its
  // responses are cached and shared between visitors.
  it("still 301s an app path off the marketing host even with a cookie", async () => {
    for (const host of [MARKETING_HOST, "ww2.nemar.org"]) {
      const res = await onRequest(ctx(`https://${host}/settings`), passthrough);
      expect(res?.status).toBe(301);
      expect(res?.headers.get("Location")).toBe(`https://${APP_HOST}/settings`);
    }
  });

  it("uses 307 for non-GET methods so body and method aren't dropped", async () => {
    const res = await onRequest(
      ctx(`https://${MARKETING_HOST}/api/auth/logout`, "POST"),
      passthrough,
    );
    expect(res?.status).toBe(307);
    expect(res?.headers.get("Location")).toBe(`https://${APP_HOST}/api/auth/logout`);
  });

  // website#183. This previously asserted the header was ABSENT, under the
  // name "deploy churn safety" — but omitting Cache-Control achieves the
  // opposite of that intent: a bare 301 is heuristically cacheable and
  // browsers cache permanent redirects persistently. Since the redirect
  // encodes a route classification that can change between deploys (it did,
  // in website#181), it must not outlive the deploy that issued it.
  it("marks cross-host redirects no-store so a reclassification can reach clients", async () => {
    const res = await onRequest(ctx(`https://${MARKETING_HOST}/dashboard`), passthrough);
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("marks non-GET cross-host redirects no-store too", async () => {
    const res = await onRequest(
      ctx(`https://${MARKETING_HOST}/api/auth/logout`, "POST"),
      passthrough,
    );
    expect(res?.status).toBe(307);
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
  });

  // Retired paths are a permanent move, so caching them is defensible — but
  // they're low-traffic legacy links by definition, and the same "this is a
  // deploy-time mapping" argument applies if one is ever un-retired. The
  // saving isn't worth the asymmetry.
  it("marks retired-path redirects no-store as well", async () => {
    const res = await onRequest(ctx(`https://${MARKETING_HOST}/docs/upload`), passthrough);
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Location")).toBe("https://docs.nemar.org/web/uploading/");
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
  });

  // The edge cache must keep ignoring these regardless — isPublicCacheable
  // requires an explicit public max-age, and no-store is an explicit denial.
  it("keeps redirects out of the edge cache", async () => {
    const res = await onRequest(ctx(`https://${MARKETING_HOST}/dashboard`), passthrough);
    expect(isPublicCacheable(res as Response)).toBe(false);
  });

  // website#190. Verifies the wiring, not just the pure function: the
  // decision needs the Referer header, which only the middleware has.
  it("rewrites a legacy dataset URL to the new page for an external visitor", async () => {
    const res = await onRequest(
      ctx(`https://${MARKETING_HOST}/dataexplorer/detail?dataset_id=ds007964`),
      passthrough,
    );
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Location")).toBe("/dataset/ds007964");
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("bounces a legacy dataset URL back to ww1 when the visitor came from ww1", async () => {
    const c = ctx(`https://${MARKETING_HOST}/dataexplorer/detail?dataset_id=ds007964`);
    const withReferer = {
      ...c,
      request: new Request(c.request.url, {
        headers: { referer: "https://ww1.nemar.org/dataexplorer" },
      }),
    } as unknown as TestCtx;
    const res = await onRequest(withReferer, passthrough);
    // 302, not 301: ww1 retires, and a cached permanent redirect would
    // outlive it with no way to reach the clients holding it.
    expect(res?.status).toBe(302);
    expect(res?.headers.get("Location")).toBe(
      "https://ww1.nemar.org/dataexplorer/detail?dataset_id=ds007964",
    );
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("skips /auth/me on the marketing host and passes through with session=null", async () => {
    const c = ctx(`https://${MARKETING_HOST}/discover`);
    const res = await onRequest(c, passthrough);
    expect(res?.status).toBe(200);
    expect(c.locals.session).toBeNull();
  });

  it("passes through in single-host mode (preview / localhost)", async () => {
    const res = await onRequest(
      ctx("https://fa9dbfa0.nemar-website.pages.dev/dashboard"),
      passthrough,
    );
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe("ok");
  });
});

describe("security headers", () => {
  type TestCtx = APIContext & { locals: { session?: unknown } };
  function ctx(url: string, method = "GET"): TestCtx {
    const request = new Request(url, { method });
    return {
      request,
      locals: {},
      cookies: { get: () => undefined },
    } as unknown as TestCtx;
  }
  const passthrough = async () => new Response("ok", { status: 200 });

  it("applySecurityHeaders sets the full header set on a Headers object", () => {
    const headers = new Headers();
    applySecurityHeaders(headers, "/discover");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("Content-Security-Policy")).toBe(
      SECURITY_HEADERS["Content-Security-Policy"],
    );
  });

  it("stamps x-nemar-version on real responses but not on redirects", async () => {
    // The header is the primary way to answer "which build is live on this
    // host" (website#214), so it has to survive the passthrough path, not
    // just direct `applySecurityHeaders` calls.
    const served = await onRequest(ctx(`https://${APP_HOST}/dashboard`), passthrough);
    expect(served?.headers.get("x-nemar-version")).toBe(BUILD_ID);

    // Redirects build their headers inline and are deliberately excluded —
    // documented on applySecurityHeaders. Asserted so the exclusion stays a
    // decision rather than becoming an accident.
    const redirected = await onRequest(ctx(`https://${MARKETING_HOST}/dashboard`), passthrough);
    expect(redirected?.status).toBe(301);
    expect(redirected?.headers.get("x-nemar-version")).toBeNull();
  });

  it("applySecurityHeaders sets X-Robots-Tag only when noindex=true", () => {
    const indexed = new Headers();
    applySecurityHeaders(indexed, "/discover", false);
    expect(indexed.get("X-Robots-Tag")).toBeNull();

    const noindexed = new Headers();
    applySecurityHeaders(noindexed, "/discover", true);
    expect(noindexed.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("CSP allows the origins the client actually fetches (regression guards)", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"];
    // Client-side README fetch in dataset/[id].astro.
    expect(csp).toContain("https://raw.githubusercontent.com");
    // api / data / dashboard / zarr client fetches.
    expect(csp).toContain("https://*.nemar.org");
    // zarrita blosc/lz4/zstd WebAssembly codecs.
    expect(csp).toContain("'wasm-unsafe-eval'");
    // Inline theme-bootstrap script + Astro scoped <style>.
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("grants 'unsafe-eval' ONLY on the /dataset/* viewer route", () => {
    // numcodecs' Emscripten blosc/zstd/lz4 codecs (dynamically imported by the
    // signal viewer on dataset detail) call the Function constructor at decode
    // time; 'wasm-unsafe-eval' does not cover that, so the viewer route needs
    // 'unsafe-eval'. Every other route must stay strict. Regression guard for
    // "Failed to decode chunk via codec blosc".
    expect(routeNeedsUnsafeEval("/dataset/nm000232")).toBe(true);
    expect(routeNeedsUnsafeEval("/discover")).toBe(false);
    expect(routeNeedsUnsafeEval("/")).toBe(false);
    // A lookalike prefix must not be widened.
    expect(routeNeedsUnsafeEval("/datasets")).toBe(false);

    const viewerCsp = contentSecurityPolicy("/dataset/nm000232");
    expect(viewerCsp).toContain(
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' 'unsafe-eval'",
    );

    const strictCsp = contentSecurityPolicy("/discover");
    expect(strictCsp).not.toContain("'unsafe-eval'");
    // The base export is the strict policy (used for every non-viewer route).
    expect(SECURITY_HEADERS["Content-Security-Policy"]).not.toContain("'unsafe-eval'");
  });

  it("stamps the viewer CSP (with 'unsafe-eval') on a /dataset/* response", async () => {
    const res = await onRequest(ctx(`https://${MARKETING_HOST}/dataset/nm000232`), passthrough);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Security-Policy")).toContain("'unsafe-eval'");
  });

  it("stamps every SSR page response served by the worker", async () => {
    // Marketing host => session=null, no /auth/me round-trip, passthrough path.
    const res = await onRequest(ctx(`https://${MARKETING_HOST}/discover`), passthrough);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Security-Policy")).toBe(
      SECURITY_HEADERS["Content-Security-Policy"],
    );
    expect(res?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res?.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res?.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("stamps non-GET SSR responses too", async () => {
    const res = await onRequest(ctx(`https://${MARKETING_HOST}/discover`, "POST"), passthrough);
    expect(res?.headers.get("Content-Security-Policy")).toBe(
      SECURITY_HEADERS["Content-Security-Policy"],
    );
  });

  it("does NOT stamp CSP on cross-host redirects (no body to protect)", async () => {
    const res = await onRequest(ctx(`https://${MARKETING_HOST}/dashboard`), passthrough);
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Content-Security-Policy")).toBeNull();
    expect(res?.headers.get("X-Frame-Options")).toBeNull();
  });

  it("stamps X-Robots-Tag: noindex on preview hosts, not on production", async () => {
    const preview = await onRequest(
      ctx("https://fa9dbfa0.nemar-website.pages.dev/discover"),
      passthrough,
    );
    expect(preview?.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const prod = await onRequest(ctx(`https://${MARKETING_HOST}/discover`), passthrough);
    expect(prod?.headers.get("X-Robots-Tag")).toBeNull();
  });
});
