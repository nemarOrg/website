import type { APIRoute } from "astro";
import { apiBase } from "../../../lib/api-base";

/**
 * Proxies POST /auth/logout to the backend. The backend clears the cookie
 * (Set-Cookie with Max-Age=0) on its `.nemar.org` domain; we just forward
 * that header verbatim so the browser sees the same Set-Cookie response.
 *
 * CSRF: SameSite=Lax on the session cookie blocks cross-site form POSTs.
 * The user-visible worst case from a forged POST is a forced sign-out.
 */
export const POST: APIRoute = async ({ request }) => {
  const cookie = request.headers.get("cookie") ?? "";
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  } catch (err) {
    console.warn("[auth/logout proxy] backend fetch failed", err);
    res = new Response(JSON.stringify({ ok: false, error: "internal_error" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const accept = request.headers.get("Accept") ?? "";
  if (accept.includes("text/html")) {
    // Form-submit path: redirect home with the backend's Set-Cookie carried
    // through so the browser drops the session cookie.
    const headers = new Headers({ Location: "/", "Cache-Control": "no-store" });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) headers.set("Set-Cookie", setCookie);
    return new Response(null, { status: 303, headers });
  }

  const body = await res.text();
  const headers = new Headers({
    "Content-Type": res.headers.get("Content-Type") ?? "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return new Response(body, { status: res.status, headers });
};
