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
 * Where outbound cross-host marketing links and redirects actually point.
 *
 * Flipped to the apex at cutover (website#190). `ww2.nemar.org` stays in
 * `MARKETING_HOSTS` below and keeps serving — deliberately. Browsers have
 * cached the old bare-301 apex → ww2 bridge, and if ww2 redirected back to
 * the apex those clients would loop with no server-side remedy. Retire ww2
 * only once those cached entries have aged out.
 *
 * Canonical URLs, OG URLs and cross-host redirects all derive from this, so
 * a ww2 page automatically canonicalises to the apex and stops competing
 * with it in search.
 */
export const MARKETING_BASE_URL = "https://nemar.org";

const APP_HOSTS: ReadonlySet<string> = new Set([APP_HOST]);
const MARKETING_HOSTS: ReadonlySet<string> = new Set([
  MARKETING_HOST,
  `www.${MARKETING_HOST}`,
  "ww2.nemar.org",
]);

const APP_ROUTE_PREFIXES: readonly string[] = [
  "/login",
  "/welcome",
  // Post-sign-in account setup (website#301): username, name, location. App
  // host only for the same reason /settings is — it reads and PATCHes the
  // session's own account through the `Domain=app.nemar.org` cookie.
  "/onboarding",
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

export interface CrossHostOptions {
  /**
   * True when the request carries a session cookie. Presence only — the cookie
   * has NOT been validated at the point this runs, because validating it costs
   * an `/auth/me` round-trip and the redirect decision happens before that.
   *
   * A stale or forged cookie therefore buys nothing beyond having a marketing
   * page rendered on the app host instead of redirected to the marketing host.
   * The page still resolves the session properly downstream and renders
   * signed-out, so the worst case is a slightly slower anonymous render on the
   * wrong host, not disclosure.
   */
  readonly hasSession?: boolean;
}

/**
 * Returns an absolute URL on the other production host when the path is
 * misrouted, or null when the current host should serve this path itself.
 * Always null in single-host mode; redirects only fire across the two
 * production surfaces. Callers are responsible for the 301 vs 307 status-code
 * choice based on request method — this function only computes the Location.
 *
 * Marketing-bound redirects are suppressed for a request that carries a
 * session (website#210). A signed-in user clicking Discover used to be sent
 * from `app.nemar.org` to the marketing host, where the session cookie does
 * not travel and `/auth/me` is deliberately never called — so they watched
 * themselves get signed out for using the nav. Now the app host renders the
 * marketing route itself, keeping the session and the nav intact.
 *
 * The suppression is deliberately one-directional:
 *
 * - **app -> marketing is suppressed** when a session is present. The app host
 *   is already uncached and already personalized, so serving a marketing route
 *   there costs nothing and changes no caching assumption.
 * - **marketing -> app is NEVER suppressed**, cookie or not. The marketing
 *   host's whole value is that its responses are anonymous and edge-cacheable;
 *   letting a cookie change what it serves would vary a shared cache entry on
 *   a per-user header and leak one visitor's page to the next. Authenticated
 *   routes belong on the app host unconditionally.
 */
export function getCrossHostRedirect(url: URL, opts: CrossHostOptions = {}): string | null {
  const mode = hostMode(url.hostname);
  if (mode === "single") return null;
  // Checked before the app/marketing decision: a host-neutral route is
  // correct on whichever host it was requested from, so there is nothing to
  // redirect (website#181).
  if (isHostNeutralRoute(url.pathname)) return null;
  const wantsApp = isAppRoute(url.pathname);
  const onAppHost = mode === "app";
  if (wantsApp === onAppHost) return null;
  if (onAppHost && !wantsApp && opts.hasSession) return null;
  const targetBase = wantsApp ? `https://${APP_HOST}` : MARKETING_BASE_URL;
  return `${targetBase}${url.pathname}${url.search}`;
}

/**
 * Origin a page should declare as its canonical home, which is a property of
 * the *route*, not of the host that happened to serve the request.
 *
 * This mattered less before website#210: a marketing route could only ever be
 * served by the marketing host, so "canonical = serving host" gave the right
 * answer by construction. Now that the app host renders marketing routes for
 * signed-in users, host-based canonicals would have `app.nemar.org/discover`
 * competing with `nemar.org/discover` for the same content.
 *
 * Single-host mode (localhost, `*.pages.dev` previews) keeps returning
 * `MARKETING_BASE_URL` for everything, exactly as before — those hosts are
 * noindexed anyway, and changing them would churn preview output for no gain.
 */
export function canonicalOriginFor(pathname: string, hostname: string): string {
  if (hostMode(hostname) === "single") return MARKETING_BASE_URL;
  return isAppRoute(pathname) ? `https://${APP_HOST}` : MARKETING_BASE_URL;
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

/** Where the legacy NEMAR site lives after the apex cutover (website#190). */
export const LEGACY_HOST = "ww1.nemar.org";

/**
 * Legacy dataset-detail path. The old site addressed datasets as
 * `/dataexplorer/detail?dataset_id=ds007964`; the new site uses
 * `/dataset/<id>`.
 */
const LEGACY_DATASET_PATH = "/dataexplorer/detail";

/** Legacy dataset browser. The new site's equivalent is `/discover`. */
const LEGACY_EXPLORER_PATH = "/dataexplorer";

/**
 * Legacy sections with **no** counterpart on the new site — HUBzero
 * features the redesign didn't carry over. Their content exists only on
 * ww1, so they are sent there rather than to a new-site page that would be
 * a poor substitute or a 404.
 *
 * Deliberately an explicit list rather than "anything the new site doesn't
 * route". A catch-all would swallow genuinely new paths and any real 404,
 * sending visitors to a legacy site that also doesn't have them — turning
 * a clear error into a confusing round trip. It would also silently
 * capture every future route added to this build before its page lands.
 *
 * Note what is NOT here: `/about`, `/support` and `/login` exist on both
 * sites, so the new site's own versions serve them. Redirecting those to
 * ww1 would hide the current content behind the retired one.
 */
const LEGACY_ONLY_PREFIXES: readonly string[] = [
  "/resources",
  "/tools",
  "/members",
  "/groups",
  "/citations",
];

export interface LegacyRedirect {
  readonly location: string;
  /**
   * `301` for the move to the new site — that is permanent. `302` for the
   * bounce back to ww1, which is explicitly temporary: ww1 retires, and a
   * cached permanent redirect would outlive it with no way to reach the
   * clients holding it (the hazard #183 was filed for).
   */
  readonly status: 301 | 302;
}

/**
 * Resolves a legacy NEMAR URL after the apex cutover (website#190).
 *
 * Once `nemar.org` points at this build, legacy paths land here instead of
 * the old application — they have no route and would 404. Two audiences
 * arrive at the same URL and want opposite things:
 *
 * - **Someone browsing ww1** whose legacy page linked to an absolute
 *   `nemar.org` URL. Ejecting them to the new site mid-session loses their
 *   context, so they go back to ww1.
 * - **Everyone else** — a citation in a published paper, a bookmark, a
 *   search result. They want the dataset, which now lives on the new site.
 *
 * `Referer` separates them, with one deliberate asymmetry: it is unreliable
 * (stripped by privacy modes, absent on typed or bookmarked navigation), so
 * **absent must mean "new site"**. That is the citation case, and it is the
 * one that must not break.
 *
 * The id is passed through untranslated: `/dataset/<id>` already resolves a
 * `ds*` id to its `on*` canonical via a real catalog lookup
 * (`resolveCanonical` in `src/pages/dataset/[id].astro`), which correctly
 * declines when no mirror exists rather than inventing an id. Re-deriving
 * the mapping here would duplicate that rule and could disagree with it.
 */
export function getLegacyRedirect(url: URL, referer: string | null): LegacyRedirect | null {
  const path = (url.pathname.replace(/\/+$/, "") || "/").toLowerCase();

  const isDatasetDetail = path === LEGACY_DATASET_PATH;
  const isExplorer = path === LEGACY_EXPLORER_PATH || path.startsWith(`${LEGACY_EXPLORER_PATH}/`);
  const isLegacyOnly = LEGACY_ONLY_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
  if (!isDatasetDetail && !isExplorer && !isLegacyOnly) return null;

  const cameFromLegacy = (() => {
    if (!referer) return false;
    try {
      return new URL(referer).hostname.toLowerCase() === LEGACY_HOST;
    } catch {
      // A malformed Referer is not evidence of anything; fall through to the
      // safe default rather than throwing inside the middleware.
      return false;
    }
  })();

  // Mid-session on the legacy site: keep them there, whatever the path.
  if (cameFromLegacy) {
    return { location: `https://${LEGACY_HOST}${url.pathname}${url.search}`, status: 302 };
  }

  // No counterpart on the new site — the content lives only on ww1. `302`
  // because ww1 is temporary: a cached permanent redirect would outlive it.
  if (isLegacyOnly) {
    return { location: `https://${LEGACY_HOST}${url.pathname}${url.search}`, status: 302 };
  }

  if (isDatasetDetail) {
    const datasetId = url.searchParams.get("dataset_id")?.trim();
    // No usable id — send them somewhere they can still find the dataset
    // rather than to a 404 built from an empty path.
    if (!datasetId) return { location: "/discover", status: 302 };
    return { location: `/dataset/${encodeURIComponent(datasetId)}`, status: 301 };
  }

  // The dataset browser itself. `/discover` is its direct successor, so this
  // move is permanent.
  return { location: "/discover", status: 301 };
}

export function getRetiredRedirect(url: URL): string | null {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const mapped = RETIRED_DOCS.get(path);
  if (mapped) return mapped;
  if (path === "/docs" || path.startsWith("/docs/")) return "https://docs.nemar.org/";
  if (path === "/citation-dashboard" || path.startsWith("/citation-dashboard/")) {
    // Trailing slash is the canonical form — `/citations` 308s to `/citations/`,
    // so omitting it costs every visitor an extra round trip on top of the
    // redirect that got them here.
    return "https://dashboard.nemar.org/citations/";
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
