import type { APIRoute } from "astro";
import { safeRedirectPath } from "../../../lib/auth";
import { proxyOrcidRedirect } from "../../../lib/orcid-proxy";

// Browser entry point for ORCID sign-in. Proxies to the api Worker's
// /auth/orcid/start, relaying its 302-to-ORCID and the state cookie.
//
// `next` is sanitized to a same-origin path before forwarding (defense in
// depth: the backend validates it too, but this route must not hand the
// backend an attacker-supplied absolute URL to embed in the OAuth state and
// later reflect into a Location). `mode` passes through; the backend coerces it.
function forwardStart(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const next = safeRedirectPath(url.searchParams.get("next"));
  if (next && next !== "/") url.searchParams.set("next", next);
  else url.searchParams.delete("next");
  return proxyOrcidRedirect(new Request(url.toString(), request), "/auth/orcid/start");
}

export const GET: APIRoute = ({ request }) => forwardStart(request);

// The Settings relink confirm submits a real form POST: the backend only
// mints mode=relink on a POST carrying a valid Origin + session (nemar-cli
// ADR 0022), so this route must accept and forward the verb. The proxy
// forwards the browser's Origin header — it must never pin its own, or a
// cross-site form post would be laundered into a same-origin one.
export const POST: APIRoute = ({ request }) => forwardStart(request);
