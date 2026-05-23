/**
 * Two-host routing model.
 *
 * The authenticated surface is `app.nemar.org`. The marketing surface is
 * whatever production host serves the Astro build to the public — today
 * that's `ww2.nemar.org` (beta of the redesign), and after the apex DNS
 * cutover it'll be `nemar.org`. The apex `nemar.org` is still on a legacy
 * F5 origin as of 2026-05-23 and is NOT served by this Pages project; we
 * still classify it as "marketing" so the long-term cutover doesn't need
 * a code change beyond flipping `MARKETING_BASE_URL` below.
 *
 * The session cookie is scoped to `app.nemar.org` so it never attaches to
 * byte-range fetches against `data.nemar.org`, search hits to
 * `api.nemar.org`, or any future `discuss.nemar.org` traffic.
 *
 * Any other hostname (localhost, *.pages.dev preview, ad-hoc dev tunnels)
 * runs in "single" mode: no redirects, full nav, normal session lookup.
 * That keeps preview deploys cheap to QA without coordinating two
 * domains.
 */

export const APP_HOST = "app.nemar.org";

/**
 * Long-term canonical marketing host. Today `nemar.org` itself is on a
 * legacy origin so requests there never reach this middleware, but it's
 * still in the marketing classification set so future DNS cutover lands
 * cleanly without a code change. The full set of hosts classified as
 * marketing (including `www.nemar.org` and `ww2.nemar.org`) lives in the
 * private `MARKETING_HOSTS` Set below — renaming this constant does NOT
 * rename the others.
 */
export const MARKETING_HOST = "nemar.org";

/**
 * Where outbound cross-host marketing links and redirects actually
 * point. Today the redesigned Astro build is live at `ww2.nemar.org`;
 * once `nemar.org` DNS moves to Pages, change this to
 * `https://nemar.org` and redeploy. One-line cutover.
 */
export const MARKETING_BASE_URL = "https://ww2.nemar.org";

const APP_HOSTS: ReadonlySet<string> = new Set([APP_HOST]);
const MARKETING_HOSTS: ReadonlySet<string> = new Set([
  MARKETING_HOST,
  `www.${MARKETING_HOST}`,
  "ww2.nemar.org",
]);

const APP_ROUTE_PREFIXES: readonly string[] = [
  "/login",
  "/welcome",
  "/dashboard",
  "/upload",
  "/admin",
  "/settings",
  "/api/auth",
  "/api/admin",
];

const DATASET_COLLABORATORS_RE = /^\/dataset\/[^/]+\/collaborators\/?$/;

export type HostMode = "app" | "marketing" | "single";

export function hostMode(hostname: string): HostMode {
  // Browsers normalize Host to lowercase, but proxies and tests don't always.
  const h = hostname.toLowerCase();
  if (APP_HOSTS.has(h)) return "app";
  if (MARKETING_HOSTS.has(h)) return "marketing";
  return "single";
}

export function isAppRoute(pathname: string): boolean {
  for (const prefix of APP_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
  }
  return DATASET_COLLABORATORS_RE.test(pathname);
}

/**
 * Returns an absolute URL on the other production host when the path is
 * misrouted, or null when the current host already serves this path. Always
 * null in single-host mode; redirects only fire across the two production
 * surfaces. App-bound redirects always go to `app.nemar.org`; marketing-bound
 * redirects always go to `MARKETING_BASE_URL` (so a user on
 * `ww2.nemar.org/dashboard` lands on `app.nemar.org/dashboard`, and a user
 * on `app.nemar.org/discover` lands on `ww2.nemar.org/discover` today /
 * `nemar.org/discover` after cutover). Callers are responsible for the
 * 301 vs 307 status-code choice based on request method — this function
 * only computes the Location URL.
 */
export function getCrossHostRedirect(url: URL): string | null {
  const mode = hostMode(url.hostname);
  if (mode === "single") return null;
  const wantsApp = isAppRoute(url.pathname);
  const onAppHost = mode === "app";
  if (wantsApp === onAppHost) return null;
  const targetBase = wantsApp ? `https://${APP_HOST}` : MARKETING_BASE_URL;
  return `${targetBase}${url.pathname}${url.search}`;
}

/**
 * Build a link to a path on the app host. In single-host mode (dev,
 * preview deploys) or when the caller is already on the app host, returns
 * a relative path so the link stays in-host. From the marketing host this
 * returns an absolute `https://app.nemar.org/...` URL.
 */
export function appUrl(pathname: string, currentHostname: string): string {
  return hostMode(currentHostname) === "marketing" ? `https://${APP_HOST}${pathname}` : pathname;
}

/**
 * Mirror of `appUrl` for the marketing host. Returns an absolute URL on
 * `MARKETING_BASE_URL` when called from the app host, relative when
 * already on a marketing host or in single-host mode.
 */
export function marketingUrl(pathname: string, currentHostname: string): string {
  return hostMode(currentHostname) === "app" ? `${MARKETING_BASE_URL}${pathname}` : pathname;
}
