import type { APIRoute } from "astro";
import {
  type AuthSession,
  REMEMBER_TTL_SECONDS,
  getSessionSecret,
  isValidEmail,
  mockUserIdFromEmail,
  setSessionCookie,
} from "../../../../lib/auth";

// MOCK: removed in Phase 5 cutover (nemar-cli#569).
// Accepts a fixed code; the real backend will validate against a stored hash.
const MOCK_ACCEPTED_CODE = "123456";
const SHORT_SESSION_SECONDS = 60 * 60 * 8; // 8 hours when not "remember me"

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const b = body as { email?: unknown; code?: unknown; remember?: unknown };
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const code = typeof b.code === "string" ? b.code.trim() : "";
  const remember = b.remember === true;

  if (!isValidEmail(email)) return json({ ok: false, error: "invalid_email" }, 400);
  if (!/^\d{6}$/.test(code)) return json({ ok: false, error: "invalid_code_format" }, 400);
  if (code !== MOCK_ACCEPTED_CODE) {
    return json({ ok: false, error: "code_incorrect" }, 401);
  }

  const ttl = remember ? REMEMBER_TTL_SECONDS : SHORT_SESSION_SECONDS;
  const session: AuthSession = {
    id: await mockUserIdFromEmail(email),
    email,
    role: "user",
    status: "active",
    exp: Math.floor(Date.now() / 1000) + ttl,
    remember,
  };
  await setSessionCookie(cookies, session, getSessionSecret(locals));

  return json(
    {
      user: {
        id: session.id,
        email: session.email,
        role: session.role,
        status: session.status,
      },
    },
    200,
  );
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
