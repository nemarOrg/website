import type { APIRoute } from "astro";
import { apiBase, copySetCookies } from "../../../lib/api-base";
import { isSafeProxyPath } from "../../../lib/proxy-path";

/**
 * Same-origin proxy for dashboard / admin / collaborator API calls (#59).
 *
 * The `nemar_session` cookie is deliberately scoped `Domain=app.nemar.org`
 * (host-only against siblings like `data.nemar.org`, `api.nemar.org`,
 * `docs.nemar.org`). Browser-side fetches from dashboard JS to
 * `api.nemar.org` therefore don't carry the cookie even with
 * `credentials: "include"`. This catch-all proxy lets the browser hit a
 * same-origin URL (`/api/v1/datasets?mine=true`), which automatically
 * includes the cookie, then forwards the cookie to `api.nemar.org`
 * server-side — preserving the narrow cookie scope while letting
 * client-side mutations authenticate.
 *
 * Path traversal & SSRF protection: the `[...path]` capture cannot
 * contain `..` or `://`, and cannot start with `/`. Anything matching
 * those patterns returns 400 before the upstream fetch fires.
 *
 * Routes that have their own dedicated proxy under `/api/` (e.g.
 * `/api/auth/code/request`, `/api/dataset/[id]/readme`) win over this
 * catch-all by Astro's most-specific-route resolution. Only paths under
 * `/api/v1/...` reach here.
 */

const FORWARD_REQUEST_HEADERS = [
  "cookie",
  "origin",
  "content-type",
  "accept",
  "user-agent",
  "x-requested-with",
];

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);

const proxy: APIRoute = async ({ params, request }) => {
  const rawPath = params.path;
  if (!isSafeProxyPath(rawPath)) {
    return json({ error: "invalid_path" }, 400);
  }
  if (!ALLOWED_METHODS.has(request.method)) {
    return json({ error: "method_not_allowed" }, 405);
  }

  const url = new URL(request.url);
  const targetUrl = `${apiBase()}/${rawPath}${url.search}`;

  const upstreamHeaders = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = request.headers.get(name);
    if (v) upstreamHeaders.set(name, v);
  }

  // arrayBuffer() preserves binary bodies (uploads, multipart) that
  // request.text() would corrupt by UTF-8 decoding. GET/HEAD never carry
  // bodies in HTTP semantics, so we skip allocating a buffer for them.
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body,
    });
  } catch (err) {
    console.warn(`[api/v1 proxy] upstream fetch failed for ${request.method} /${rawPath}`, err);
    return json({ error: "upstream_unreachable" }, 502);
  }

  // Forward a tight set of response headers. Skip Cloudflare / CORS /
  // transport-layer headers that don't apply to the same-origin client
  // response — they'd either confuse the browser or pin the body to the
  // wrong encoding. Set-Cookie matters when the upstream issues or
  // refreshes a session (e.g. sliding /auth/me); copy via the helper that
  // preserves multi-value cookies.
  //
  // Cache-Control is NOT forwarded from upstream. `/api/v1/*` serves
  // authenticated content by design; even a misconfigured upstream that
  // returns `Cache-Control: public, max-age=60` on a /datasets?mine=true
  // response must not let the edge cache replay that body to another
  // anonymous visitor. Hardcoding `no-store` here is the safe default.
  const respHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) respHeaders.set("Content-Type", contentType);
  respHeaders.set("Cache-Control", "no-store");
  copySetCookies(upstream, respHeaders);

  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
};

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
