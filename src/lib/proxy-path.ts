/**
 * Path-safety guard for the `/api/v1/[...path]` catch-all proxy.
 *
 * Lives in `src/lib/` (not next to the route file) because anything under
 * `src/pages/` is treated as a route by Astro — a sibling `.test.ts`
 * gets built as `/api/v1/proxy.test`, which has no GET/POST exports and
 * fails the Cloudflare Pages production build. Keeping the helper + its
 * test here keeps src/pages free of non-route files.
 */

/**
 * Reject paths that could redirect the upstream fetch off api.nemar.org
 * or produce a malformed upstream URL. The path comes from a `[...path]`
 * capture, so it can never be empty when the route matches; the empty
 * check is a belt-and-braces guard.
 *
 * - `..` blocks traversal segments.
 * - `://` blocks scheme injection.
 * - `@` blocks userinfo-style URL fragments that could be reinterpreted
 *   by an upstream URL parser as a different authority.
 * - `//` blocks double-slash sequences that produce confusing upstream
 *   URLs (`https://api.nemar.org//datasets//`) and 4xxs that look like
 *   route bugs.
 * - A leading `/` is also rejected (would produce `${apiBase()}//path`).
 */
export function isSafeProxyPath(path: string | undefined): path is string {
  if (!path) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("..")) return false;
  if (path.includes("://")) return false;
  if (path.includes("@")) return false;
  if (path.includes("//")) return false;
  return true;
}
