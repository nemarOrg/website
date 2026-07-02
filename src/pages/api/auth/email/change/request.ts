import type { APIRoute } from "astro";
import { isValidEmail } from "../../../../../lib/auth";
import { forwardAuthMutation, jsonResponse } from "../../../../../lib/auth-proxy";

/**
 * Step 1 of the self-service email change (#133). The user submits a new
 * address; the backend mails a 6-digit code to that NEW address to prove
 * ownership before anything is written. Production forwards to
 * `${apiBase}/auth/email/change/request`; `astro dev` short-circuits and
 * prints the demo code so the flow is exercisable without a real backend.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  if (import.meta.env.DEV) {
    if (!locals.session) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    let body: { email?: unknown };
    try {
      body = (await request.json()) as { email?: unknown };
    } catch {
      return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!isValidEmail(email)) return jsonResponse({ ok: false, error: "invalid_email" }, 400);
    if (email === locals.session.user.email) {
      return jsonResponse({ ok: false, error: "same_email" }, 409);
    }
    // eslint-disable-next-line no-console
    console.log(`[dev-auth] email change to ${email} — use code 123456 on /settings`);
    return jsonResponse({ ok: true }, 200);
  }

  return forwardAuthMutation(request, "/auth/email/change/request");
};
