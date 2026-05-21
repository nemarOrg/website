import type { APIRoute } from "astro";
import { isValidEmail, maskEmail } from "../../../../lib/auth";

// MOCK: removed in Phase 5 cutover (nemar-cli#569).
// Single source of truth for the dev mock code.
const MOCK_CODE = "123456";

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const email =
    typeof (body as { email?: unknown })?.email === "string"
      ? (body as { email: string }).email.trim().toLowerCase()
      : "";

  if (!isValidEmail(email)) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }

  if (import.meta.env.DEV) {
    // Dev-only signal so the developer doesn't need to guess.
    console.info(`[auth/mock] code for ${email}: ${MOCK_CODE}`);
  }

  return json({ ok: true, masked_email: maskEmail(email) }, 200);
};

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
