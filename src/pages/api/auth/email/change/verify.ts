import type { APIRoute } from "astro";
import { isValidEmail } from "../../../../../lib/auth";
import { DEV_ACCEPTED_CODE, reissueDevSession } from "../../../../../lib/auth-dev";
import { forwardAuthMutation, jsonResponse } from "../../../../../lib/auth-proxy";

/**
 * Step 2 of the self-service email change (#133). The user submits the code
 * mailed to the new address; on success the backend updates `users.email` and
 * may rotate the session. Production forwards to
 * `${apiBase}/auth/email/change/verify` and mirrors any Set-Cookie; `astro
 * dev` accepts demo code 123456 and re-signs the local dev session with the
 * new email so `/settings` reflects the change on reload.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  if (import.meta.env.DEV) {
    if (!locals.session) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    let body: { email?: unknown; code?: unknown };
    try {
      body = (await request.json()) as { email?: unknown; code?: unknown };
    } catch {
      return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!isValidEmail(email)) return jsonResponse({ ok: false, error: "invalid_email" }, 400);
    if (!/^\d{6}$/.test(code))
      return jsonResponse({ ok: false, error: "invalid_code_format" }, 400);
    if (code !== DEV_ACCEPTED_CODE)
      return jsonResponse({ ok: false, error: "code_incorrect" }, 401);

    const user = { ...locals.session.user, email };
    const cookie = await reissueDevSession(locals.session.user, { email });
    return new Response(JSON.stringify({ ok: true, user }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": cookie,
      },
    });
  }

  return forwardAuthMutation(request, "/auth/email/change/verify");
};
