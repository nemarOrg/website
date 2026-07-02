import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { APP_HOST, MARKETING_BASE_URL, MARKETING_HOST } from "./lib/host";
import {
  SECURITY_HEADERS,
  applySecurityHeaders,
  isPublicCacheable,
  onRequest,
  parseAuthMeResponse,
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
  const passthrough = async () => new Response("ok", { status: 200 });

  it("301s an app path requested on the marketing host", async () => {
    const res = await onRequest(ctx(`https://${MARKETING_HOST}/dashboard`), passthrough);
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Location")).toBe(`https://${APP_HOST}/dashboard`);
  });

  it("301s a marketing path requested on the app host, preserving query", async () => {
    const res = await onRequest(ctx(`https://${APP_HOST}/discover?modality=eeg`), passthrough);
    expect(res?.status).toBe(301);
    expect(res?.headers.get("Location")).toBe(`${MARKETING_BASE_URL}/discover?modality=eeg`);
  });

  it("uses 307 for non-GET methods so body and method aren't dropped", async () => {
    const res = await onRequest(
      ctx(`https://${MARKETING_HOST}/api/auth/logout`, "POST"),
      passthrough,
    );
    expect(res?.status).toBe(307);
    expect(res?.headers.get("Location")).toBe(`https://${APP_HOST}/api/auth/logout`);
  });

  it("doesn't set Cache-Control on cross-host redirects (deploy churn safety)", async () => {
    const res = await onRequest(ctx(`https://${MARKETING_HOST}/dashboard`), passthrough);
    expect(res?.headers.get("Cache-Control")).toBeNull();
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
    applySecurityHeaders(headers);
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("Content-Security-Policy")).toBe(
      SECURITY_HEADERS["Content-Security-Policy"],
    );
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
});
