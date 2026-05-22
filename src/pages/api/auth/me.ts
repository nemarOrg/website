import type { APIRoute } from "astro";
import { apiBase } from "../../../lib/api-base";
import { SESSION_COOKIE_NAME } from "../../../lib/auth";
import { verifyDevSession } from "../../../lib/auth-dev";

/**
 * Same-origin proxy to the backend's /auth/me. Forwards the request's
 * cookies so the backend can resolve the session and returns the response
 * verbatim. In `astro dev`, a locally-signed dev cookie is verified first
 * and answered from memory.
 */
export const GET: APIRoute = async ({ request, cookies }) => {
  if (import.meta.env.DEV) {
    const local = cookies.get(SESSION_COOKIE_NAME)?.value;
    if (local) {
      const session = await verifyDevSession(local);
      if (session) {
        return new Response(JSON.stringify({ user: session.user }), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    }
  }

  const cookie = request.headers.get("cookie") ?? "";
  try {
    const res = await fetch(`${apiBase()}/auth/me`, {
      method: "GET",
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    // 502 (not 200) so callers can distinguish "backend unreachable" from
    // "anonymous". The body still carries `{ user: null }` so naive readers
    // that only check the JSON degrade gracefully.
    console.warn("[auth/me proxy] backend fetch failed", err);
    return new Response(JSON.stringify({ user: null }), {
      status: 502,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
};
