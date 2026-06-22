/**
 * Same-origin proxy for the ORCID OAuth redirect endpoints (website#128).
 *
 * The browser hits `/auth/orcid/start` and `/auth/orcid/callback` on the app
 * host; both forward to the api Worker's matching route. Unlike the `/api/v1`
 * proxy, these MUST NOT follow redirects (`redirect: "manual"`): the upstream
 * returns a 302 (to orcid.org from start; to /dashboard or /auth/orcid/complete
 * from callback) plus a `Set-Cookie` whose `Domain=app.nemar.org`. The cookie
 * only sticks when it reaches the browser from the app host, and a cookie set
 * directly by the sibling api host would be rejected — so we relay the 302 and
 * mirror its Set-Cookie verbatim.
 */

import { apiBase, copySetCookies } from "./api-base";

const FORWARD_HEADERS = ["cookie", "user-agent", "x-forwarded-for", "cf-connecting-ip", "origin"];

export async function proxyOrcidRedirect(
  request: Request,
  upstreamPath: string,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}${upstreamPath}${url.search}`, {
      method: "GET",
      headers,
      redirect: "manual",
    });
  } catch (err) {
    console.warn(`[orcid-proxy] upstream fetch failed for ${upstreamPath}`, err);
    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL("/login?error=orcid_unavailable", url).toString(),
        "Cache-Control": "no-store",
      },
    });
  }

  const out = new Headers({ "Cache-Control": "no-store" });
  const location = upstream.headers.get("Location");
  if (location) out.set("Location", location);
  copySetCookies(upstream, out);

  // Workers' `redirect: "manual"` surfaces the real 3xx (status + Location),
  // not a browser-style opaque redirect. Relay it; if a Location came back,
  // pin the status to 302 so a non-standard upstream status can't yield an
  // invalid Response. Without a Location the upstream isn't a usable redirect.
  if (location) {
    return new Response(null, { status: 302, headers: out });
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL("/login?error=orcid_error", url).toString(),
      "Cache-Control": "no-store",
    },
  });
}
