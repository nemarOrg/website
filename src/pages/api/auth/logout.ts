import type { APIRoute } from "astro";
import { apiBase } from "../../../lib/api-base";
import { SESSION_COOKIE_NAME } from "../../../lib/auth";
import { devClearSessionCookie } from "../../../lib/auth-dev";

/**
 * Proxies POST /auth/logout to the backend. The backend clears the cookie
 * (Set-Cookie with Max-Age=0) on its `.nemar.org` domain; we forward that
 * Set-Cookie response so the browser drops the real session cookie. In
 * `astro dev` we unconditionally clear the locally-issued dev cookie.
 *
 * CSRF: SameSite=Lax on the session cookie blocks cross-site form POSTs.
 * The user-visible worst case from a forged POST is a forced sign-out.
 *
 * Defensive clear: if the backend doesn't issue a Set-Cookie (unreachable,
 * synthesized 502), we still clear the cookie locally so the browser
 * doesn't keep a stale session that the backend will reject on every
 * subsequent request.
 */

/** Belt-and-braces cookie clear when the backend doesn't supply one. */
const DEFENSIVE_CLEAR_COOKIE = `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;

/**
 * Append every Set-Cookie value from `src` onto `dest`. Cloudflare Workers'
 * Fetch implementation exposes `Headers.getSetCookie()`; we fall back to
 * `.get("set-cookie")` for runtimes that don't (the comma-joined form is
 * lossy for cookies with `Expires=...` but acceptable as a last resort).
 */
function copySetCookies(src: Response, dest: Headers): boolean {
  const getter = (src.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getter === "function") {
    const values = getter.call(src.headers);
    for (const v of values) dest.append("Set-Cookie", v);
    return values.length > 0;
  }
  const single = src.headers.get("set-cookie");
  if (!single) return false;
  dest.append("Set-Cookie", single);
  return true;
}

export const POST: APIRoute = async ({ request }) => {
  const accept = request.headers.get("Accept") ?? "";

  if (import.meta.env.DEV) {
    if (accept.includes("text/html")) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Cache-Control": "no-store",
          "Set-Cookie": devClearSessionCookie,
        },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": devClearSessionCookie,
      },
    });
  }

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
      // Body `{}` required; some backends reject a missing or non-JSON
      // content-type body even when no payload is needed.
      body: "{}",
    });
  } catch (err) {
    console.warn("[auth/logout proxy] backend fetch failed", err);
    res = new Response(JSON.stringify({ ok: false, error: "internal_error" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (accept.includes("text/html")) {
    const headers = new Headers({ Location: "/", "Cache-Control": "no-store" });
    const copied = copySetCookies(res, headers);
    if (!copied) headers.set("Set-Cookie", DEFENSIVE_CLEAR_COOKIE);
    return new Response(null, { status: 303, headers });
  }

  const body = await res.text();
  const headers = new Headers({
    "Content-Type": res.headers.get("Content-Type") ?? "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  const copied = copySetCookies(res, headers);
  if (!copied) headers.set("Set-Cookie", DEFENSIVE_CLEAR_COOKIE);
  return new Response(body, { status: res.status, headers });
};
