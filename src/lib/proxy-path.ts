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
 * - Control characters and `\` are rejected: Astro hands the capture over
 *   decoded, and the URL parser drops a tab or a line break and reads `\`
 *   as `/`, so the upstream path would not be the path that was checked.
 */
export function isSafeProxyPath(path: string | undefined): path is string {
  if (!path) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("..")) return false;
  if (path.includes("://")) return false;
  if (path.includes("@")) return false;
  if (path.includes("//")) return false;
  if (UNSAFE_CHARACTER.test(path)) return false;
  return true;
}

/** C0 controls, DEL and the backslash. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const UNSAFE_CHARACTER = /[\u0000-\u001f\u007f\\]/;

/**
 * Whether a proxy path reaches the OpenID Connect authorization routes (nemar-cli ADR 0119): their
 * answers carry one-time codes and consent tokens, which only the /oauth/authorize page's server
 * code may read, so the browser proxy must never forward a call to them. The page calls the API
 * directly, server-side, with a marker header this proxy never forwards; this is the other half.
 *
 * The proxy asks this of the path it will actually fetch (the pathname of the upstream URL, after
 * the URL parser has resolved it), not of the capture it was handed. The path is also normalized
 * before it is matched, so a spelling the API would route the same way is refused too:
 * percent-decoding repeated until it settles (a doubly encoded letter included), tabs and line
 * breaks dropped and `\` read as `/` as the URL parser does, the query dropped, lower case, empty
 * and `.` segments removed. Any path whose segments contain `auth` followed by `oidc` is refused,
 * wherever the pair sits (the API's legacy `/nemar` mount included).
 */
export function isAuthorizationProxyPath(path: string): boolean {
  let decoded = path;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  const segments = decoded
    .replace(/[\t\n\r]/g, "")
    .replace(/\\/g, "/")
    .split("?")[0]
    .toLowerCase()
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  return segments.some((s, i) => s === "auth" && segments[i + 1] === "oidc");
}
