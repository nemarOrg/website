import type { APIRoute } from "astro";
import {
  type AuthSession,
  REMEMBER_TTL_SECONDS,
  SHORT_SESSION_SECONDS,
  getSessionSecret,
  isValidEmail,
  mockUserIdFromEmail,
  setSessionCookie,
} from "../../../../lib/auth";

// MOCK: removed in Phase 5 cutover (nemar-cli#569).
// Accepts a fixed code; the real backend will validate against a stored hash.
const MOCK_ACCEPTED_CODE = "123456";

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  // The mock is dev-only. In production the deploy must proxy /api/auth/* to
  // the real backend; reaching this handler means the proxy is misconfigured.
  if (!import.meta.env.DEV) {
    return json({ ok: false, error: "not_implemented" }, 501);
  }

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
  // Dev override: a NEMAR_DEV_ADMIN_EMAIL env var (or its default
  // "admin@example.com") promotes the matching login to `role: "admin"` so
  // the admin surfaces are exercisable in dev without touching the real
  // role assignment flow. The check only runs in DEV.
  const devAdminEmail = (import.meta.env.NEMAR_DEV_ADMIN_EMAIL ?? "admin@example.com")
    .toString()
    .trim()
    .toLowerCase();
  const role: "user" | "admin" = email === devAdminEmail ? "admin" : "user";
  const session: AuthSession = {
    user: {
      id: await mockUserIdFromEmail(email),
      email,
      role,
      status: "active",
    },
    exp: Math.floor(Date.now() / 1000) + ttl,
    remember,
  };

  try {
    await setSessionCookie(cookies, session, getSessionSecret(locals));
  } catch (err) {
    // SESSION_SECRET unset, crypto failure, or malformed key — return a
    // structured 500 instead of letting Astro emit a raw worker error page.
    console.error("[auth/verify] failed to issue session cookie", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }

  return json({ user: session.user }, 200);
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
