import type { APIRoute } from "astro";
import { apiBase } from "../../../lib/api-base";
import { newsMediaContentType } from "../../../lib/news";

/**
 * `/news/media/<sha256>.<ext>`: a news image, served from this origin.
 *
 * The bytes live in the API Worker's R2 bucket (nemarOrg/nemar-cli#1551);
 * this route streams them through so the page can keep `img-src 'self'`
 * and so a post's stored URL is site-relative, working unchanged on
 * staging and production.
 *
 * Names are content hashes, so a response is valid forever: it is marked
 * immutable, and the edge cache in `middleware.ts` keeps it after the first
 * request. Anything that is not a name the backend mints is a 404 before any
 * upstream call, which also rules out path tricks.
 *
 * Host-neutral (see `HOST_NEUTRAL_ROUTE_PREFIXES` in `host.ts`): the admin
 * editor on app.nemar.org shows the same images, and a cross-host redirect
 * would leave `img-src 'self'` behind.
 */
export const GET: APIRoute = async ({ params }) => {
  const file = params.file ?? "";
  const contentType = newsMediaContentType(file);
  if (!contentType) return notFound();

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}/news/media/${file}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.warn(
      `[news/media] ${file} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Response(null, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  if (upstream.status === 404) return notFound();
  if (!upstream.ok || !upstream.body) {
    return new Response(null, { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  const headers = new Headers({
    // From the name, not the upstream: the name is what we validated.
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);
  const etag = upstream.headers.get("etag");
  if (etag) headers.set("ETag", etag);
  return new Response(upstream.body, { status: 200, headers });
};

function notFound(): Response {
  // Short-lived: a 404 for an image that is being uploaded right now must
  // not stick at the edge.
  return new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
}
