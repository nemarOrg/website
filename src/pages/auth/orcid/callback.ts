import type { APIRoute } from "astro";
import { proxyOrcidRedirect } from "../../../lib/orcid-proxy";

// ORCID's registered redirect_uri (https://app.nemar.org/auth/orcid/callback).
// Forwards code+state (and the state/session cookies) to the api Worker, which
// verifies state, exchanges the code, and returns a 302 to the landing page
// plus the session cookie (or the pending-signup cookie + /auth/orcid/complete).
export const GET: APIRoute = ({ request }) => proxyOrcidRedirect(request, "/auth/orcid/callback");
