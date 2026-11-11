/**
 * The two API calls `/oauth/authorize` makes: the check (`POST /auth/oidc/authorize`) and the consent
 * (`POST /auth/oidc/consent`) of NEMAR's OpenID Connect authorization endpoint (nemar-cli ADR 0119).
 *
 * Shaped like `./private-auth-api.ts`: each only moves bytes, never throws, and does not decide what
 * a status means (`oidcAnswerOutcome` in `./oidc-authorize.ts` does). Both run during SSR on the app
 * host, so `cookieHeader` is the visitor's own `Cookie` header, forwarded so the API resolves the same
 * session the browser is signed into, and `origin` is pinned by the page, because a server-side call
 * carries no `Origin` of its own and the API refuses one without it. Both carry
 * `OIDC_AUTHORIZE_CALLER_HEADER`, which the API requires and the general browser proxy never
 * forwards, so an answer (a code, a consent token) reaches only this server code.
 *
 * NOTHING HERE LOGS THE REQUEST, a consent token or an answer: an answer can carry a code. A failure
 * is logged by its kind only.
 */

import { apiBase } from "./api-base";
import { apiFetch } from "./api-fetch";
import {
  OIDC_AUTHORIZE_CALLER_HEADER,
  OIDC_AUTHORIZE_CALLER_VALUE,
  OIDC_AUTHORIZE_CHECK_PATH,
  OIDC_AUTHORIZE_CONSENT_PATH,
  type OidcConsentDecision,
} from "./oidc-authorize";
import { type DeadlineInit, resolveSignal } from "./request-deadline";

interface CallInit extends DeadlineInit {
  /** Test seam, matching the handed-in-fetch pattern in `private-auth-api.test.ts`. */
  readonly fetch?: typeof fetch;
  /** The SSR request's own `Cookie` header. */
  readonly cookieHeader?: string;
  /** The page's own origin, pinned by the caller as `Astro.url.origin`. Required. */
  readonly origin: string;
}

export interface OidcCheckInit extends CallInit {
  /** The authorization request's query string, as the visitor sent it. */
  readonly request: string;
}

export interface OidcConsentInit extends CallInit {
  /** The same request string the check read. */
  readonly request: string;
  readonly consentToken: string;
  readonly decision: OidcConsentDecision;
}

/** The real status plus the parsed JSON body (`null` when not JSON), or the network sentinel. */
export type OidcAuthorizeResult =
  | { readonly status: number; readonly body: unknown }
  | { readonly status: "network" };

async function post(path: string, init: CallInit, body: unknown): Promise<OidcAuthorizeResult> {
  const fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = init.fetch ?? apiFetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: init.origin,
    // Marks the call as this page's own; the browser proxy never forwards it.
    [OIDC_AUTHORIZE_CALLER_HEADER]: OIDC_AUTHORIZE_CALLER_VALUE,
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  try {
    const res = await fetchImpl(`${apiBase()}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // Never follow a redirect: the API answers these routes directly, so a 3xx means something
      // between here and it is misrouting the call, and following it would resend the visitor's
      // cookie and request to wherever it points.
      redirect: "manual",
      // On the critical path of a redirect a person is waiting on, and the check can write a code,
      // so bounded with the mutate-sized deadline the other sign-in handoffs use.
      signal: resolveSignal(init, 15_000),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        console.warn("[oidc-authorize-api] failed to read the response body");
      }
    }
    return { status: res.status, body: parsed };
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    console.warn(`[oidc-authorize-api] the call failed${timedOut ? " (timeout)" : ""}`);
    return { status: "network" };
  }
}

/** `POST /auth/oidc/authorize` with `{ request }`. */
export function requestOidcCheck(init: OidcCheckInit): Promise<OidcAuthorizeResult> {
  return post(OIDC_AUTHORIZE_CHECK_PATH, init, { request: init.request });
}

/** `POST /auth/oidc/consent` with `{ request, consent_token, decision }`. */
export function requestOidcConsent(init: OidcConsentInit): Promise<OidcAuthorizeResult> {
  return post(OIDC_AUTHORIZE_CONSENT_PATH, init, {
    request: init.request,
    consent_token: init.consentToken,
    decision: init.decision,
  });
}
