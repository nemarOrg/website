/**
 * Two-host routing model.
 *
 * `nemar.org` is the public marketing surface; everything anonymous and
 * cacheable lives there. `app.nemar.org` is the authenticated surface;
 * cookies and personalized SSR only happen there. The session cookie is
 * scoped to `app.nemar.org` (host-only) so it never attaches to byte-range
 * fetches against `data.nemar.org`, search hits to `api.nemar.org`, or any
 * future `discuss.nemar.org` traffic.
 *
 * Any other hostname (localhost, *.pages.dev preview, ad-hoc dev tunnels)
 * runs in "single" mode: no redirects, full nav, normal session lookup.
 * That keeps preview deploys cheap to QA without coordinating two
 * domains.
 */

export const APP_HOST = "app.nemar.org";
export const MARKETING_HOST = "nemar.org";

const APP_HOSTS: ReadonlySet<string> = new Set([APP_HOST]);
const MARKETING_HOSTS: ReadonlySet<string> = new Set([MARKETING_HOST, `www.${MARKETING_HOST}`]);

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
  if (APP_HOSTS.has(hostname)) return "app";
  if (MARKETING_HOSTS.has(hostname)) return "marketing";
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
 * domains.
 */
export function getCrossHostRedirect(url: URL): string | null {
  const mode = hostMode(url.hostname);
  if (mode === "single") return null;
  const wantsApp = isAppRoute(url.pathname);
  const onAppHost = mode === "app";
  if (wantsApp === onAppHost) return null;
  const targetHost = wantsApp ? APP_HOST : MARKETING_HOST;
  return `https://${targetHost}${url.pathname}${url.search}`;
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
 * Mirror of `appUrl` for the marketing host. Returns an absolute
 * `https://nemar.org/...` URL when called from the app host, relative
 * otherwise.
 */
export function marketingUrl(pathname: string, currentHostname: string): string {
  return hostMode(currentHostname) === "app" ? `https://${MARKETING_HOST}${pathname}` : pathname;
}
