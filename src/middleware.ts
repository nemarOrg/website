import type { MiddlewareHandler } from "astro";
import { apiBase } from "./lib/api-base";
import { type AuthSession, SESSION_COOKIE_NAME } from "./lib/auth";
import { verifyDevSession } from "./lib/auth-dev";

/**
 * Two responsibilities in one handler:
 *
 *   1. Read the `nemar_session` cookie, resolve it to a user via
 *      `GET ${apiBase}/auth/me`, and stash the result on
 *      `context.locals.session`. The backend owns cookie verification and
 *      renewal; this just trusts the backend's `/auth/me` answer. In
 *      `astro dev` mode the cookie may have been issued by the local dev
 *      mock; we verify that against the dev HMAC secret first to save a
 *      network round-trip.
 *
 *   2. Edge-cache GETs for unauthenticated traffic via Cloudflare's
 *      `caches.default`. Authenticated traffic skips the cache entirely so
 *      personalized responses (e.g. the Nav's UserMenu) don't get served to
 *      anonymous visitors out of the edge.
 *
 * The cache key is the full request URL, so query-string filters on /discover
 * get their own entries. Authenticated requests fan out one extra HTTP call
 * to /auth/me; that overhead is acceptable since the cache is bypassed anyway
 * (every authed request runs middleware).
 */
export const onRequest: MiddlewareHandler = async (context, next) => {
  await applySession(context);

  const request = context.request;
  if (request.method !== "GET") return next();
  if (context.locals.session) return next();

  type Runtime = { caches?: CacheStorage };
  const runtime = (context.locals as { runtime?: Runtime } | undefined)?.runtime;
  const cacheStorage: CacheStorage | undefined =
    runtime?.caches ?? (typeof caches !== "undefined" ? caches : undefined);
  if (!cacheStorage) return next();

  const cache = await cacheStorage.open("nemar-edge-v1").catch((err) => {
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
 * Exported for the middleware unit tests.
 */
export function parseAuthMeResponse(raw: unknown): AuthSession | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as { user?: unknown };
  const u = body.user;
  if (!u || typeof u !== "object") return null;
  const user = u as Record<string, unknown>;
  if (typeof user.id !== "string" || user.id.length === 0) return null;
  if (typeof user.email !== "string") return null;
  if (user.role !== "user" && user.role !== "admin") return null;
  if (user.status !== "active" && user.status !== "pending" && user.status !== "disabled") {
    return null;
  }
  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
    },
  };
}

function isPublicCacheable(response: Response): boolean {
  const cc = response.headers.get("Cache-Control");
  if (!cc) return false;
  const lower = cc.toLowerCase();
  if (lower.includes("no-store") || lower.includes("private")) return false;
  if (!lower.includes("public")) return false;
  return /max-age=\d+|s-maxage=\d+/.test(lower);
}
