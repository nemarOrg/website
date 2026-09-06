import type { APIRoute } from "astro";
import { DEV_ACCEPTED_CODE, reissueDevSession } from "../../../../lib/auth-dev";
import { forwardAuthMutation, jsonResponse } from "../../../../lib/auth-proxy";

/**
 * Step 2 of email verification (website#301; nemar-cli ADR 0040 phase 2).
 * Redeems the code from step 1, which moves the account from `pending` to the
 * base tier — so the caller reloads afterwards rather than patching the page.
 *
 * Production forwards to `${apiBase}/auth/email/verify`, whose refusals are
 * typed (`code_expired`, `code_incorrect` with `attempts_remaining`,
 * `verification_incomplete`) and rendered by `verifyEmailFailure` in
 * `lib/account-tier.ts`. `astro dev` accepts the demo code and re-issues the
 * local session at `status: "active"` so the tier flip is visible without a
 * backend.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  if (import.meta.env.DEV) {
    if (!locals.session) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    let body: { code?: unknown };
    try {
      body = (await request.json()) as { code?: unknown };
    } catch {
      return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!/^\d{6}$/.test(code)) {
      return jsonResponse({ error: "code_incorrect", message: "Enter the 6-digit code." }, 401);
    }
    if (code !== DEV_ACCEPTED_CODE) {
      return jsonResponse(
        {
          error: "code_incorrect",
          message: "That code did not match. 2 attempts left before it is invalidated.",
          attempts_remaining: 2,
        },
        401,
      );
    }
    const patch = { status: "active", email_verified: true } as const;
    const user = { ...locals.session.user, ...patch };
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

  return forwardAuthMutation(request, "/auth/email/verify");
};
