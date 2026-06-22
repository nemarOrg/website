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

// Mirror the /api/v1 proxy's forward set. Deliberately omits x-forwarded-for /
// cf-connecting-ip: the upstream's own CF edge sets cf-connecting-ip to this
// Worker's IP, and forwarding a browser-supplied XFF would let a client spoof
// the IP the backend records.
const FORWARD_HEADERS = ["cookie", "user-agent", "origin"];

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

  // Copy any Set-Cookie first so an error response that clears the state/pending
  // cookie still reaches the browser even on the fallback path below.
  const out = new Headers({ "Cache-Control": "no-store" });
  copySetCookies(upstream, out);

  // Workers' `redirect: "manual"` surfaces the real 3xx (status + Location),
  // not a browser-style opaque redirect. Relay it; pin the status to 302 so a
  // non-standard upstream status can't yield an invalid Response.
  const location = upstream.headers.get("Location");
  if (location) {
    out.set("Location", location);
    return new Response(null, { status: 302, headers: out });
  }

  // No Location: the upstream isn't a usable redirect (a non-3xx status, or a
  // backend error). Log it so a backend outage is distinguishable from a real
  // redirect, then fall back without dropping any cookies the upstream set.
  console.warn(
    `[orcid-proxy] no redirect from ${upstreamPath} (upstream status ${upstream.status}); falling back to login`,
  );
  out.set("Location", new URL("/login?error=orcid_error", url).toString());
  return new Response(null, { status: 302, headers: out });
}
