import type { MiddlewareHandler } from "astro";
import { apiBase } from "./lib/api-base";
import { type AuthSession, SESSION_COOKIE_NAME } from "./lib/auth";
import { verifyDevSession } from "./lib/auth-dev";
import { getCrossHostRedirect, hostMode } from "./lib/host";

/**
 * Three responsibilities in one handler:
 *
 *   1. Two-host routing. `nemar.org` and `app.nemar.org` share one Astro
 *      build but expose different surfaces. Authenticated routes requested
 *      on the marketing host (and marketing routes requested on the app
 *      host) get 301'd to the right home. Any other hostname runs in
 *      single-host mode (localhost, preview *.pages.dev) with no redirect,
 *      so QA against a preview URL doesn't need both domains wired up.
 *
 *   2. Read the `nemar_session` cookie, resolve it to a user via
 *      `GET ${apiBase}/auth/me`, and stash the result on
 *      `context.locals.session`. Skipped on the marketing host so anonymous
 *      traffic never pays the round-trip and a stale wildcard cookie can't
 *      accidentally personalize a cacheable response. In `astro dev` mode
 *      the cookie may have been issued by the local dev mock; that path
 *      verifies against the dev HMAC secret first.
 *
 *   3. Edge-cache GETs for unauthenticated traffic via Cloudflare's
 *      `caches.default`. Authenticated traffic skips the cache entirely so
 *      personalized responses (e.g. the Nav's UserMenu) don't get served to
 *      anonymous visitors out of the edge.
 *
 * The cache key is the full request URL, so query-string filters on /discover
 * get their own entries. App-host requests fan out one extra HTTP call to
 * /auth/me; that overhead is acceptable since the cache is bypassed for
 * authed traffic anyway. Marketing-host requests never call /auth/me
 * regardless of any cookies present.
 */
export const onRequest: MiddlewareHandler = async (context, next) => {
  const url = new URL(context.request.url);

  const redirectTarget = getCrossHostRedirect(url);
  if (redirectTarget) {
    // 307 preserves method + body on POST/PUT/DELETE; 301 is fine for GET/HEAD
    // navigation. No Cache-Control: browser redirect cache is plenty, and
    // CDN-caching the redirect would pin clients to the wrong host if we ever
    // re-balance the route split.
    const method = context.request.method;
    const status = method === "GET" || method === "HEAD" ? 301 : 307;
    return new Response(null, {
      status,
      headers: { Location: redirectTarget },
    });
  }

  if (hostMode(url.hostname) === "marketing") {
    context.locals.session = null;
  } else {
    await applySession(context);
  }

  const request = context.request;
  if (request.method !== "GET") return next();
  if (context.locals.session) return next();

  type Runtime = { caches?: CacheStorage };
  const runtime = (context.locals as { runtime?: Runtime } | undefined)?.runtime;
  const cacheStorage: CacheStorage | undefined =
    runtime?.caches ?? (typeof caches !== "undefined" ? caches : undefined);
  if (!cacheStorage) return next();

  // Cache namespace is versioned so bumps orphan the previous generation on
  // next deploy. v1 -> v2: pre-PR-#54 entries persisted SWR-poisoned fallback
  // HTML for /dataset/<id> partials with s-maxage=600 stale-while-revalidate=
  // 86400, and stayed served as HIT from each PoP for up to 24 h after PR #54
  // tagged future fallbacks with Cache-Control: no-store. Bumping here
  // unreferences that entire fleet. Bump again on any future change to
  // cache-policy semantics or partial-rendering logic. Issue #65.
  const cache = await cacheStorage.open("nemar-edge-v2").catch((err) => {
    // The cache layer is broken (quota error, runtime error), not just
    // unavailable. Log so we notice systemic failures, but keep serving
    // (cache is best-effort).
    console.warn("[edge-cache] cacheStorage.open failed; bypassing cache", err);
    return null;
  });
  if (!cache) return next();

  const cached = await cache.match(request);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("x-nemar-cache", "HIT");
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }

  const response = await next();
  if (response.status === 200 && isPublicCacheable(response)) {
    const clone = response.clone();
    type EdgeCtx = { waitUntil?: (p: Promise<unknown>) => void };
    const ctx = (context.locals as { runtime?: { ctx?: EdgeCtx } } | undefined)?.runtime?.ctx;
    const putPromise = cache.put(request, clone).catch(() => {
      /* cache.put rejects on Vary:* / Range responses — drop silently. */
    });
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(putPromise);
    } else {
      void putPromise;
    }
    const headers = new Headers(response.headers);
    headers.set("x-nemar-cache", "MISS");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
};

async function applySession(context: Parameters<MiddlewareHandler>[0]): Promise<void> {
  const cookie = context.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) {
    context.locals.session = null;
    return;
  }

  // Dev fast path: if the cookie was issued by the local
  // /api/auth/code/verify dev mock, it's HMAC-signed with the dev secret
  // and verifies without touching the network. A non-dev cookie won't
  // match the dev secret; we fall through to the backend lookup.
  if (import.meta.env.DEV) {
    const local = await verifyDevSession(cookie);
    if (local) {
      context.locals.session = local;
      return;
    }
  }

  // Forward the full cookie header (not just our session cookie) so the
  // backend sees the request as it came from the browser. A cookie that
  // depends on a sibling (CSRF token, etc.) won't verify if we strip it.
  const fullCookie = context.request.headers.get("cookie") ?? `${SESSION_COOKIE_NAME}=${cookie}`;
  let session: AuthSession | null = null;
  try {
    const res = await fetch(`${apiBase()}/auth/me`, {
      method: "GET",
      headers: { Cookie: fullCookie, Accept: "application/json" },
    });
    if (res.ok) {
      const data = (await res.json()) as unknown;
      session = parseAuthMeResponse(data);
    } else if (res.status >= 500) {
      console.warn(`[auth] /auth/me returned ${res.status}; treating request as unauthenticated`);
    } else if (res.status !== 401 && res.status !== 404) {
      // 403, 410, etc. from /auth/me usually mean the session is poisoned
      // (suspended account, explicitly invalidated). Worth a tail-log signal.
      console.warn(
        `[auth] /auth/me returned unexpected ${res.status}; treating as unauthenticated`,
      );
    }
  } catch (err) {
    console.warn("[auth] /auth/me fetch failed; treating request as unauthenticated", err);
  }
  context.locals.session = session;
}

/**
 * Validates the /auth/me response shape at the trust boundary. Anything
 * malformed becomes null rather than coercing through a runtime cast.
 *
 * Normalize-don't-reject at this boundary: the backend ships `id` as a
 * number (INTEGER PRIMARY KEY) and uses `"member"` as the default role.
 * Earlier versions of this parser strictly required string ids and a
 * `"user" | "admin"` role, which silently rejected every valid sign-in.
 * Now we coerce id to string and map `"member"` to the website's `"user"`
 * role; anything else (unknown role string, malformed object) still
 * returns null.
 *
 * Exported for the middleware unit tests.
 */
export function parseAuthMeResponse(raw: unknown): AuthSession | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as { user?: unknown };
  const u = body.user;
  if (!u || typeof u !== "object") return null;
  const user = u as Record<string, unknown>;

  let id: string;
  if (typeof user.id === "string" && user.id.length > 0) {
    id = user.id;
  } else if (typeof user.id === "number" && Number.isFinite(user.id)) {
    id = String(user.id);
  } else {
    return null;
  }

  if (typeof user.email !== "string" || user.email.length === 0) return null;

  // Backend ships UserRole = "owner" | "admin" | "member" (hierarchy
  // owner > admin > member). The website only has "admin" vs "user", so
  // `"owner"` collapses to `"admin"` (full admin UI) and `"member"` /
  // `"user"` collapse to `"user"`. Anything else returns null.
  let role: "user" | "admin";
  if (user.role === "owner" || user.role === "admin") {
    role = "admin";
  } else if (user.role === "user" || user.role === "member") {
    role = "user";
  } else {
    return null;
  }

  if (user.status !== "active" && user.status !== "pending" && user.status !== "disabled") {
    return null;
  }

  return { user: { id, email: user.email, role, status: user.status } };
}

export function isPublicCacheable(response: Response): boolean {
  const cc = response.headers.get("Cache-Control");
  if (!cc) return false;
  const lower = cc.toLowerCase();
  if (lower.includes("no-store") || lower.includes("private")) return false;
  if (!lower.includes("public")) return false;
  return /max-age=\d+|s-maxage=\d+/.test(lower);
}
