/**
 * Pure helpers for `/auth/private/authorize`, the middle hop of the sign-in handoff to
 * `private.nemar.org`, NEMAR's site for access-controlled features.
 *
 * The private site is a separate host, and the session cookie is deliberately scoped
 * `Domain=app.nemar.org` (see the module comment in `./host.ts`), so it cannot authenticate that
 * host. The private site gets a credential of its own through the same three-hop shape the docs
 * handoff uses (`./docs-authorize.ts`): it sends a visitor without a session here, this page proves
 * the visitor is signed in and asks the backend for a one-time code, and the private site trades
 * that code for a session of its own. This page is the only hop that already holds the app
 * session.
 *
 * WHAT DIFFERS FROM THE DOCS HANDOFF, and why each difference is here rather than in the page:
 *
 * - **No admin gate.** Any signed-in account may start this; the backend refuses an account that
 *   is not active yet, and the private site decides what the account may do there.
 * - **A `state` parameter.** The private site generates a random value per sign-in, keeps it in a
 *   host-only cookie on its own host, and passes it through this page, which forwards it to the
 *   grant unchanged. The backend stores only its hash, and the private site's exchange mints a
 *   session only when its own cookie presents the same value. That binds the browser that started
 *   the sign-in to the browser that finishes it; without it, someone could finish their own
 *   sign-in in another person's browser. So this page validates the value's shape, sends it in the
 *   grant body, and NEVER puts it in the callback URL or in a log line.
 * - **No `next`.** The callback carries the code alone, as the contract requires. The private
 *   site keeps its own return path in a host-only cookie beside the `state`, so nothing about
 *   where the visitor was going passes through this page or its URLs.
 *
 * The literals shared with nemar-cli's `shared/contract/private-site.ts` are checked by
 * `test/private-site-contract-drift.test.ts`.
 */

import { ACCOUNT_COPY } from "./account-copy";
import { safeRedirectPath } from "./auth";

/** This page's own path, which the contract names `PRIVATE_AUTHORIZE_PATH`. */
export const PRIVATE_AUTHORIZE_PAGE_PATH = "/auth/private/authorize";

/** Where the private site takes the code, on its own host (`PRIVATE_CALLBACK_PATH`). */
export const PRIVATE_CALLBACK_PATH = "/__auth/callback";

/** The query parameter the private site puts its `state` in (`PRIVATE_AUTHORIZE_STATE_PARAM`). */
export const PRIVATE_AUTHORIZE_STATE_PARAM = "state";

/**
 * The shape of a `state`: 32 to 256 characters of the base64url alphabet, the same rule the
 * backend applies before it stores the hash. The contract requires 256 random bits, which is 43
 * characters; 32 is a floor on the shape, not on the strength.
 */
const STATE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

/** The production hosts. A handoff is only coherent when both halves name the same environment. */
const PROD_API_BASE = "https://api.nemar.org";
const PROD_PRIVATE_SITE_BASE = "https://private.nemar.org";

/** The `state` from the query when it has the right shape, otherwise null. */
export function privateState(raw: string | null | undefined): string | null {
  return typeof raw === "string" && STATE_PATTERN.test(raw) ? raw : null;
}

export type PrivateHandoffTarget =
  | { readonly kind: "ready"; readonly base: string }
  | { readonly kind: "misconfigured"; readonly reason: string };

/**
 * The origin of an operator-supplied private-site base when it is a host this deployment may hand
 * a live grant code to, otherwise null: an absolute `https://` URL on `nemar.org` or a subdomain,
 * with no credentials, no non-default port, and no path, query or fragment. The value becomes the
 * ORIGIN of a `Location` header carrying a one-time code, so a missing scheme (which would make
 * the redirect relative to this page) or a foreign host is refused rather than honored.
 *
 * The answer is the parsed `url.origin`, never the raw string, so what the redirect uses is the
 * normalized form: a lowercase host, no `:443`, no bare `?` or `#` (which the URL parser accepts
 * with an empty query or fragment), and no surrounding whitespace.
 */
function usablePrivateSiteOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname;
  if (host !== "nemar.org" && !host.endsWith(".nemar.org")) return null;
  if (url.port) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

/**
 * Which private-site host this deployment may hand off to, or a refusal. The same rule as
 * `docsHandoffTarget`: a configured base is honored once validated; otherwise the handoff is only
 * offered when the API is production too, because a grant minted against a staging or preview API
 * could only ever be spent by the production private site, which never saw it. Checked BEFORE the
 * grant is minted, so a refusal writes nothing.
 */
export function privateHandoffTarget(
  apiBaseUrl: string,
  configuredBase: string | null | undefined,
): PrivateHandoffTarget {
  const trim = (v: string) => v.replace(/\/$/, "");
  if (configuredBase) {
    const origin = usablePrivateSiteOrigin(configuredBase);
    if (origin === null) {
      // The value itself is not echoed: a malformed one may carry credentials.
      return {
        kind: "misconfigured",
        reason:
          "PRIVATE_SITE_BASE is set but is not an https origin on a nemar.org host (no credentials, port, path, query or fragment); a grant minted here would be redirected to a host that cannot spend it",
      };
    }
    return { kind: "ready", base: origin };
  }
  if (trim(apiBaseUrl) === PROD_API_BASE) return { kind: "ready", base: PROD_PRIVATE_SITE_BASE };
  return {
    kind: "misconfigured",
    reason: `PRIVATE_SITE_BASE is unset and the API is ${trim(apiBaseUrl)}, not production; a grant minted here could only be spent by the production private site, which never saw it`,
  };
}

/**
 * This page's own URL with the one parameter it honors, rebuilt from the validated `state`: the
 * address a signed-out visitor returns to after signing in. Rebuilt rather than echoed, so nothing
 * else a caller put in the query rides along into the login page's `next`, and it always passes
 * `safeRedirectPath` (asserted in the tests) so sign-in brings the visitor back here with the same
 * `state`.
 */
export function privateAuthorizeReturnPath(state: string): string {
  const params = new URLSearchParams({ [PRIVATE_AUTHORIZE_STATE_PARAM]: state });
  const path = `${PRIVATE_AUTHORIZE_PAGE_PATH}?${params.toString()}`;
  return safeRedirectPath(path) === path ? path : PRIVATE_AUTHORIZE_PAGE_PATH;
}

/** The sign-in page, returning here afterwards. `sessionRequired` says why the visitor is there
 *  when the backend refused a session the middleware had accepted. */
export function privateLoginRedirect(returnPath: string, sessionRequired = false): string {
  const params = new URLSearchParams();
  if (sessionRequired) params.set("error", "session_required");
  params.set("next", returnPath);
  return `/login?${params.toString()}`;
}

/**
 * The private site's callback URL for a minted code: the code, through `URLSearchParams`, and
 * NOTHING else, as the contract requires. In particular never the `state`: the private site reads
 * it only from its own cookie, and a state in a URL would land in history, logs and any `Referer`.
 */
export function privateCallbackUrl(base: string, code: string): string {
  const params = new URLSearchParams({ code });
  return `${base.replace(/\/$/, "")}${PRIVATE_CALLBACK_PATH}?${params.toString()}`;
}

/** What the page does next, given the backend's answer to `POST /auth/private/grant`. */
export type PrivateGrantOutcome =
  | { readonly kind: "handoff"; readonly code: string }
  | { readonly kind: "signed_out" }
  | { readonly kind: "unverified" }
  | { readonly kind: "inactive" }
  | { readonly kind: "invalid_request" }
  | { readonly kind: "rate_limited" }
  | { readonly kind: "unavailable" };

/** Structurally identical to `PrivateGrantResult` from `./private-auth-api.ts`. */
type RawResult =
  | { readonly status: number; readonly body: unknown }
  | { readonly status: "network" };

function field(body: unknown, key: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

/**
 * Map a grant result onto the page's outcomes.
 *
 * - 200 with a string `code`: hand off.
 * - 401: the session the middleware accepted is gone; send the visitor to sign in again.
 * - 403 carrying the backend's inactive-account body (a `status` field): `unverified` when that
 *   status is `pending` (the email is not verified yet, which the visitor can fix), `inactive`
 *   for any other status (access withdrawn, which the visitor cannot). A revoked account can
 *   still hold a web session, so the second case is reachable and must not be told to verify an
 *   email. A 403 WITHOUT a `status` is the backend's Origin refusal, which only a
 *   misconfiguration produces, so it is `unavailable` like any other fault the visitor cannot
 *   act on.
 * - 400: the backend refused the request itself. This page validated the `state` first, so this
 *   means the two sides disagree about its shape; the visitor's remedy is the same either way.
 * - 429: too many grants for this account in a minute.
 * - 3xx: the grant call does not follow redirects (`./private-auth-api.ts`), so a redirect is a
 *   misrouted request, and unavailable.
 * - Anything else, a network failure included: unavailable.
 *
 * Logs name the status and never a body value: this is the grant endpoint, and a changed response
 * shape must not put a live code in the log.
 */
export function privateGrantOutcome(result: RawResult): PrivateGrantOutcome {
  if (result.status === "network") return { kind: "unavailable" };
  if (result.status >= 300 && result.status < 400) {
    console.warn(`[private-authorize] grant answered a redirect (${result.status}); not followed`);
    return { kind: "unavailable" };
  }
  if (result.status === 401) return { kind: "signed_out" };
  if (result.status === 403) {
    const accountStatus = field(result.body, "status");
    if (accountStatus === "pending") return { kind: "unverified" };
    if (typeof accountStatus === "string") return { kind: "inactive" };
    console.warn("[private-authorize] grant answered 403 without an account status");
    return { kind: "unavailable" };
  }
  if (result.status === 400) return { kind: "invalid_request" };
  if (result.status === 429) return { kind: "rate_limited" };
  if (result.status === 200) {
    const code = field(result.body, "code");
    if (typeof code !== "string" || code.length === 0) {
      console.warn("[private-authorize] grant answered 200 with no usable code", {
        keys:
          result.body && typeof result.body === "object"
            ? Object.keys(result.body)
            : typeof result.body,
      });
      return { kind: "unavailable" };
    }
    return { kind: "handoff", code };
  }
  console.warn(`[private-authorize] grant answered ${result.status}`);
  return { kind: "unavailable" };
}

/** Every panel this page can render, and the HTTP status it answers with. */
export type PrivateAuthorizePanel =
  | "invalid_request"
  | "unverified"
  | "inactive"
  | "rate_limited"
  | "unavailable"
  | "misconfigured";

/**
 * Copy for the rendered states. None names a status code, an upstream body or anything about the
 * private site beyond its purpose. The unverified panel reuses the account copy the rest of the
 * site shows for an unverified account (`./account-copy.ts`, mirrored from nemar-cli). The shared
 * account copy has no key for an account whose access was withdrawn, so `inactive` has its own
 * wording, matching the backend's own message for that case.
 */
export const PRIVATE_AUTHORIZE_COPY: Readonly<
  Record<PrivateAuthorizePanel, { readonly title: string; readonly body: string }>
> = {
  invalid_request: {
    title: "Invalid sign-in request",
    body: "This sign-in link is incomplete or has been changed. Go back to the page you were signing in to and start again.",
  },
  unverified: {
    title: ACCOUNT_COPY["tier.unverified.label"],
    body: ACCOUNT_COPY["tier.unverified.lede"],
  },
  inactive: {
    title: "Account not active",
    body: "Your NEMAR account is not active. If you think this is a mistake, tell us at support@nemar.org.",
  },
  rate_limited: {
    title: "Too many sign-in attempts",
    body: "Try again in a minute.",
  },
  unavailable: {
    title: "Couldn't complete sign-in",
    body: "We couldn't complete sign-in right now. Try again in a moment, and if it keeps happening tell us at support@nemar.org.",
  },
  misconfigured: {
    title: "Couldn't complete sign-in",
    body: "Sign-in to this site is not available from this deployment.",
  },
};

/** The status each panel answers with. A misconfigured deployment is 501, distinct from the
 *  transient 503, for the reason the docs page gives. */
export const PRIVATE_AUTHORIZE_STATUS: Readonly<Record<PrivateAuthorizePanel, number>> = {
  invalid_request: 400,
  unverified: 403,
  inactive: 403,
  rate_limited: 429,
  unavailable: 503,
  misconfigured: 501,
};

/**
 * Headers every response of this page carries, the rendered panels and the redirects alike. The
 * `state` is in this page's own URL, so `no-referrer` keeps it out of the `Referer` of the next
 * request; `no-store` because every answer is per-visitor; `noindex` because nothing here is a
 * page anyone should find.
 */
export const PRIVATE_AUTHORIZE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};

/**
 * The 405 for any method but GET, or null for GET. The page is reached by a top-level navigation
 * from the private site, which is always a GET; anything else is refused before the `state` is
 * read or a grant is minted. HEAD included: Astro renders a page's frontmatter for HEAD too, so
 * without this a HEAD request would mint a grant whose code nobody receives.
 */
export function privateMethodRefusal(method: string): Response | null {
  if (method === "GET") return null;
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET", ...PRIVATE_AUTHORIZE_HEADERS },
  });
}
