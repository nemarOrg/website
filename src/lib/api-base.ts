/**
 * Shared API plumbing: base-URL resolution, error-body parsing, and
 * Set-Cookie passthrough. Imported by every lib client and same-origin
 * proxy so a change to the error envelope or cookie handling lands once.
 */

const DEFAULT_API_BASE = "https://api.nemar.org";

/**
 * Resolves the api.nemar.org base URL at call time. `PUBLIC_API_BASE_URL`
 * overrides the default; set in `wrangler.toml` for production and preview
 * deploys, and overridable via .env for local dev that wants to hit a
 * non-prod backend.
 */
export function apiBase(): string {
  const fromEnv =
    (typeof import.meta.env !== "undefined" && import.meta.env.PUBLIC_API_BASE_URL) || null;
  return (fromEnv ?? DEFAULT_API_BASE).replace(/\/$/, "");
}

/**
 * Resolve the base URL for a cookie-authenticated client call.
 *
 * - **SSR** (`init.cookieHeader` passed): use `apiBase()` direct so the
 *   worker → api.nemar.org hop is just one network call. The caller has
 *   already attached the cookie to the upstream request via the explicit
 *   `Cookie` header.
 * - **Browser** (no `cookieHeader`): use the same-origin `/api/v1` proxy
 *   defined at `src/pages/api/v1/[...path].ts`. The `Domain=app.nemar.org`
 *   session cookie attaches automatically (same-origin), and the worker
 *   forwards it to api.nemar.org server-side.
 *
 * The split exists because the session cookie is deliberately scoped
 * `Domain=app.nemar.org`. Broadening to `.nemar.org` would fix the
 * client-side path trivially but would leak the cookie to every
 * `*.nemar.org` host. The proxy keeps the cookie narrow while still
 * letting browser-side dashboard mutations authenticate.
 */
export function dashboardApiBase(cookieHeader?: string): string {
  return cookieHeader ? apiBase() : "/api/v1";
}

/**
 * Parses the backend's error envelope. Used by every lib client when a
 * fetch returns non-OK. Returns `{}` for non-JSON / empty bodies so the
 * caller can still build a useful `DashboardApiError` from the status code.
 */
export async function readError(res: Response): Promise<{ message?: string; code?: string }> {
  try {
    const body = (await res.json()) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return {};
    const code = typeof body.error === "string" ? body.error : undefined;
    const message =
      typeof body.message === "string" && body.message.length > 0 ? body.message : undefined;
    return { message, code };
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}

/**
 * Copies every Set-Cookie header from `src` onto `dest`. Cloudflare Workers'
 * Fetch implementation exposes `Headers.getSetCookie()`; we fall back to
 * `.get("set-cookie")` (lossy for cookies with `Expires=...` values) for
 * runtimes that don't. Returns true when at least one cookie was copied.
 */
export function copySetCookies(src: Response, dest: Headers): boolean {
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
