import type { APIRoute } from "astro";
import { apiBase } from "../../../lib/api-base";

/**
 * Same-origin proxy to the backend's /auth/me. Forwards the request's
 * cookies so the backend can resolve the session, returns the response
 * verbatim (no caching). Lets client-side and SSR code hit a same-origin
 * URL while the cookie itself is set on .nemar.org by the backend.
 */
export const GET: APIRoute = async ({ request }) => {
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
    console.warn("[auth/me proxy] backend fetch failed", err);
    return new Response(JSON.stringify({ user: null }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
};
