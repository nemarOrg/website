import type { APIRoute } from "astro";
import { proxyOrcidRedirect } from "../../../lib/orcid-proxy";

// Browser entry point for ORCID sign-in. Proxies to the api Worker's
// /auth/orcid/start, relaying its 302-to-ORCID and the state cookie. Forwards
// the query string (mode=link, next=...) verbatim.
export const GET: APIRoute = ({ request }) => proxyOrcidRedirect(request, "/auth/orcid/start");
