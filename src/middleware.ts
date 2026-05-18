import type { MiddlewareHandler } from "astro";

/**
 * Edge cache via Cloudflare Workers Cache API.
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
  const request = context.request;
  if (request.method !== "GET") return next();

  // Cloudflare exposes the Workers runtime via locals.runtime when the
  // @astrojs/cloudflare adapter is configured. We pull `caches` from there
  // for compatibility with Astro's typing; in production this resolves to
  // the global `caches` provided by the Workers runtime.
  type Runtime = { caches?: CacheStorage };
  const runtime = (context.locals as { runtime?: Runtime } | undefined)?.runtime;
  const cacheStorage: CacheStorage | undefined =
    runtime?.caches ?? (typeof caches !== "undefined" ? caches : undefined);
  if (!cacheStorage) return next();

  const cache = await cacheStorage.open("nemar-edge-v1").catch(() => null);
  if (!cache) return next();

  const cached = await cache.match(request);
  if (cached) {
    // Surface that this came from our cache so we can see it in `curl -I`.
    const headers = new Headers(cached.headers);
    headers.set("x-nemar-cache", "HIT");
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }

  const response = await next();
  // Only cache successful, explicitly-public responses. Skip 5xx/4xx and
  // anything carrying `Cache-Control: no-store` or `private`.
  if (response.status === 200 && isPublicCacheable(response)) {
    const clone = response.clone();
    // Fire-and-forget. The Workers runtime gives middleware access to
    // `waitUntil` via locals.runtime.ctx when available; fall back to a
    // bare promise so dev still works.
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

function isPublicCacheable(response: Response): boolean {
  const cc = response.headers.get("Cache-Control");
  if (!cc) return false;
  const lower = cc.toLowerCase();
  if (lower.includes("no-store") || lower.includes("private")) return false;
  if (!lower.includes("public")) return false;
  return /max-age=\d+|s-maxage=\d+/.test(lower);
}
