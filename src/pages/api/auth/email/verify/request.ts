import type { APIRoute } from "astro";
import { maskEmail } from "../../../../../lib/auth";
import { forwardAuthMutation, jsonResponse } from "../../../../../lib/auth-proxy";

/**
 * Step 1 of email verification (website#301; nemar-cli ADR 0040 phase 2).
 * Re-mails the 6-digit code to the signed-in account's OWN address so it can
 * leave `pending` for the base tier.
 *
 * No request body is forwarded beyond what the browser sent, and the backend
 * ignores it: the target is `users.email`, which is what stops this being a
 * mail-anyone primitive. Production forwards to
 * `${apiBase}/auth/email/verify/request` (Origin-allow-listed, so
 * `forwardAuthMutation` pins one); `astro dev` echoes the demo code so the
 * flow is exercisable locally, matching `/api/auth/email/change/request`.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  if (import.meta.env.DEV) {
    if (!locals.session) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    const email = locals.session.user.email;
    if (locals.session.user.status !== "pending") {
      return jsonResponse(
        { ok: true, already_verified: true, masked_email: maskEmail(email) },
        200,
      );
    }
    console.log(`[dev-auth] email verification for ${email} — use code 123456 on /dashboard`);
    return jsonResponse({ ok: true, masked_email: maskEmail(email), dev_code: "123456" }, 200);
  }

  return forwardAuthMutation(request, "/auth/email/verify/request");
};
