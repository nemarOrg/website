import type { MiddlewareHandler } from "astro";
import { apiBase } from "./lib/api-base";
import { type AuthSession, SESSION_COOKIE_NAME } from "./lib/auth";

/**
 * Two responsibilities in one handler:
 *
 *   1. Read the `nemar_session` cookie, resolve it to a user via
 *      `GET ${apiBase}/auth/me`, and stash the result on
 *      `context.locals.session`. The backend owns cookie verification and
 *      renewal; this just trusts the backend's `/auth/me` answer.
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

  const cache = await cacheStorage.open("nemar-edge-v1").catch(() => null);
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

  // Forward the full cookie header (not just our session cookie) so the
  // backend sees the request as it came from the browser. Avoids the case
  // where a cookie that depends on a sibling (CSRF token, etc.) fails to
  // verify because we stripped it.
  const fullCookie = context.request.headers.get("cookie") ?? `${SESSION_COOKIE_NAME}=${cookie}`;
  let session: AuthSession | null = null;
  try {
    const res = await fetch(`${apiBase()}/auth/me`, {
      method: "GET",
      headers: { Cookie: fullCookie, Accept: "application/json" },
    });
    if (res.ok) {
      const data = (await res.json()) as { user?: AuthSession["user"] | null };
      if (data?.user) session = { user: data.user };
    } else if (res.status >= 500) {
      console.warn(`[auth] /auth/me returned ${res.status}; treating request as unauthenticated`);
    }
  } catch (err) {
    console.warn("[auth] /auth/me fetch failed; treating request as unauthenticated", err);
  }
  context.locals.session = session;
}

function isPublicCacheable(response: Response): boolean {
  const cc = response.headers.get("Cache-Control");
  if (!cc) return false;
  const lower = cc.toLowerCase();
  if (lower.includes("no-store") || lower.includes("private")) return false;
  if (!lower.includes("public")) return false;
  return /max-age=\d+|s-maxage=\d+/.test(lower);
}
