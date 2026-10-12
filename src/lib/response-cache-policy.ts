/**
 * Cache headers the middleware imposes on a response after a page has set its
 * own, for two cases a page cannot see from inside a render. Pure, so it is
 * unit-testable without an Astro context.
 *
 * 1. The page was built from data that was not fresh (`api-cache.ts` served a
 *    stored copy while the API was refusing, or while a refresh ran behind the
 *    response). Pages ask the edge to keep them for an hour; an hour of someone's
 *    stale render shared by every visitor would pin that data well past the
 *    moment the API recovered. Such a page is kept for a minute.
 * 2. The request carried a session cookie. The edge never stores those, but a
 *    page's own `public` header would still let the visitor's browser keep HTML
 *    that names them, and show it to whoever uses the browser next.
 */

/** A page built from stale data stays at the edge a minute, not an hour. */
export const STALE_DATA_CACHE_CONTROL = "public, max-age=0, s-maxage=60";

/** A signed-in page is the visitor's own and is revalidated, never reused. */
export const SESSION_CACHE_CONTROL = "private, max-age=0, must-revalidate";

/** Whether a `Cache-Control` value asks for shared caches to keep the response. */
function isShared(cacheControl: string | null): boolean {
  if (!cacheControl) return false;
  const lower = cacheControl.toLowerCase();
  return lower.includes("public") && !lower.includes("no-store") && !lower.includes("private");
}

function rebuilt(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Mark a response built from stale data, and shorten its shared-cache lifetime. */
export function withStaleDataHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-nemar-data", "stale");
  if (isShared(headers.get("Cache-Control"))) {
    headers.set("Cache-Control", STALE_DATA_CACHE_CONTROL);
  }
  return rebuilt(response, headers);
}

/**
 * A signed-in HTML page must not be `public`. Other responses (hashed assets,
 * JSON) are left alone: an immutable stylesheet is the same for everyone.
 */
export function privateIfPublicHtml(response: Response): Response {
  const type = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!type.includes("text/html") || !isShared(response.headers.get("Cache-Control"))) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", SESSION_CACHE_CONTROL);
  return rebuilt(response, headers);
}
