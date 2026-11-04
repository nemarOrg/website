/**
 * Pure helpers for `/oauth/authorize`, the authorization endpoint of NEMAR's OpenID Connect provider
 * (nemar-cli ADR 0119, epic nemarOrg/nemar-cli#2014 phase #2017).
 *
 * A site that signs people in with their NEMAR account sends them here. The page lives on the app
 * host because that is where the sign-in cookie is, and it DECIDES NOTHING: it forwards the
 * authorization request, with the visitor's `Cookie` header, to the API's check route, and follows
 * or renders what comes back. On the consent screen the visitor's click goes to the API's consent
 * route the same way. Every rule (which client, which redirect address, which session may approve,
 * whether to ask, the code) is the API's, in nemar-cli `backend/src/services/oidc-authorize.ts`.
 *
 * WHAT THIS PAGE MUST STILL GET RIGHT, and so what this module holds:
 *
 * - **Where a person is sent.** A redirect goes only to a `location` the API built from a redirect
 *   address the client registered, and only if it is an absolute `https` address (or `http` on a
 *   loopback host, for local work) with no credentials in it. Anything else is the unavailable panel.
 * - **What the consent form may reach.** The site's policy is `form-action 'self'`, and Chrome applies
 *   it to the redirect that follows a form post, so the consent form's redirect to the client would
 *   be blocked. The page names the ONE origin the API returned for the redirect address
 *   ({@link isFormActionOrigin} checks it), and the middleware adds that origin to `form-action` for
 *   this path only and removes the header ({@link OIDC_FORM_ACTION_ORIGIN_HEADER}).
 * - **That it cannot be framed, cached, indexed or referred from**: {@link OIDC_AUTHORIZE_HEADERS},
 *   on every response, the redirects included.
 * - **That nothing is logged** of the request, the `state`, a code or a consent token.
 *
 * The literals shared with nemar-cli's `shared/contract/oidc-authorize.ts` and `shared/oidc.ts` are
 * checked by `test/oidc-authorize-contract-drift.test.ts`.
 */

import { ACCOUNT_COPY, type AccountCopyKey, fillCopy } from "./account-copy";
import { safeRedirectPath } from "./auth";

// -------------------------------------------------------------------------------------------------
// The contract (mirrored from nemar-cli; drift-tested)
// -------------------------------------------------------------------------------------------------

/** This page's own path, which nemar-cli names `OIDC_AUTHORIZE_PATH` in `shared/oidc.ts`. */
export const OIDC_AUTHORIZE_PAGE_PATH = "/oauth/authorize";

/** The API's check route. */
export const OIDC_AUTHORIZE_CHECK_PATH = "/auth/oidc/authorize";

/** The API's consent route. */
export const OIDC_AUTHORIZE_CONSENT_PATH = "/auth/oidc/consent";

/**
 * The header the API requires on both routes: it marks a call as this page's own, server-side. The
 * general browser proxy (`src/pages/api/v1/[...path].ts`) forwards a fixed list of headers that never
 * includes it, and refuses the authorization paths outright.
 */
export const OIDC_AUTHORIZE_CALLER_HEADER = "X-Nemar-Authorize-Caller";
export const OIDC_AUTHORIZE_CALLER_VALUE = "authorize-page";

/**
 * The sign-in marker the API adds to a request it sends back through sign-in, signed by the API.
 * Read by nothing here.
 */
export const OIDC_AUTH_AFTER_PARAM = "nemar_auth_after";

/** How long the API honours a sign-in marker, in seconds. Mirrored for the drift test only. */
export const OIDC_AUTH_AFTER_TTL_SECONDS = 600;

/** The longest authorization request the API reads, in characters of its query string. */
export const OIDC_AUTHORIZE_REQUEST_MAX_LENGTH = 8192;

export const OIDC_AUTHORIZE_KINDS = [
  "redirect",
  "error_page",
  "login",
  "reauth",
  "rule_refused",
  "consent",
] as const;

export const OIDC_ERROR_PAGE_CODES = [
  "invalid_client",
  "invalid_redirect_uri",
  "invalid_request",
  "consent_invalid",
  "unavailable",
] as const;
export type OidcErrorPageCode = (typeof OIDC_ERROR_PAGE_CODES)[number];

export const OIDC_RULE_REFUSAL_REASONS = [
  "account_inactive",
  "account_not_person",
  "orcid_not_proven",
] as const;
export type OidcRuleRefusalReason = (typeof OIDC_RULE_REFUSAL_REASONS)[number];

export const OIDC_CONSENT_DECISIONS = ["allow", "deny"] as const;

/** The `error` values the API's redirects carry to the client. Never shown here; the client reads them. */
export const OIDC_AUTHORIZE_REDIRECT_ERRORS = [
  "invalid_request",
  "unsupported_response_type",
  "invalid_scope",
  "request_not_supported",
  "request_uri_not_supported",
  "login_required",
  "consent_required",
  "access_denied",
] as const;
export type OidcConsentDecision = (typeof OIDC_CONSENT_DECISIONS)[number];

// -------------------------------------------------------------------------------------------------
// This page's own names
// -------------------------------------------------------------------------------------------------

/** The consent form's fields. The form posts back to this page, never to the API. */
export const OIDC_FORM_REQUEST = "nemar_request";
export const OIDC_FORM_CONSENT_TOKEN = "nemar_consent_token";
export const OIDC_FORM_DECISION = "nemar_decision";

/**
 * The internal response header the page uses to tell the middleware which one origin the consent
 * form's redirect may reach. The middleware reads it on this path only, re-validates it, adds it to
 * `form-action`, and deletes it from every response, so it never reaches a browser.
 */
export const OIDC_FORM_ACTION_ORIGIN_HEADER = "x-nemar-form-action-origin";

/**
 * The most a POST body may carry: the consent form holds the authorization request (at most
 * {@link OIDC_AUTHORIZE_REQUEST_MAX_LENGTH} characters, percent-encoded once more inside the form)
 * and a consent token. Anything longer is refused unread.
 */
export const OIDC_POST_BODY_MAX_LENGTH = 32768;

/**
 * Headers on every response of this page, the redirects included. `no-store`: every answer is
 * per-visitor and some carry a code. `no-referrer`: this page's URL carries the request's `state`.
 * `noindex`: nothing here is a page anyone should find. `X-Frame-Options: DENY`: the consent screen
 * must not be framed, and the middleware keeps a page's DENY and adds `frame-ancestors 'none'`.
 */
export const OIDC_AUTHORIZE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
  "X-Frame-Options": "DENY",
};

/**
 * The consent screen's referrer policy, in place of `no-referrer`. Under `no-referrer` a browser
 * sends a same-origin form post with `Origin: null`, and the site's own cross-site form check then
 * refuses every Allow and Deny. `same-origin` keeps the form's Origin and still sends no referrer
 * to any other site; the middleware keeps it as a tightening. Redirects and the other panels keep
 * `no-referrer`.
 */
export const OIDC_CONSENT_REFERRER_POLICY = "same-origin";

/**
 * The 405 for anything but GET and POST, or null. OpenID Connect requires both (Core 3.1.2.1); HEAD
 * is refused because Astro runs a page's frontmatter for it, and a HEAD that reached the API could
 * mint a code nobody receives.
 */
export function oidcAuthorizeMethodRefusal(method: string): Response | null {
  if (method === "GET" || method === "POST") return null;
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET, POST", ...OIDC_AUTHORIZE_HEADERS },
  });
}

// -------------------------------------------------------------------------------------------------
// What the visitor sent
// -------------------------------------------------------------------------------------------------

export type AuthorizeInput =
  | { readonly kind: "check"; readonly request: string }
  | {
      readonly kind: "consent";
      readonly request: string;
      readonly consentToken: string;
      readonly decision: OidcConsentDecision;
    }
  | { readonly kind: "invalid" };

/** A GET: the authorization request is the query string, as it arrived. */
export function authorizeInputFromQuery(search: string): AuthorizeInput {
  return { kind: "check", request: search.startsWith("?") ? search.slice(1) : search };
}

function isDecision(value: string): value is OidcConsentDecision {
  return (OIDC_CONSENT_DECISIONS as readonly string[]).includes(value);
}

/**
 * A POST: either this page's consent form (it carries {@link OIDC_FORM_CONSENT_TOKEN}, and then
 * exactly one of each of the three fields) or an authorization request sent by POST, which is the
 * form body itself.
 */
export function authorizeInputFromForm(body: string): AuthorizeInput {
  const form = new URLSearchParams(body);
  if (!form.has(OIDC_FORM_CONSENT_TOKEN)) return { kind: "check", request: body };
  const requests = form.getAll(OIDC_FORM_REQUEST);
  const tokens = form.getAll(OIDC_FORM_CONSENT_TOKEN);
  const decisions = form.getAll(OIDC_FORM_DECISION);
  if (requests.length !== 1 || tokens.length !== 1 || decisions.length !== 1) {
    return { kind: "invalid" };
  }
  const decision = decisions[0];
  if (!isDecision(decision)) return { kind: "invalid" };
  return { kind: "consent", request: requests[0], consentToken: tokens[0], decision };
}

/**
 * A request body as text, reading at most `max` bytes: null once it is longer, and the rest is never
 * read, whether or not the request declared a `Content-Length`.
 */
async function boundedText(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The request as this page reads it. A POST must be a form (`application/x-www-form-urlencoded`) of
 * at most {@link OIDC_POST_BODY_MAX_LENGTH} bytes, counted as it streams in; anything else is
 * `invalid` and reaches no API.
 */
export async function readAuthorizeInput(request: Request): Promise<AuthorizeInput> {
  if (request.method === "GET") return authorizeInputFromQuery(new URL(request.url).search);
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return { kind: "invalid" };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > OIDC_POST_BODY_MAX_LENGTH) return { kind: "invalid" };
  const body = await boundedText(request, OIDC_POST_BODY_MAX_LENGTH);
  if (body === null) return { kind: "invalid" };
  return authorizeInputFromForm(body);
}

// -------------------------------------------------------------------------------------------------
// What the API answered
// -------------------------------------------------------------------------------------------------

/** A panel this page renders when it does not send the visitor anywhere. */
export type OidcErrorPanel = OidcErrorPageCode | "rate_limited";

export type OidcAuthorizeOutcome =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "login"; readonly request: string }
  | { readonly kind: "reauth"; readonly request: string }
  | {
      readonly kind: "consent";
      readonly clientName: string;
      readonly scopes: readonly string[];
      readonly computeSpend: boolean;
      readonly consentToken: string;
      readonly redirectOrigin: string;
    }
  | {
      readonly kind: "rule_refused";
      readonly reason: OidcRuleRefusalReason;
      readonly clientName: string;
      readonly location: string;
    }
  | { readonly kind: "error"; readonly code: OidcErrorPanel };

/** Structurally identical to `OidcAuthorizeResult` in `./oidc-authorize-api.ts`. */
type RawResult =
  | { readonly status: number; readonly body: unknown }
  | { readonly status: "network" };

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The address to send the visitor to, or null. Absolute, `https` (or `http` on a loopback host), no
 * user information. The string is used as the API built it, never re-serialized, because the API
 * appended to a registered address exactly as the client registered it.
 */
export function usableLocation(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return value;
  return null;
}

/** `https://host[:port]` (or http), lower-case host, or the IPv6 loopback in brackets. */
const ORIGIN_SHAPE = /^https?:\/\/([a-z0-9.-]+|\[::1\])(:\d{1,5})?$/;

/**
 * True for a serialized origin the consent form's redirect may be allowed to reach: `https://host`
 * (or `http://` on a loopback host, `[::1]` included, which the API accepts outside production), with
 * an optional port, lower case, nothing else. The shape is
 * strict because the value is written into a Content-Security-Policy: a space, a semicolon or a
 * quote would add a directive or a source of its own. The middleware asks this again before it uses
 * the value.
 */
export function isFormActionOrigin(value: unknown): value is string {
  if (typeof value !== "string" || !ORIGIN_SHAPE.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false;
  return url.protocol === "https:" || isLoopbackHost(url.hostname);
}

function field(body: unknown, key: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

const UNAVAILABLE: OidcAuthorizeOutcome = { kind: "error", code: "unavailable" };

/**
 * Map an API result onto what this page does. Only a 200 with a well-formed answer of a known kind
 * leads anywhere; every other result, and every answer whose shape is wrong, is a panel and sends the
 * visitor nowhere.
 *
 * - 400: this page sent a request the API could not read; `invalid_request`.
 * - 429: too many calls for this account; `rate_limited`.
 * - 3xx: the call does not follow redirects (`./oidc-authorize-api.ts`), so a redirect is a misrouted
 *   call; `unavailable`, as are 403 (only a misconfigured Origin produces it), 404 (the provider is
 *   off) and every other status, a network failure included.
 *
 * Logs name the status or the kind and never a body value: an answer can carry a code or a token.
 */
export function oidcAnswerOutcome(result: RawResult): OidcAuthorizeOutcome {
  if (result.status === "network") return UNAVAILABLE;
  if (result.status === 400) return { kind: "error", code: "invalid_request" };
  if (result.status === 429) return { kind: "error", code: "rate_limited" };
  if (result.status !== 200) {
    console.warn(`[oidc-authorize] the API answered ${result.status}`);
    return UNAVAILABLE;
  }
  const body = result.body;
  const kind = field(body, "kind");
  switch (kind) {
    case "redirect": {
      const location = usableLocation(field(body, "location"));
      if (location !== null) return { kind: "redirect", location };
      break;
    }
    case "login":
    case "reauth": {
      const request = field(body, "request");
      if (typeof request === "string") return { kind, request };
      break;
    }
    case "error_page": {
      const code = field(body, "code");
      if ((OIDC_ERROR_PAGE_CODES as readonly unknown[]).includes(code)) {
        return { kind: "error", code: code as OidcErrorPageCode };
      }
      break;
    }
    case "rule_refused": {
      const reason = field(body, "reason");
      const clientName = field(body, "client_name");
      const location = usableLocation(field(body, "location"));
      if (
        (OIDC_RULE_REFUSAL_REASONS as readonly unknown[]).includes(reason) &&
        typeof clientName === "string" &&
        location !== null
      ) {
        return {
          kind: "rule_refused",
          reason: reason as OidcRuleRefusalReason,
          clientName,
          location,
        };
      }
      break;
    }
    case "consent": {
      const clientName = field(body, "client_name");
      const scopes = field(body, "scopes");
      const computeSpend = field(body, "compute_spend");
      const consentToken = field(body, "consent_token");
      const redirectOrigin = field(body, "redirect_origin");
      if (
        typeof clientName === "string" &&
        Array.isArray(scopes) &&
        scopes.length > 0 &&
        scopes.every((s) => typeof s === "string") &&
        typeof computeSpend === "boolean" &&
        typeof consentToken === "string" &&
        consentToken.length > 0 &&
        isFormActionOrigin(redirectOrigin)
      ) {
        return {
          kind: "consent",
          clientName,
          scopes: scopes as string[],
          computeSpend,
          consentToken,
          redirectOrigin,
        };
      }
      break;
    }
  }
  console.warn(
    `[oidc-authorize] the API answered a ${typeof kind === "string" && /^[a-z_]{1,20}$/.test(kind) ? kind : "malformed"} answer this page cannot use`,
  );
  return UNAVAILABLE;
}

// -------------------------------------------------------------------------------------------------
// Where the visitor goes
// -------------------------------------------------------------------------------------------------

/**
 * The sign-in page, returning to this page with the request the API gave back. `reauth` says the
 * visitor is signed in but must sign in again, which the sign-in page states. The return path is
 * this page with that request; if it would not survive the sign-in page's own `safeRedirectPath`
 * (a backslash or a line break in a value), the visitor returns to this page bare and is told the
 * request is incomplete, rather than being sent somewhere else.
 */
export function oidcLoginRedirect(request: string, reauth: boolean): string {
  const target = `${OIDC_AUTHORIZE_PAGE_PATH}?${request}`;
  const next = safeRedirectPath(target) === target ? target : OIDC_AUTHORIZE_PAGE_PATH;
  const params = new URLSearchParams();
  if (reauth) params.set("error", "session_required");
  params.set("next", next);
  return `/login?${params.toString()}`;
}

/** A redirect with this page's headers: 303 after a POST (so the browser follows it with a GET), else 302. */
export function oidcNavigate(location: string, method: string): Response {
  return new Response(null, {
    status: method === "POST" ? 303 : 302,
    headers: { Location: location, ...OIDC_AUTHORIZE_HEADERS },
  });
}

// -------------------------------------------------------------------------------------------------
// What the visitor reads
// -------------------------------------------------------------------------------------------------

/** The copy line for each scope a person can grant. `compute.stats` is never on a consent screen. */
export const OIDC_SCOPE_COPY: Readonly<Record<string, AccountCopyKey>> = {
  openid: "oidc.consent.scope.openid",
  profile: "oidc.consent.scope.profile",
  email: "oidc.consent.scope.email",
  orcid: "oidc.consent.scope.orcid",
  "nemar.account": "oidc.consent.scope.nemar.account",
  offline_access: "oidc.consent.scope.offline_access",
  "compute.read": "oidc.consent.scope.compute.read",
  "compute.reserve": "oidc.consent.scope.compute.reserve",
  "compute.submit": "oidc.consent.scope.compute.submit",
};

export interface ConsentView {
  readonly title: string;
  /** Where either answer sends the person: the host of the redirect address. */
  readonly redirectHost: string;
  readonly actsAsYou: string;
  readonly computeSpend: string | null;
  readonly scopesTitle: string;
  /**
   * One line per scope. A scope this build has no sentence for (the API's catalogue grew after this
   * build) is shown by its name rather than left out: a screen that hid a permission would be asking
   * for it without saying so.
   */
  readonly scopeLines: readonly string[];
  readonly allow: string;
  readonly deny: string;
}

export function consentView(
  outcome: Extract<OidcAuthorizeOutcome, { kind: "consent" }>,
): ConsentView {
  const client = { client: outcome.clientName };
  return {
    title: fillCopy(ACCOUNT_COPY["oidc.consent.title"], client),
    redirectHost: fillCopy(ACCOUNT_COPY["oidc.consent.redirect_host"], {
      redirect_host: new URL(outcome.redirectOrigin).host,
    }),
    actsAsYou: fillCopy(ACCOUNT_COPY["oidc.consent.acts_as_you"], client),
    computeSpend: outcome.computeSpend ? ACCOUNT_COPY["oidc.consent.compute_spend"] : null,
    scopesTitle: ACCOUNT_COPY["oidc.consent.scopes_title"],
    scopeLines: outcome.scopes.map((scope) => {
      const key = Object.hasOwn(OIDC_SCOPE_COPY, scope) ? OIDC_SCOPE_COPY[scope] : undefined;
      return key ? ACCOUNT_COPY[key] : scope;
    }),
    allow: ACCOUNT_COPY["oidc.consent.allow"],
    deny: ACCOUNT_COPY["oidc.consent.deny"],
  };
}

export interface PanelView {
  readonly title: string;
  readonly body: string;
  /** A way back to the client, on the refusal panel only. */
  readonly link: { readonly href: string; readonly label: string } | null;
}

const RULE_COPY: Readonly<Record<OidcRuleRefusalReason, AccountCopyKey>> = {
  account_inactive: "oidc.rule.account_inactive",
  account_not_person: "oidc.rule.account_not_person",
  orcid_not_proven: "oidc.rule.orcid_not_proven",
};

const ERROR_COPY: Readonly<Record<OidcErrorPanel, AccountCopyKey>> = {
  invalid_client: "oidc.error.invalid_client",
  invalid_redirect_uri: "oidc.error.invalid_redirect_uri",
  invalid_request: "oidc.error.invalid_request",
  consent_invalid: "oidc.error.consent_invalid",
  unavailable: "oidc.error.unavailable",
  rate_limited: "oidc.error.rate_limited",
};

/** The refusal panel: why this account may not sign in to the client, and the way back to it. */
export function rulePanelView(
  outcome: Extract<OidcAuthorizeOutcome, { kind: "rule_refused" }>,
): PanelView {
  const client = { client: outcome.clientName };
  return {
    title: fillCopy(ACCOUNT_COPY["oidc.rule.title"], client),
    body: fillCopy(ACCOUNT_COPY[RULE_COPY[outcome.reason]], client),
    link: { href: outcome.location, label: fillCopy(ACCOUNT_COPY["oidc.rule.return"], client) },
  };
}

/** An error panel: the request goes nowhere, and nothing links anywhere. */
export function errorPanelView(code: OidcErrorPanel): PanelView {
  return {
    title: ACCOUNT_COPY["oidc.error.title"],
    body: ACCOUNT_COPY[ERROR_COPY[code]],
    link: null,
  };
}

/** The status each rendered panel answers with. */
export function oidcPanelStatus(
  outcome: Extract<OidcAuthorizeOutcome, { kind: "consent" | "rule_refused" | "error" }>,
): number {
  if (outcome.kind === "consent") return 200;
  if (outcome.kind === "rule_refused") return 403;
  if (outcome.code === "rate_limited") return 429;
  if (outcome.code === "unavailable") return 503;
  return 400;
}
