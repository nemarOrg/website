/**
 * Device-authorization API client (epic #1272 phase 2, nemarOrg/website#316).
 * The three calls the `/cli/authorize` page and the Settings CLI-keys card
 * need against the backend's device-authorization grant (nemar-cli ADR
 * 0047): read what a code names, decide it, and list live keys.
 *
 * `/cli/authorize` renders entirely server-side, with real form POSTs and
 * no client script, so every one of these runs during SSR — `init.cookieHeader`
 * is always the request's own `Cookie` header, forwarded so the backend
 * resolves the same web session the browser is signed into.
 *
 * Two different Origin postures, both load-bearing:
 * - {@link lookupDeviceCode} is a GET and carries no Origin at all — the
 *   backend's `/auth/device/lookup` route never checks one.
 * - {@link decideDeviceCode} sits behind the backend's `webSessionMiddleware`
 *   (cookie-only) and calls `isAllowedOrigin` directly; {@link listApiKeys}
 *   goes through `resolveActingAccount` instead, which accepts either a
 *   bearer token or Origin-checks the cookie path the same way. Either
 *   route means callers must pin `Astro.url.origin` — never a hardcoded
 *   production host, so staging's `test.nemar.org` passes the allow-list
 *   too (it accepts any `*.nemar.org` origin).
 *
 * No local error-code normalizer or mirrored vocabulary here (ADR 0005:
 * reuse the backend, never reimplement it): this module only moves bytes.
 * Reading `error`/`message` out of a response body and deciding what to
 * render is `./device-authorize.ts`'s job.
 *
 * Never throws. A rejected fetch (network failure, timeout) becomes
 * `{ status: "network" }` so a caller can render "we couldn't reach NEMAR"
 * without a try/catch of its own — the same shape `account-api.ts` uses for
 * `fetchUsernameSuggestion`'s fail-soft path, generalized into the return
 * type here since every caller on this page needs it.
 */

import { apiBase } from "./api-base";
import { type DeadlineInit, resolveSignal } from "./request-deadline";

/** Every call takes an optional `fetch` override (the `account-api.test.ts`
 *  handed-in-fetch pattern) and the SSR request's own Cookie header. */
export interface DeviceAuthInit extends DeadlineInit {
  readonly fetch?: typeof fetch;
  readonly cookieHeader?: string;
}

/** The two Origin-gated calls additionally require the page's own origin. */
export interface DeviceAuthMutationInit extends DeviceAuthInit {
  readonly origin: string;
}

/**
 * Every call's result: the real HTTP status plus its parsed JSON body (`null`
 * when the body could not be parsed as JSON), or the network sentinel when
 * the fetch itself never got a response. Never throws — see the module
 * comment — so a caller always gets one of these two shapes back.
 */
export type DeviceApiResult<T> =
  | { readonly status: number; readonly body: T | null }
  | { readonly status: "network" };

async function readJsonBody(res: Response, label: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    // A SyntaxError means the body just isn't JSON — the caller
    // (`./device-authorize.ts`) already classifies that as its own
    // "malformed" case and logs status + body there. Anything else here
    // (a body-stream read failure, say) is unusual enough to log at the
    // point it actually happened.
    if (!(err instanceof SyntaxError)) {
      console.warn(`[device-auth-api] ${label}: failed to read response body`, err);
    }
    return null;
  }
}

/** Whether a caught fetch error is the deadline this module always sets via
 *  `resolveSignal` (as opposed to a DNS failure, a refused connection, or a
 *  torn connection) — worth naming in the log line since a timeout usually
 *  means "the backend is slow", not "the backend is down". */
function isTimeout(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError";
}

/**
 * `GET /auth/device/lookup?code=...`. Cookie + Accept only, no Origin (the
 * backend route never checks one for this GET). Whatever the account can or
 * cannot do with the code rides in the 200 body's `refusal` field, not the
 * HTTP status — only a code the backend has never issued, or one that has
 * expired/been used/been denied, answers with a non-200 status.
 */
export async function lookupDeviceCode(
  code: string,
  init: DeviceAuthInit = {},
): Promise<DeviceApiResult<unknown>> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  try {
    const res = await fetchImpl(
      `${apiBase()}/auth/device/lookup?code=${encodeURIComponent(code)}`,
      {
        method: "GET",
        headers,
        signal: resolveSignal(init),
      },
    );
    return { status: res.status, body: await readJsonBody(res, "lookupDeviceCode") };
  } catch (err) {
    console.warn(
      `[device-auth-api] lookupDeviceCode failed${isTimeout(err) ? " (timeout)" : ""}`,
      err,
    );
    return { status: "network" };
  }
}

/** The page's own vocabulary ("Authorize" / "Deny" buttons); mapped onto the
 *  backend's `/auth/device/confirm` and `/auth/device/deny` routes below. */
export type DeviceAuthIntent = "authorize" | "deny";

/**
 * `POST /auth/device/{confirm,deny}`. Cookie + Origin + JSON body `{ code }`,
 * matching the backend's `zValidator("json", ...)` guard, which 400s any
 * other content type.
 */
export async function decideDeviceCode(
  intent: DeviceAuthIntent,
  code: string,
  init: DeviceAuthMutationInit,
): Promise<DeviceApiResult<unknown>> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: init.origin,
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const path = intent === "authorize" ? "confirm" : "deny";
  try {
    const res = await fetchImpl(`${apiBase()}/auth/device/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ code }),
      // A mutation, not a read: the mutate-sized deadline `account-api.ts`
      // uses for `requestUploadAccess`, which also writes through a gate.
      signal: resolveSignal(init, 15_000),
    });
    return { status: res.status, body: await readJsonBody(res, `decideDeviceCode(${intent})`) };
  } catch (err) {
    console.warn(
      `[device-auth-api] decideDeviceCode(${intent}) failed${isTimeout(err) ? " (timeout)" : ""}`,
      err,
    );
    return { status: "network" };
  }
}

/**
 * `GET /auth/keys`. Cookie + Origin: the cookie path 403s `"Origin not
 * allowed"` without one (`resolveActingAccount`'s Origin allow-list on the
 * backend), so a server-side GET must pin one explicitly — a server-side
 * Worker fetch carries no Origin of its own, unlike a browser request.
 */
export async function listApiKeys(init: DeviceAuthMutationInit): Promise<DeviceApiResult<unknown>> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json", Origin: init.origin };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  try {
    const res = await fetchImpl(`${apiBase()}/auth/keys`, {
      method: "GET",
      headers,
      signal: resolveSignal(init),
    });
    return { status: res.status, body: await readJsonBody(res, "listApiKeys") };
  } catch (err) {
    console.warn(`[device-auth-api] listApiKeys failed${isTimeout(err) ? " (timeout)" : ""}`, err);
    return { status: "network" };
  }
}
