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
  // ORCID SSO browser flow (website#128): /auth/orcid/start + /callback proxy
  // to the api Worker, and /auth/orcid/complete collects the email for a
  // brand-new ORCID signup. App-host only so the state/pending/session cookies
  // (Domain=app.nemar.org) are sent and the OAuth redirect_uri host matches.
  "/auth",
  "/api/auth",
  "/api/admin",
  // Same-origin proxy for cookie-authenticated dashboard mutations
  // (issue #59). Lives only on the app host because the cookie scope is
  // `Domain=app.nemar.org`; if marketing classified this prefix, the
  // middleware would 301 browser-side dashboard calls away from app and
  // break the proxy entirely.
  "/api/v1",
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

/**
 * Routes that legitimately serve on BOTH production hosts and must never be
 * redirected across them.
 *
 * The app/marketing split is otherwise binary: every path belongs to exactly
 * one host and the middleware 301s it off the other. That breaks down for a
 * public endpoint consumed by chrome rendered on every page of both hosts.
 *
 * `/api/notices` is the case (website#181). It feeds the site-wide notice
 * banner, which renders on marketing *and* app pages. Classified as
 * marketing-only it 301'd cross-origin off `app.nemar.org` to
 * `ww2.nemar.org`, where no CORS headers apply — so the banner's fetch
 * rejected and no notice ever displayed to a signed-in user, including the
 * `admins`/`members`-scoped ones that only exist for them. Classified
 * app-only it would break the marketing banner the same way in reverse.
 *
 * Unlike `/api/v1` and `/api/auth`, this endpoint has no cookie-scope
 * requirement: it works with or without a session, and forwards whichever
 * cookie the request already carries same-origin.
 */
const HOST_NEUTRAL_ROUTE_PREFIXES: readonly string[] = ["/api/notices"];

export function isHostNeutralRoute(pathname: string): boolean {
  for (const prefix of HOST_NEUTRAL_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
  }
  return false;
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
  // Checked before the app/marketing decision: a host-neutral route is
  // correct on whichever host it was requested from, so there is nothing to
  // redirect (website#181).
  if (isHostNeutralRoute(url.pathname)) return null;
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

/**
 * Paths retired from this site, now served by dedicated subdomains:
 *  - the in-site `/docs` moved to the Starlight docs site (docs.nemar.org), and
 *  - the `/citation-dashboard` placeholder moved to dashboard.nemar.org.
 * Returns the external destination for a retired path, or null otherwise. Fires
 * on every host (the pages no longer exist here) and must run before
 * `getCrossHostRedirect` so a retired path never bounces through the app host.
 */
const RETIRED_DOCS: ReadonlyMap<string, string> = new Map([
  ["/docs", "https://docs.nemar.org/web/"],
  ["/docs/getting-started", "https://docs.nemar.org/web/getting-started/"],
  ["/docs/upload", "https://docs.nemar.org/web/uploading/"],
  ["/docs/managing-datasets", "https://docs.nemar.org/web/managing-datasets/"],
  ["/docs/publishing", "https://docs.nemar.org/web/publication-review/"],
  ["/docs/cli-vs-web", "https://docs.nemar.org/ecosystem/cli-vs-web/"],
]);

export function getRetiredRedirect(url: URL): string | null {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const mapped = RETIRED_DOCS.get(path);
  if (mapped) return mapped;
  if (path === "/docs" || path.startsWith("/docs/")) return "https://docs.nemar.org/";
  if (path === "/citation-dashboard" || path.startsWith("/citation-dashboard/")) {
    return "https://dashboard.nemar.org/citations";
  }
  return null;
}

/**
 * True only for the two production surfaces (`app.nemar.org` and the
 * marketing hosts, including today's `ww2.nemar.org` beta). Everything
 * else — `test.nemar.org` staging (epic #923 Phase 6), `*.pages.dev`
 * previews, dev tunnels — is not production. Used by `isNoindexHost` below
 * to keep search engines off every non-prod deploy.
 */
export function isProductionHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return APP_HOSTS.has(h) || MARKETING_HOSTS.has(h);
}

/**
 * True when a host should get a blanket `X-Robots-Tag: noindex` /
 * `robots.txt: Disallow: /` (staging, preview deploys). False for the
 * production hosts and for local dev (`localhost`, `127.0.0.1`,
 * `*.localhost`) — nothing to keep search engines off of there since it's
 * never crawlable anyway, and it keeps the dev signal distinct from "this
 * is a real non-prod deploy."
 */
export function isNoindexHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (isProductionHost(h)) return false;
  if (h === "localhost" || h === "127.0.0.1" || h.endsWith(".localhost")) return false;
  return true;
}
