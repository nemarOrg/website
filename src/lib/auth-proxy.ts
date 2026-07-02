/**
 * Same-origin proxy for authenticated auth-account mutations (email change,
 * profile edit, ORCID unlink). Distinct from `code/request` + `code/verify`,
 * which are pre-auth and forward only Origin: these run *inside* a session, so
 * the handler MUST forward the `nemar_session` cookie to api.nemar.org. The
 * cookie is scoped `Domain=app.nemar.org`, so a browser fetch to a same-origin
 * `/api/auth/...` route carries it automatically and this helper relays it
 * server-side — the same trick the `/api/v1` dashboard proxy uses.
 *
 * `Cache-Control: no-store` is hardcoded on every response: these are
 * per-user mutations that must never touch the edge cache. Set-Cookie is
 * mirrored so a backend that rotates the session (e.g. after an email change)
 * reaches the browser from the app host where the cookie can stick.
 */

import { apiBase, copySetCookies } from "./api-base";

const FORWARD_REQUEST_HEADERS = ["cookie", "origin", "content-type", "accept"];

export async function forwardAuthMutation(
  request: Request,
  upstreamPath: string,
): Promise<Response> {
  const upstreamHeaders = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = request.headers.get(name);
    if (v) upstreamHeaders.set(name, v);
  }
  // A server-side Worker fetch carries no Origin by default; the backend's
  // route guards reject a missing Origin, so pin it like the other proxies.
  if (!upstreamHeaders.has("origin")) {
    upstreamHeaders.set("origin", "https://app.nemar.org");
  }

  const body = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}${upstreamPath}`, {
      method: request.method,
      headers: upstreamHeaders,
      body: body.length > 0 ? body : undefined,
    });
  } catch (err) {
    console.warn(`[auth-proxy] upstream fetch failed for ${request.method} ${upstreamPath}`, err);
    return jsonResponse({ ok: false, error: "upstream_unreachable" }, 502);
  }

  const headers = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") ?? "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  copySetCookies(upstream, headers);
  const respBody = await upstream.text();
  return new Response(respBody, { status: upstream.status, headers });
}

export function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
