/**
 * The one backend call the private-site sign-in handoff needs: `POST /auth/private/grant`, which
 * mints a short-lived one-time code bound to the browser's `state`.
 *
 * Shaped like `./docs-auth-api.ts`: it only moves bytes, never throws, and does not decide what a
 * status means (`privateGrantOutcome` in `./private-authorize.ts` does). It runs during SSR of
 * `/auth/private/authorize` on the app host, so `cookieHeader` is the visitor's own `Cookie`
 * header, forwarded so the backend resolves the same web session the browser is signed into.
 *
 * NOTHING HERE LOGS THE STATE. It travels in the request body only; a failure is logged by its
 * kind, never with the request.
 */

import { apiBase } from "./api-base";
import { type DeadlineInit, resolveSignal } from "./request-deadline";

export interface PrivateGrantInit extends DeadlineInit {
  /** Test seam, matching the handed-in-fetch pattern in `docs-auth-api.test.ts`. */
  readonly fetch?: typeof fetch;
  /** The SSR request's own `Cookie` header. */
  readonly cookieHeader?: string;
  /**
   * The page's own origin, pinned by the caller as `Astro.url.origin`. Required: a server-side
   * fetch carries no Origin of its own, and the backend refuses a missing one with 403 before it
   * looks at the session (see `./docs-auth-api.ts` for the full account).
   */
  readonly origin: string;
  /** The `state` the private site gave this browser, already validated by the page. */
  readonly state: string;
}

/** The real status plus the parsed JSON body (`null` when not JSON), or the network sentinel. */
export type PrivateGrantResult =
  | { readonly status: number; readonly body: unknown }
  | { readonly status: "network" };

/**
 * `POST /auth/private/grant` with `{ state }`. Answers `{ code, expires_in }` on 200,
 * `{ error: "unauthenticated" }` on 401, the inactive-account body on 403, `{ error:
 * "invalid_request" }` on 400 and the rate-limit body on 429.
 */
export async function requestPrivateGrant(init: PrivateGrantInit): Promise<PrivateGrantResult> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: init.origin,
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  try {
    const res = await fetchImpl(`${apiBase()}/auth/private/grant`, {
      method: "POST",
      headers,
      body: JSON.stringify({ state: init.state }),
      // Never follow a redirect: the backend answers this route directly, so a 3xx means
      // something between here and it is misrouting the request, and following it would resend
      // the visitor's cookie and `state` to wherever it points. The 3xx comes back as its status,
      // which `privateGrantOutcome` maps to `unavailable`.
      redirect: "manual",
      // A mutation (it writes a grant row) on the critical path of a redirect a person is waiting
      // on, so bounded with the mutate-sized deadline, as the docs grant is.
      signal: resolveSignal(init, 15_000),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        console.warn("[private-auth-api] requestPrivateGrant: failed to read response body", err);
      }
    }
    return { status: res.status, body };
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    console.warn(
      `[private-auth-api] requestPrivateGrant failed${timedOut ? " (timeout)" : ""}`,
      err instanceof Error ? err.message : String(err),
    );
    return { status: "network" };
  }
}
