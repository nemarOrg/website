/**
 * Counting embed calls at the edge (website#410 phase 2, ADR 0024).
 *
 * Every `GET /dataset/<id>/embed` that the middleware answers with a 200
 * becomes one Analytics Engine data point: which dataset, which site framed it,
 * and what kind of request it was. Nothing runs in the partner's page or on the
 * visitor's device; the only input is the HTTP request the browser already
 * made to load the embed.
 *
 * This module is the pure half: it decides whether a request counts and builds
 * the point. `src/middleware.ts` owns the binding and the write.
 *
 * What a point holds, and nothing else:
 *
 *   indexes: [datasetId]
 *   blobs:   [datasetId, embedderHost, kind]
 *   doubles: [1]
 *
 * It never holds an IP address, user agent, country, cookie, query string (so
 * not `?view=` or `?theme=`), the Referer's path, or anything else about the
 * visitor. A change that adds a field belongs in a new ADR, because the
 * privacy policy describes exactly this list (nemarOrg/docs#60).
 */

import { embedRouteDatasetId } from "./embed";

/**
 * How the browser says it is loading the document (`Sec-Fetch-Dest`).
 *
 * - `iframe`: a real embed, the case the count exists for.
 * - `document`: someone opened the embed URL directly in a tab.
 * - `none`: the header is absent, which is what scripts, crawlers and link
 *   checkers send.
 * - `other`: a header that says something else (`frame`, `object`, `embed`, ...).
 */
export type EmbedKind = "iframe" | "document" | "none" | "other";

/**
 * The shape `AnalyticsEngineDataset.writeDataPoint` takes, restricted to what
 * this module writes. Declared here because the project's type-check does not
 * load `@cloudflare/workers-types` (it conflicts with the DOM lib the browser
 * code needs), and structural typing makes this assignable to the real type.
 */
export interface EmbedDataPoint {
  indexes: [string];
  blobs: [string, string, EmbedKind];
  doubles: [1];
}

/** The part of the `AnalyticsEngineDataset` binding the middleware calls. */
export interface AnalyticsBinding {
  writeDataPoint(point: EmbedDataPoint): void;
}

/**
 * A prefetch is the browser guessing, not a visitor arriving. Chromium and
 * Firefox send `Sec-Purpose: prefetch` (Chromium adds `;prerender` for a
 * prerender, which still contains the token); older Chromium and Safari send
 * `Purpose: prefetch`. Compared case-insensitively.
 */
function isPrefetch(headers: Headers): boolean {
  const secPurpose = headers.get("Sec-Purpose")?.toLowerCase() ?? "";
  const purpose = headers.get("Purpose")?.toLowerCase() ?? "";
  return secPurpose.includes("prefetch") || purpose.includes("prefetch");
}

/**
 * The longest hostname DNS allows. The URL parser accepts longer ones, and a
 * request header can carry kilobytes of them, so a hostname past this is not a
 * site and is recorded as no host rather than as junk in the host list.
 */
const MAX_HOSTNAME_LENGTH = 253;

/**
 * The embedding site's hostname, from `Referer`: lowercased, with no scheme,
 * port, path, query or userinfo. Empty when the header is absent, is not a URL
 * with a host (`about:blank`, `null`, garbage), or names a host longer than DNS
 * allows (253 characters).
 *
 * An IPv6 literal keeps its brackets (`[::1]`), as the URL parser spells it, so
 * a row never reads as a hostname it is not.
 *
 * The partner's snippet sets `referrerpolicy="origin"`, which makes the browser
 * send only the origin, so the path is rarely present at all; it is dropped
 * here regardless, in case a partner's own markup sends more.
 */
function embedderHost(headers: Headers): string {
  const referer = headers.get("Referer");
  if (!referer) return "";
  try {
    const host = new URL(referer).hostname.toLowerCase();
    return host.length > MAX_HOSTNAME_LENGTH ? "" : host;
  } catch {
    return "";
  }
}

/** `Sec-Fetch-Dest` as a kind. An empty value counts as absent. */
function embedKind(headers: Headers): EmbedKind {
  const dest = headers.get("Sec-Fetch-Dest")?.trim().toLowerCase();
  if (!dest) return "none";
  if (dest === "iframe") return "iframe";
  if (dest === "document") return "document";
  return "other";
}

/**
 * The data point for one embed request, or null when it must not be counted.
 *
 * Null for a request that is not a `GET` (so `HEAD` and `OPTIONS` never count),
 * for a prefetch, and for an empty dataset id. The caller decides the rest:
 * that the path is the embed route and that the response was a 200.
 *
 * `datasetId` is the canonical id from the URL path, as served. It is not
 * resolved or validated here.
 */
export function embedDataPoint(request: Request, datasetId: string): EmbedDataPoint | null {
  if (request.method !== "GET") return null;
  if (datasetId === "") return null;
  if (isPrefetch(request.headers)) return null;
  return {
    indexes: [datasetId],
    blobs: [datasetId, embedderHost(request.headers), embedKind(request.headers)],
    doubles: [1],
  };
}

/**
 * The data point for the response a request is about to get, or null when it
 * must not be counted. This is everything the middleware decides, in one pure
 * function, so the success path is pinned without a stand-in for the binding:
 *
 *   - `status` must be exactly 200. The `ds*` to `on*` redirect (301) is not
 *     counted, and neither is a 304, 404, 500 or 503; the 200 a redirect leads
 *     to is.
 *   - the path must be the embed route (`embedRouteDatasetId`, which reads the
 *     raw path, so an encoded spelling of the route is not counted).
 *   - the id is the `[id]` segment percent-decoded, so it spells what the page
 *     looked up. A malformed escape cannot have been served as a 200 and is not
 *     counted. The id is not resolved again.
 *   - then `embedDataPoint`'s own rules: `GET` only, no prefetch.
 */
export function embedCallPoint(request: Request, status: number): EmbedDataPoint | null {
  if (status !== 200) return null;
  const rawId = embedRouteDatasetId(new URL(request.url).pathname);
  if (rawId === null) return null;
  let datasetId: string;
  try {
    datasetId = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  return embedDataPoint(request, datasetId);
}
