import type { MiddlewareHandler } from "astro";
import {
  REMEMBER_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_RENEW_WHEN_REMAINING,
  getSessionSecret,
  sessionCookieOptions,
  signSession,
  verifySession,
} from "./lib/auth";

/**
 * Two responsibilities in one handler:
 *
 *   1. Read the `nemar_session` cookie, verify it, and stash the session on
 *      `context.locals.session`. Remember-me sessions get a sliding-window
 *      cookie refresh when they're within the renewal threshold so an active
 *      user stays signed in for another 30 days from their last visit.
 *
 *   2. Edge-cache GETs for unauthenticated traffic via Cloudflare's
 *      `caches.default`. Authenticated traffic skips the cache entirely so
 *      personalized responses (e.g. the Nav's UserMenu) don't get served to
 *      anonymous visitors out of the edge.
 *
 * Cloudflare's automatic CDN cache honors `Cache-Control: s-maxage=...` on
 * production custom domains, but skips caching on `*.pages.dev` preview URLs.
 * This middleware closes that gap by talking to `caches.default` directly:
 *
 *   - On hit: return the cached response. No Worker SSR runs at all.
 *   - On miss: run the next handler, then stash the response if it's cacheable.
 *
 * "Cacheable" = GET request + response has a `Cache-Control` header with
 * `public` (and either `max-age` or `s-maxage`). The cache key is the full
 * request URL, so query-string filters on /discover get their own entries.
 *
 * Side benefit: warm-cache hits don't run any Astro SSR, so we sidestep the
 * Worker cold-start tax for repeat visitors too.
 */
export const onRequest: MiddlewareHandler = async (context, next) => {
  await applySession(context);

  const request = context.request;
  if (request.method !== "GET") return next();
  // Skip edge cache entirely for authenticated traffic: the Nav and any
  // future personalized surface vary by session, so serving a cached anon
  // response to a signed-in user is incorrect.
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
  const raw = context.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) {
    context.locals.session = null;
    return;
  }
  let secret: string;
  try {
    secret = getSessionSecret(context.locals);
  } catch {
    context.locals.session = null;
    return;
  }
  const session = await verifySession(raw, secret);
  context.locals.session = session;

  if (!session?.remember) return;

  // Sliding-window renewal: if the cookie still has more than the renewal
  // threshold left, leave it alone. Otherwise mint a fresh 30-day cookie.
  // This keeps active users signed in indefinitely while letting truly
  // dormant cookies expire naturally.
  const now = Math.floor(Date.now() / 1000);
  if (session.exp - now < SESSION_RENEW_WHEN_REMAINING) {
    const refreshed = { ...session, exp: now + REMEMBER_TTL_SECONDS };
    try {
      const token = await signSession(refreshed, secret);
      context.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(true));
      context.locals.session = refreshed;
    } catch {
      // Renewal failure is non-fatal; the user keeps the existing session
      // until it expires naturally.
    }
  }
}

function isPublicCacheable(response: Response): boolean {
  const cc = response.headers.get("Cache-Control");
  if (!cc) return false;
  const lower = cc.toLowerCase();
  if (lower.includes("no-store") || lower.includes("private")) return false;
  if (!lower.includes("public")) return false;
  return /max-age=\d+|s-maxage=\d+/.test(lower);
}
