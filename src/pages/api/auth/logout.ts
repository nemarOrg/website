import type { APIRoute } from "astro";
import { apiBase, copySetCookies } from "../../../lib/api-base";
import { apiFetch } from "../../../lib/api-fetch";
import {
  LEGACY_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SIGNED_OUT_PATH,
} from "../../../lib/auth";
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
 * synthesized 502), we still clear the cookie locally so the browser doesn't keep a stale session
 * that the backend will reject on every subsequent request (see `appendDefensiveClears`).
 * `Secure` is set unconditionally because the Workers runtime serves over HTTPS in production.
 * A browser identifies a cookie by name, domain and path, so a clear without a `Domain` never
 * removes a cookie that was set with one. Production issues the legacy name with
 * `Domain=app.nemar.org`; the fallback therefore clears that name three ways, the same three the
 * API's own sign-out uses (nemar-cli `sessionCookieHeaders`): without a domain, with the request's
 * host, and with `nemar.org`.
 */
const CLEAR_ATTRIBUTES = "Max-Age=0; Path=/";
const CLEAR_FLAGS = "SameSite=Lax; Secure";

/** The zone a sibling host can set a legacy session cookie for. */
const PARENT_DOMAIN = "nemar.org";

/** Lower-case dot-separated labels of letters, digits and inner hyphens: nothing a `Set-Cookie`
 *  parser could read as an attribute separator (`;`, `,`), and no empty or hyphen-edged label. */
const PLAIN_HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** True for `nemar.org` and its subdomains. A browser rejects a `Domain` attribute for localhost,
 *  an IP address or any host outside the zone, so none is sent there. The hostname goes into the
 *  header as written, and the URL parser keeps `;` and `,` in a host, so the whole name must be
 *  plain before it is trusted. */
function isNemarHost(hostname: string): boolean {
  if (!PLAIN_HOSTNAME.test(hostname)) return false;
  return hostname === PARENT_DOMAIN || hostname.endsWith(`.${PARENT_DOMAIN}`);
}

/** The `Set-Cookie` values of the fallback sign-out for a request to `hostname`.
 *
 *  The `__Host-` name is cleared with no `Domain`, `Path=/` and `Secure`, because a `__Host-`
 *  cookie cannot carry a `Domain` and a clear that did would be rejected. The legacy name is
 *  cleared without a `Domain` and, on a `nemar.org` host only, with the request's host and with
 *  `nemar.org` (once when the host is `nemar.org` itself), because a browser can hold it under
 *  either scope while the API's cookie moves to the host-prefixed name (nemar-cli ADR 0119,
 *  decision 10). */
function defensiveClears(hostname: string): string[] {
  const clear = (name: string, domain?: string) =>
    [`${name}=`, CLEAR_ATTRIBUTES, ...(domain ? [`Domain=${domain}`] : []), CLEAR_FLAGS].join("; ");
  const domains = new Set<string | undefined>([undefined]);
  if (isNemarHost(hostname)) {
    domains.add(hostname);
    domains.add(PARENT_DOMAIN);
  }
  return [
    clear(SESSION_COOKIE_NAME),
    ...[...domains].map((domain) => clear(LEGACY_SESSION_COOKIE_NAME, domain)),
  ];
}

function appendDefensiveClears(headers: Headers, request: Request): void {
  for (const clear of defensiveClears(new URL(request.url).hostname)) {
    headers.append("Set-Cookie", clear);
  }
}

export const POST: APIRoute = async ({ request }) => {
  const accept = request.headers.get("Accept") ?? "";

  if (import.meta.env.DEV) {
    if (accept.includes("text/html")) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: SIGNED_OUT_PATH,
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
  // Forward Origin — backend's logout endpoint guards on it (CSRF defense)
  // and 403s without one. A Worker-side fetch carries none by default.
  const browserOrigin = request.headers.get("Origin");
  if (!browserOrigin) {
    console.warn("[auth/logout proxy] no Origin header; falling back to app.nemar.org");
  }
  const origin = browserOrigin ?? "https://app.nemar.org";
  let res: Response;
  try {
    res = await apiFetch(`${apiBase()}/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: origin,
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

  if (accept.includes("text/html")) {
    const headers = new Headers({ Location: SIGNED_OUT_PATH, "Cache-Control": "no-store" });
    const copied = copySetCookies(res, headers);
    if (!copied) appendDefensiveClears(headers, request);
    return new Response(null, { status: 303, headers });
  }

  const body = await res.text();
  const headers = new Headers({
    "Content-Type": res.headers.get("Content-Type") ?? "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  const copied = copySetCookies(res, headers);
  if (!copied) appendDefensiveClears(headers, request);
  return new Response(body, { status: res.status, headers });
};
