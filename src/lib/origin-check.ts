/**
 * The site's own cross-site form check (nemarOrg/website ADR 0031, nemar-cli ADR 0119).
 *
 * Astro's built-in `security.checkOrigin` is switched OFF in `astro.config.mjs` and this module
 * stands in for it, because the built-in has no exemption and OpenID Connect Core 3.1.2.1 requires
 * the authorization endpoint to accept a form POST from any site. {@link crossSiteFormRefusal} is
 * the built-in's rule, line for line (Astro 6.3.3, `core/app/middlewares.js`; a test compares the
 * two over a table), with ONE exemption: the authorization-request POST.
 *
 * THE EXEMPTION, all four terms required ({@link isAuthorizationRequestPost}):
 * - the method is POST;
 * - the path is exactly {@link AUTHORIZATION_ENDPOINT_PATH}: not the trailing-slash spelling, not an
 *   encoded one, not another case. A spelling that Astro still routes to the page but this match
 *   misses gets the built-in's refusal, which fails closed;
 * - the media type is exactly `application/x-www-form-urlencoded`, the only form type OpenID
 *   Connect allows (`multipart/form-data`, `text/plain` and a missing Content-Type keep the built-in's
 *   rule);
 * - nothing else: the request's Origin is not looked at, so a `null` Origin (a sandboxed frame, a
 *   cross-origin redirect hop) is exempt as well.
 *
 * WHAT THE EXEMPTION MUST NEVER BECOME: a way to approve a grant. The consent form posts to the
 * SAME path with the SAME content type, and the two cannot be told apart before the body is read, so
 * this module does not try. The page tells them apart: `readAuthorizeInput` (`./oidc-authorize.ts`)
 * answers `forbidden`, with {@link crossSiteFormRefusalResponse}, for any POST that names a consent
 * field unless {@link isSameOriginPost} holds. The invariant is "an authorization-request POST can
 * only render": it reaches the API's check route, as the same request in a GET would, and nothing else.
 */

/** The authorization endpoint, which `OIDC_AUTHORIZE_PAGE_PATH` (`./oidc-authorize.ts`) repeats; a test holds them equal. */
export const AUTHORIZATION_ENDPOINT_PATH = "/oauth/authorize";

/** The one form content type OpenID Connect allows on the authorization endpoint. */
export const AUTHORIZATION_POST_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** Astro's `FORM_CONTENT_TYPES`, in its order. */
const FORM_CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
] as const;

/** Astro's `SAFE_METHODS`. */
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"] as const;

/** Astro's `hasFormLikeHeader`: a substring match, so a type that merely MENTIONS a form type is form-like. */
export function hasFormLikeHeader(contentType: string | null): boolean {
  if (!contentType) return false;
  const lowered = contentType.toLowerCase();
  return FORM_CONTENT_TYPES.some((type) => lowered.includes(type));
}

/** The media type of a Content-Type value: before any parameter, trimmed, lower case. */
export function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * True for the one request the exemption covers (see the module comment). `pathname` is the URL
 * parser's, compared exactly.
 */
export function isAuthorizationRequestPost(
  method: string,
  pathname: string,
  contentType: string | null,
): boolean {
  return (
    method === "POST" &&
    pathname === AUTHORIZATION_ENDPOINT_PATH &&
    mediaType(contentType) === AUTHORIZATION_POST_CONTENT_TYPE
  );
}

/** The 403 body, as Astro words it. */
export function crossSiteFormRefusalBody(method: string): string {
  return `Cross-site ${method} form submissions are forbidden`;
}

/** The 403 Astro's check answered with; a page that refuses a cross-site consent answers the same. */
export function crossSiteFormRefusalResponse(
  method: string,
  headers?: Readonly<Record<string, string>>,
): Response {
  return new Response(crossSiteFormRefusalBody(method), { status: 403, headers });
}

/**
 * Astro's rule for a non-safe request, with the one exemption. Null means the request may go on;
 * otherwise the 403 to answer with.
 *
 * Same as Astro: a safe method goes on; a request is same-origin only when its Origin header equals
 * the site's origin exactly (a missing or `null` Origin is not); with a Content-Type, only a
 * form-like one is refused when cross-site (JSON and the rest are left to the CORS preflight); with
 * no Content-Type at all, a cross-site request is refused.
 *
 * `pageOrigin` is the site's own origin, `new URL(request.url).origin`.
 */
export function crossSiteFormRefusal(request: Request, pageOrigin: string): Response | null {
  if ((SAFE_METHODS as readonly string[]).includes(request.method)) return null;
  const sameOrigin = request.headers.get("origin") === pageOrigin;
  if (sameOrigin) return null;
  const contentType = request.headers.get("content-type");
  const refuses = request.headers.has("content-type") ? hasFormLikeHeader(contentType) : true;
  if (!refuses) return null;
  if (isAuthorizationRequestPost(request.method, new URL(request.url).pathname, contentType)) {
    return null;
  }
  return crossSiteFormRefusalResponse(request.method);
}

/**
 * True when a request is the site's own, for a decision that must never be made cross-site: its
 * Origin equals the site's exactly (so `null`, a sibling subdomain and a missing header all fail),
 * and its `Sec-Fetch-Site`, when the browser sent one, says `same-origin`.
 */
export function isSameOriginPost(request: Request, pageOrigin: string): boolean {
  if (request.headers.get("origin") !== pageOrigin) return false;
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}
