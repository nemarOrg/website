/**
 * Edge cache key normalization (website#326).
 *
 * `src/middleware.ts` caches unauthenticated GETs in `caches.default`, keyed by
 * the request URL. Query-string filters on `/discover` genuinely change the
 * rendered HTML and earn their own entries — but a parameter the server never
 * reads does not, and keying on it stores the same bytes twice.
 *
 * The dataset page's `?view=` deep link is that case: it names a recording for
 * the *browser* to open, resolved against a Zarr index fetched client-side long
 * after the HTML was rendered. An external catalog publishing one link per
 * subject would otherwise fill the cache with N copies of one page, and every
 * one of those links would take a full origin round-trip on first request.
 *
 * Kept out of `middleware.ts` so it is unit-testable without an Astro context.
 */

import { VIEW_PARAM } from "./eeg-viewer/recording-nav";

/**
 * Parameters that never reach the server's rendering path, and so must not
 * fragment the cache.
 *
 * Add to this list only for a parameter that is *provably* client-only. A
 * parameter the SSR path reads (`?v=` for the dataset version, `/discover`'s
 * filters) belongs in the key: stripping it would serve one URL's HTML for
 * another's.
 */
export const CLIENT_ONLY_QUERY_PARAMS: readonly string[] = [VIEW_PARAM];

/**
 * The URL a request should be cached under.
 *
 * Returns the input string unchanged when it carries no client-only parameter,
 * which is the overwhelmingly common case: that avoids both the allocation and
 * any chance of `URL` round-tripping normalizing the key away from the form
 * previously cached entries used.
 */
export function edgeCacheUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Not parseable as an absolute URL. Nothing to strip, and the caller's own
    // request object remains a perfectly good key.
    return rawUrl;
  }
  let stripped = false;
  for (const param of CLIENT_ONLY_QUERY_PARAMS) {
    if (!url.searchParams.has(param)) continue;
    url.searchParams.delete(param);
    stripped = true;
  }
  return stripped ? url.toString() : rawUrl;
}
