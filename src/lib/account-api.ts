/**
 * Account-tier API client: email verification, the one-time upload-access
 * request, the default-username suggestion, and the identity lookup that
 * resolves a username `/auth/me` does not carry (website#301).
 *
 * Two transports, for the reason `api-base.ts` documents:
 *
 * - The two **email-verification** calls go through dedicated same-origin
 *   proxies under `/api/auth/email/verify*`. They have to: the backend
 *   Origin-allow-lists both, and a server-side Worker fetch carries no
 *   Origin, so `forwardAuthMutation` pins one. Those routes also carry the
 *   `astro dev` mock, so the flow is exercisable locally.
 * - Everything else goes through `dashboardApiBase()` — `api.nemar.org`
 *   direct when SSR passes a `cookieHeader`, the generic `/api/v1` proxy
 *   from the browser.
 *
 * Errors carry more than a code: an upload-access refusal's `missing` array
 * is what the Settings form turns into links, and a wrong verification code's
 * `attempts_remaining` decides whether the code in hand is still usable. Both
 * would be lost through `DashboardApiError`, so this module has its own error
 * type — see {@link AccountApiError}.
 */

import { dashboardApiBase } from "./api-base";
import { type DeadlineInit, resolveSignal } from "./request-deadline";

type Init = DeadlineInit & {
  readonly fetch?: typeof fetch;
  /** SSR only. Present => talk to `api.nemar.org` direct with this cookie. */
  readonly cookieHeader?: string;
};

/**
 * A typed backend refusal.
 *
 * `missing` is always an array (possibly empty) because every refusal on
 * `POST /users/me/upload-access/request` ships one — the backend guarantees
 * the shape so a client has one thing to read, and normalising a missing key
 * to `[]` here keeps that promise for the transport-failure paths too.
 */
export class AccountApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly missing: readonly string[];
  readonly attemptsRemaining?: number;

  constructor(
    message: string,
    status: number,
    detail: {
      code?: string;
      missing?: readonly string[];
      attemptsRemaining?: number;
    } = {},
  ) {
    super(message);
    this.name = "AccountApiError";
    this.status = status;
    this.code = detail.code;
    this.missing = detail.missing ?? [];
    this.attemptsRemaining = detail.attemptsRemaining;
  }
}

/**
 * Parse a non-OK body into the pieces the UI renders.
 *
 * Exported because the parsing, not the fetching, is what has edge cases: a
 * proxy 502 with no JSON body at all, a `missing` that arrives as something
 * other than an array of strings, an `attempts_remaining` of `0` (which is
 * meaningful and must survive a falsy check).
 */
export function parseAccountErrorBody(body: unknown): {
  code?: string;
  message?: string;
  missing: string[];
  attemptsRemaining?: number;
} {
  if (!body || typeof body !== "object") return { missing: [] };
  const raw = body as Record<string, unknown>;
  const code = typeof raw.error === "string" && raw.error.length > 0 ? raw.error : undefined;
  const message =
    typeof raw.message === "string" && raw.message.length > 0 ? raw.message : undefined;
  const missing = Array.isArray(raw.missing)
    ? raw.missing.filter((v): v is string => typeof v === "string")
    : [];
  const attemptsRemaining =
    typeof raw.attempts_remaining === "number" && Number.isFinite(raw.attempts_remaining)
      ? raw.attempts_remaining
      : undefined;
  return { code, message, missing, attemptsRemaining };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function throwFromResponse(res: Response, fallback: string): Promise<never> {
  const detail = parseAccountErrorBody(await readJson(res));
  throw new AccountApiError(detail.message ?? detail.code ?? fallback, res.status, {
    code: detail.code,
    missing: detail.missing,
    attemptsRemaining: detail.attemptsRemaining,
  });
}

// ---------------------------------------------------------------------------
// Email verification (unverified -> base tier)
// ---------------------------------------------------------------------------

export interface EmailVerificationRequestResult {
  readonly ok: true;
  readonly already_verified?: boolean;
  readonly masked_email?: string;
  /** Non-production only: the backend echoes the code so staging QA can
   *  finish the flow without an inbox, exactly as `/login/verify` surfaces it.
   *  A production response that carried this would be a backend bug. */
  readonly dev_code?: string;
  /** The address is not on the non-production allowlist, so nothing was sent
   *  (nemar-cli `issueEmailVerificationCode`'s fence — the dev D1 holds real
   *  addresses behind a live Resend key). Reported so staging QA can tell
   *  "not sent on purpose" from "not delivered". */
  readonly dev_skip?: string;
}

/** Step 1: mail a 6-digit code to the signed-in account's own address. Takes
 *  no argument on purpose — the target is `users.email` and nothing else,
 *  which is what keeps the endpoint from being a mail-anyone primitive. */
export async function requestEmailVerificationCode(
  init: Init = {},
): Promise<EmailVerificationRequestResult> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl("/api/auth/email/verify/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    body: "{}",
    signal: resolveSignal(init),
  });
  if (!res.ok) await throwFromResponse(res, "Could not send the code");
  return ((await readJson(res)) ?? { ok: true }) as EmailVerificationRequestResult;
}

export interface EmailVerificationResult {
  readonly ok: true;
  readonly already_verified?: boolean;
}

/** Step 2: redeem the code. On success the account has left `pending`, so
 *  every caller reloads rather than patching the page — the tier changes what
 *  the whole surface renders, not one banner. */
export async function verifyEmailCode(
  code: string,
  init: Init = {},
): Promise<EmailVerificationResult> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl("/api/auth/email/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    body: JSON.stringify({ code }),
    signal: resolveSignal(init),
  });
  if (!res.ok) await throwFromResponse(res, "Could not verify that code");
  return ((await readJson(res)) ?? { ok: true }) as EmailVerificationResult;
}

// ---------------------------------------------------------------------------
// Upload access
// ---------------------------------------------------------------------------

export interface UploadAccessRequestResult {
  readonly ok: true;
  /** True when a request was already open: the backend does NOT re-mail the
   *  admins, so the UI must say "already sent", not "sent". */
  readonly already_requested: boolean;
  readonly requested_at?: string | null;
}

/**
 * Ask for upload access, once. 201 on the request that actually opened,
 * 200 with `already_requested` while one is open, 409 `already_approved`
 * once granted; every refusal carries `{ error, message, missing }`.
 */
export async function requestUploadAccess(
  why: string,
  init: Init = {},
): Promise<UploadAccessRequestResult> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/users/me/upload-access/request`,
    {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({ why }),
      // A GitHub existence check runs inside this request, so it is slower
      // than a plain D1 write and gets the mutate-sized deadline rather than
      // the default read one.
      signal: resolveSignal(init, 15_000),
    },
  );
  if (!res.ok) await throwFromResponse(res, "Could not send the request");
  const body = ((await readJson(res)) ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    already_requested: body.already_requested === true,
    requested_at: typeof body.requested_at === "string" ? body.requested_at : null,
  };
}

// ---------------------------------------------------------------------------
// Onboarding lookups
// ---------------------------------------------------------------------------

export interface UsernameSuggestion {
  readonly suggestion: string | null;
  /** `"unavailable"` means the account has no family name to build a handle
   *  from, or the name folds to nothing usable in ASCII. Nothing is derived
   *  from the email local part in that case (nemar-cli ADR 0042), so the
   *  form prompts for a handle instead of prefilling a guess. */
  readonly based_on: "name" | "unavailable";
}

/**
 * A default username. Reserves nothing — two accounts offered the same handle
 * still race at the PATCH, which is what the uniqueness check there is for —
 * so the caller must still handle `username_taken`.
 *
 * Fail-soft: a suggestion is a convenience, and a backend that cannot produce
 * one must leave the field empty rather than break the onboarding page.
 */
export async function fetchUsernameSuggestion(init: Init = {}): Promise<UsernameSuggestion> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  try {
    const res = await fetchImpl(
      `${dashboardApiBase(init.cookieHeader)}/auth/profile/username-suggestion`,
      { method: "GET", headers, credentials: "include", signal: resolveSignal(init) },
    );
    if (!res.ok) return { suggestion: null, based_on: "unavailable" };
    const body = ((await readJson(res)) ?? {}) as Record<string, unknown>;
    const suggestion = typeof body.suggestion === "string" ? body.suggestion : null;
    return {
      suggestion,
      based_on: body.based_on === "name" && suggestion ? "name" : "unavailable",
    };
  } catch (err) {
    console.warn("[account-api] username suggestion unavailable:", err);
    return { suggestion: null, based_on: "unavailable" };
  }
}

export interface AccountIdentity {
  /** `null` = the account genuinely has no username (the ORCID/web default).
   *  `undefined` = the lookup failed, so nothing can be concluded — see
   *  `onboardingSteps`, which deliberately treats the two differently. */
  readonly username: string | null | undefined;
}

/**
 * Resolve the account's login handle.
 *
 * `GET /auth/me` does not select `username` (nemar-cli
 * `backend/src/routes/auth-web.ts`'s `publicUser`), and the onboarding gate,
 * the Settings username field and the upload-access preconditions all need
 * it. `GET /users/me` does carry it (`shared/contract/user.ts`), takes the
 * same session cookie through `authMiddleware`, and is one call — so that is
 * where it comes from until `/auth/me` grows the field, at which point the
 * session value short-circuits this entirely.
 *
 * Fail-soft on purpose, and specifically to `undefined` rather than `null`:
 * an unverified account gets a 403 from `authMiddleware` (its tier cannot
 * reach `/users/me` at all), and reading that as "no username" would prompt
 * for one on a page whose only job is verifying an email.
 */
export async function fetchAccountIdentity(
  sessionUsername: string | undefined,
  init: Init = {},
): Promise<AccountIdentity> {
  if (sessionUsername !== undefined) return { username: sessionUsername };
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  try {
    const res = await fetchImpl(`${dashboardApiBase(init.cookieHeader)}/users/me`, {
      method: "GET",
      headers,
      credentials: "include",
      signal: resolveSignal(init),
    });
    if (!res.ok) return { username: undefined };
    const body = ((await readJson(res)) ?? {}) as { user?: Record<string, unknown> };
    const user = body.user;
    if (!user || typeof user !== "object") return { username: undefined };
    if (typeof user.username === "string") {
      const trimmed = user.username.trim();
      return { username: trimmed.length > 0 ? trimmed : null };
    }
    // An explicit JSON null is the real "no username" answer; anything else
    // (key absent, wrong type) is a shape we cannot read.
    return { username: user.username === null ? null : undefined };
  } catch (err) {
    console.warn("[account-api] /users/me identity lookup failed:", err);
    return { username: undefined };
  }
}
