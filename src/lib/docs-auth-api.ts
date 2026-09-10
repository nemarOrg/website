/**
 * The one backend call the docs-site admin handoff needs (nemarOrg/nemar-cli#1338):
 * `POST /auth/docs/grant`, which mints a short-lived one-time code the docs host can exchange for
 * a cookie of its own.
 *
 * Shaped like `./device-auth-api.ts` rather than `./dashboard-api.ts` on purpose. This module only
 * moves bytes: it never throws, and it does not decide what any status means — that is
 * `./docs-authorize.ts`'s `docsGrantOutcome`. A `DashboardApiError`-style throw would put a
 * try/catch in the page frontmatter for a call whose failure is a rendered state, not an
 * exception, and 404 here is a real answer (a signed-in non-admin) rather than an error at all.
 *
 * `/auth/docs/authorize` renders entirely server-side, so this always runs during SSR and
 * `init.cookieHeader` is always the visitor's own `Cookie` header, forwarded so the backend
 * resolves the same web session the browser is signed into. The session cookie is scoped
 * `Domain=app.nemar.org` and this hop runs on that host, so it is present.
 */

import { apiBase } from "./api-base";
import { type DeadlineInit, resolveSignal } from "./request-deadline";

export interface DocsGrantInit extends DeadlineInit {
  /** Test seam, matching the handed-in-fetch pattern in `account-api.test.ts`. */
  readonly fetch?: typeof fetch;
  /** The SSR request's own `Cookie` header. */
  readonly cookieHeader?: string;
  /**
   * The page's own origin, pinned by the caller as `Astro.url.origin` — never a hardcoded
   * production host, so staging's `test.nemar.org` passes the backend allow-list too (it accepts
   * any `*.nemar.org` origin, plus localhost).
   *
   * Not optional, and not belt-and-braces. A `fetch` from a Worker is server-to-server and carries
   * no Origin of its own, unlike a browser request, while `isAllowedOrigin` on the backend
   * (`backend/src/services/web-session.ts`) answers `false` for an ABSENT Origin, and every
   * cookie-authenticated POST in `auth-web.ts` checks it BEFORE it checks authentication. Omitting
   * it therefore yields `403 {"error":"Origin not allowed"}` with a perfectly valid session cookie
   * attached — the failure would look like a backend outage rather than a missing header.
   * `decideDeviceCode` in `./device-auth-api.ts` pins its own for the same reason.
   */
  readonly origin: string;
}

/**
 * The real HTTP status plus the parsed JSON body (`null` when the body was not JSON), or the
 * network sentinel when the fetch never got a response at all. Never throws, so a caller always
 * gets one of these two shapes; `docsGrantOutcome` folds both into the page's states.
 */
export type DocsGrantResult =
  | { readonly status: number; readonly body: unknown }
  | { readonly status: "network" };

/**
 * `POST /auth/docs/grant`. Answers `{ code, expires_in }` on 200, `{ error: "unauthenticated" }`
 * on 401, and `{ error: "not_found" }` on 404 for a signed-in NON-admin — 404 rather than 403 so
 * the existence of the admin surface is not disclosed.
 */
export async function requestDocsGrant(init: DocsGrantInit): Promise<DocsGrantResult> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: init.origin,
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  try {
    const res = await fetchImpl(`${apiBase()}/auth/docs/grant`, {
      method: "POST",
      headers,
      // An empty JSON object rather than no body, matching the shape `decideDeviceCode` posts.
      // `/auth/docs/grant` takes no parameters and has no `zValidator`, so this is convention
      // rather than a requirement: it keeps every POST from this codebase looking alike, and it
      // means adding a field later needs no change here.
      body: "{}",
      // A mutation (it writes a code row), so the mutate-sized deadline rather than the read one.
      // This sits on the critical path of a redirect a person is waiting on, so it must be
      // bounded: an unbounded SSR fetch stalls the render until the platform's own ceiling.
      signal: resolveSignal(init, 15_000),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch (err) {
      // A SyntaxError just means the body was not JSON, which `docsGrantOutcome` already handles
      // as its own case (and logs with the status). Anything else — a torn body stream — is
      // unusual enough to name where it happened.
      if (!(err instanceof SyntaxError)) {
        console.warn("[docs-auth-api] requestDocsGrant: failed to read response body", err);
      }
    }
    return { status: res.status, body };
  } catch (err) {
    // A timeout is worth naming separately: it usually means the backend is slow, not down.
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    console.warn(`[docs-auth-api] requestDocsGrant failed${timedOut ? " (timeout)" : ""}`, err);
    return { status: "network" };
  }
}
