import type { APIRoute } from "astro";
import { apiBase, copySetCookies } from "../../../../lib/api-base";
import { isValidEmail } from "../../../../lib/auth";
import {
  DEV_ACCEPTED_CODE,
  buildDevUser,
  devSessionCookie,
  signDevSession,
} from "../../../../lib/auth-dev";

/**
 * Same-origin proxy for the password-less code verification. In production
 * this forwards to `${apiBase}/auth/code/verify`, then mirrors the backend's
 * Set-Cookie so the browser drops the real session cookie. In `astro dev`
 * the mock accepts demo code `123456` for any valid email and issues a
 * locally-signed session cookie; the middleware's dev path verifies it.
 */
export const POST: APIRoute = async ({ request }) => {
  if (import.meta.env.DEV) {
    let body: { email?: unknown; code?: unknown };
    try {
      body = (await request.json()) as { email?: unknown; code?: unknown };
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!isValidEmail(email)) return json({ ok: false, error: "invalid_email" }, 400);
    if (!/^\d{6}$/.test(code)) return json({ ok: false, error: "invalid_code_format" }, 400);
    if (code !== DEV_ACCEPTED_CODE) return json({ ok: false, error: "code_incorrect" }, 401);

    const user = buildDevUser(email);
    const token = await signDevSession(user);
    return new Response(JSON.stringify({ user }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": devSessionCookie(token),
      },
    });
  }

  // Production proxy: forward to the real backend, mirror its Set-Cookie.
  // Forward Origin — the backend's verify endpoint gates on
  // `isAllowedOrigin` and returns 403 if it's missing; a server-side Worker
  // fetch doesn't carry one by default.
  const reqBody = await request.text();
  const origin = request.headers.get("Origin") ?? "https://app.nemar.org";
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/auth/code/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: origin,
      },
      body: reqBody,
    });
  } catch (err) {
    console.warn("[auth/code/verify proxy] backend fetch failed", err);
    return json({ ok: false, error: "internal_error" }, 502);
  }
  const respBody = await res.text();
  const headers = new Headers({
    "Content-Type": res.headers.get("Content-Type") ?? "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  // Use the iteration helper: the backend may set multiple cookies (session
  // plus CSRF, etc.) and `headers.get("set-cookie")` would comma-join them
  // into a single malformed value.
  copySetCookies(res, headers);
  return new Response(respBody, { status: res.status, headers });
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
