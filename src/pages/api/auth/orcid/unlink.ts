import type { APIRoute } from "astro";
import { reissueDevSession } from "../../../../lib/auth-dev";
import { forwardAuthMutation, jsonResponse } from "../../../../lib/auth-proxy";

/**
 * Unlink the current ORCID iD (#134). Email-PIN sign-in still works after
 * unlinking, so the user is never locked out. Production forwards to
 * `${apiBase}/auth/orcid/unlink` (endpoint exists per nemar-cli#832); `astro
 * dev` re-signs the local dev session with the ORCID fields cleared.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  if (import.meta.env.DEV) {
    if (!locals.session) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    const patch = { orcid: undefined, orcid_verified: undefined };
    const { orcid: _o, orcid_verified: _v, ...user } = locals.session.user;
    const cookie = await reissueDevSession(locals.session.user, patch);
    return new Response(JSON.stringify({ ok: true, user }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": cookie,
      },
    });
  }

  return forwardAuthMutation(request, "/auth/orcid/unlink");
};
