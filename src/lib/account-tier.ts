/**
 * Account tiers, as the website renders them (website#301; nemar-cli ADRs
 * 0040 / 0042).
 *
 * Three tiers, and the boundary between the first two is the ONLY thing
 * `AuthUser.status` reports:
 *
 * - **unverified** (`status === "pending"`) — the emailed 6-digit code has not
 *   been redeemed. Verifying it is the only action available, and it is
 *   self-service: no admin is coming. This replaced the old "under admin
 *   review" copy, which told base-tier users to wait for something that was
 *   never going to happen (website ADR 0010's auto-approve half, superseded by
 *   nemar-cli ADR 0040).
 * - **base** (`status === "active"`, no grant) — browse, dashboard, settings,
 *   and the ability to *ask* for upload access.
 * - **upload** (`service_access === true`) — an admin has reviewed the person
 *   and granted the tier. The backend enforces it on every real upload
 *   (nemar-cli `backend/src/services/upload-gate.ts`); nothing here is access
 *   control, only which UI renders.
 *
 * Everything in this module is pure so the state machine is testable without
 * a Worker or a rendered page, matching `profile.ts` and `dashboard-api.ts`'s
 * derivation helpers.
 */

import type { AuthUser } from "./auth";
import { canUpload } from "./profile";

/** The subset of the session every derivation below reads. */
type TierUser = Pick<
  AuthUser,
  | "status"
  | "service_access"
  | "service_access_granted_at"
  | "upload_access_requested_at"
  | "city"
  | "country"
  | "github_username"
>;

export type AccountTier = "unverified" | "base" | "upload";

/**
 * Which tier the signed-in account holds.
 *
 * Keyed on `status` and `service_access` and deliberately NOT on
 * `email_verified`: the backend sets that flag on both roads out of `pending`
 * (nemar-cli ADR 0040 phase 2), so a `"active"` account with the flag absent
 * is an older backend, not an unverified inbox. Treating `undefined` as
 * unverified there would show a verify-your-email step to accounts that have
 * nothing to verify.
 *
 * `null`/`undefined` (no session) is not a tier and callers must redirect to
 * sign-in before asking; it answers `"unverified"` so a caller that forgets
 * fails to the most restricted surface rather than the least.
 */
export function deriveAccountTier(user: TierUser | null | undefined): AccountTier {
  if (!user) return "unverified";
  if (user.status === "pending") return "unverified";
  return user.service_access === true ? "upload" : "base";
}

/**
 * The state of this account's one-time upload-access request, as Settings
 * renders it. A discriminated union rather than a bare enum because each
 * branch carries a different timestamp and the caller must not have to guard
 * one that cannot be set.
 *
 * `at` is optional on both dated branches: neither `service_access_granted_at`
 * nor `upload_access_requested_at` is on `/auth/me` yet (see `AuthUser`), so
 * "granted" and "requested" have to render without a date until they are.
 */
export type UploadAccessState =
  | { readonly kind: "granted"; readonly at?: string }
  | { readonly kind: "requested"; readonly at?: string }
  | { readonly kind: "not_requested" };

export function deriveUploadAccessState(user: TierUser | null | undefined): UploadAccessState {
  if (!user) return { kind: "not_requested" };
  if (user.service_access === true) {
    const at = nonBlank(user.service_access_granted_at);
    return at ? { kind: "granted", at } : { kind: "granted" };
  }
  const requestedAt = nonBlank(user.upload_access_requested_at);
  if (requestedAt) return { kind: "requested", at: requestedAt };
  return { kind: "not_requested" };
}

/**
 * What `/upload` renders.
 *
 * - `"verify_email"` — unverified tier; the verify step, nothing else.
 * - `"request_access"` — base tier with no open request. The CTA is "request
 *   upload access", never a sandbox mention: sandbox training is CLI-only
 *   (nemar-cli ADR 0040), so telling a web user to complete it would send
 *   them to a command line for a step the web upload gate does not check.
 * - `"access_requested"` — base tier, request open, waiting on an admin.
 * - `"warn"` — granted, but city/country are still blank. Kept from website
 *   ADR 0011: every account granted before migrations 0051/0052 has empty
 *   profile columns, and blocking them would block exactly the population
 *   the tier admits.
 * - `"open"` — granted and complete.
 *
 * The dropzone renders for `"warn"` and `"open"` — i.e. gated on
 * `service_access` alone. ADR 0011's third branch (`"block"`: withhold the
 * form from an ungranted account with an incomplete profile) is gone, because
 * an ungranted account can no longer reach the form at all and city/country
 * are now collected at onboarding and re-checked by the request endpoint.
 */
export type UploadPageState =
  | "verify_email"
  | "request_access"
  | "access_requested"
  | "warn"
  | "open";

export function deriveUploadPageState(user: TierUser | null | undefined): UploadPageState {
  const tier = deriveAccountTier(user);
  if (tier === "unverified") return "verify_email";
  if (tier === "base") {
    return deriveUploadAccessState(user).kind === "requested"
      ? "access_requested"
      : "request_access";
  }
  return canUpload(user) ? "open" : "warn";
}

/** True when `/upload` should ship the dropzone and the attestation form. */
export function showsUploadForm(state: UploadPageState): boolean {
  return state === "warn" || state === "open";
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

/**
 * What a freshly signed-in account still has to supply before it is a person
 * an admin could review.
 *
 * - `"username"` — NULL by design on every ORCID/web signup (nemar-cli
 *   migration 0026). `nemar admin approve <username>` and the dataset repos
 *   an approved account owns are both keyed on it.
 * - `"name"` — required to mint a DOI that cites a person (nemar-cli ADR
 *   0041). **Only ever a step when no verified ORCID iD is linked**: with one,
 *   the name is re-read from the record on every sign-in and `PATCH
 *   /auth/profile` refuses the edit with `name_is_orcid_canonical`, so asking
 *   for it here would be asking for something the backend will not accept.
 *   That is the one step this flow skips rather than blocks on.
 * - `"location"` — the export-control screening inputs (website ADR 0010).
 */
export type OnboardingStep = "username" | "name" | "location";

/** The account fields the onboarding gate reads. `username` is `string | null`
 *  rather than optional because `GET /users/me` reports it as an explicit
 *  NULL, and `undefined` there means "could not ask" — see
 *  {@link onboardingSteps} for how the two differ. */
export interface OnboardingAccount {
  readonly username?: string | null;
  readonly given_name?: string;
  readonly family_name?: string;
  readonly city?: string;
  readonly country?: string;
  readonly orcid_verified?: boolean;
}

/**
 * The steps still outstanding, in prompt order.
 *
 * `username: undefined` means the username could not be read at all (the
 * `/users/me` lookup failed, or an older `/auth/me` that does not carry it).
 * That is NOT the same as a NULL username, and it does not raise the step:
 * prompting someone to pick a handle they may already have, and then 409ing
 * them on `username_taken` against their own row, is worse than skipping a
 * prompt they can still reach from Settings.
 */
export function onboardingSteps(account: OnboardingAccount): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  if (account.username !== undefined && isBlank(account.username)) steps.push("username");
  if (
    account.orcid_verified !== true &&
    (isBlank(account.given_name) || isBlank(account.family_name))
  ) {
    steps.push("name");
  }
  if (isBlank(account.city) || isBlank(account.country)) steps.push("location");
  return steps;
}

export function needsOnboarding(account: OnboardingAccount): boolean {
  return onboardingSteps(account).length > 0;
}

// ---------------------------------------------------------------------------
// Username format (mirrors nemar-cli backend/src/services/username.ts)
// ---------------------------------------------------------------------------

/** 3-30 characters of letters, digits, underscore or hyphen — the same rule
 *  CLI signup applies, spelled out as bounds plus a charset so the message
 *  can say which rule broke. Duplicated here on purpose: the two repos share
 *  no package, and a client-side check that disagreed with the server would
 *  either reject a valid handle or let an invalid one round-trip. */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
export const USERNAME_CHARSET_RE = /^[a-zA-Z0-9_-]+$/;

export type UsernameFormatError = "username_too_short" | "username_too_long" | "username_charset";

/** The refusal for a badly formed username, or null when it is well-formed.
 *  Shapes match the backend's `validateUsernameFormat` so a client-side and a
 *  server-side rejection read identically. */
export function validateUsername(
  raw: string,
): { readonly error: UsernameFormatError; readonly message: string } | null {
  const username = raw.trim();
  if (username.length < USERNAME_MIN_LENGTH) {
    return {
      error: "username_too_short",
      message: `Username must be at least ${USERNAME_MIN_LENGTH} characters`,
    };
  }
  if (username.length > USERNAME_MAX_LENGTH) {
    return {
      error: "username_too_long",
      message: `Username must be at most ${USERNAME_MAX_LENGTH} characters`,
    };
  }
  if (!USERNAME_CHARSET_RE.test(username)) {
    return {
      error: "username_charset",
      message: "Username can only contain letters, numbers, underscores, and hyphens",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Upload-access request
// ---------------------------------------------------------------------------

/** Bounds on the why text, matching `WHY_MIN_CHARS`/`WHY_MAX_CHARS` in
 *  nemar-cli `backend/src/services/upload-access.ts`. */
export const WHY_MIN_CHARS = 20;
export const WHY_MAX_CHARS = 500;

/** The client-side refusal for the why text, or null when it will pass. */
export function validateWhy(raw: string): string | null {
  const text = raw.trim();
  if (text.length < WHY_MIN_CHARS || text.length > WHY_MAX_CHARS) {
    return `Describe what you intend to upload in ${WHY_MIN_CHARS}-${WHY_MAX_CHARS} characters`;
  }
  return null;
}

/**
 * One entry of the backend's `missing` array, resolved to something a person
 * can click.
 *
 * `href` is null for the two entries that are not Settings fields: `why` is
 * the textarea the user is already looking at, and `email_verified` is the
 * verify step, which has its own surface. Rendering those as links to a field
 * that does not exist would be worse than rendering them as plain text.
 */
export interface UploadAccessMissingField {
  readonly field: string;
  readonly label: string;
  readonly href: string | null;
}

/** Settings anchors for every account field the request endpoint can name.
 *  Kept beside the ids the Settings markup actually carries; a rename on
 *  either side without the other shows up as a link that scrolls nowhere,
 *  which `test/account-tiers-ui.test.ts` guards. */
const MISSING_FIELD_TARGETS: Record<string, { label: string; href: string | null }> = {
  why: { label: "a description of what you intend to upload", href: null },
  email_verified: { label: "a verified email address", href: null },
  username: { label: "Username", href: "/settings#account-username" },
  given_name: { label: "Given name", href: "/settings#account-given-name" },
  family_name: { label: "Family name", href: "/settings#account-family-name" },
  github_username: { label: "GitHub handle", href: "/settings#profile-github" },
  city: { label: "City", href: "/settings#profile-city" },
  country: { label: "Country", href: "/settings#profile-country" },
};

/**
 * Resolve the backend's `missing` array into labelled, linkable fields.
 *
 * An unrecognised entry degrades to its own name with no link rather than
 * being dropped: the vocabulary is a closed union on the backend today, but
 * silently swallowing a value it grows tomorrow would tell the user their
 * request failed for no reason at all.
 */
export function uploadAccessMissingFields(missing: readonly string[]): UploadAccessMissingField[] {
  return missing.map((field) => {
    const known = MISSING_FIELD_TARGETS[field];
    return known
      ? { field, label: known.label, href: known.href }
      : { field, label: field, href: null };
  });
}

/**
 * Human copy for a refused upload-access request.
 *
 * The backend's own `message` is preferred wherever it exists: it is written
 * for a person, it names the specific fields (`profile_incomplete` lists
 * them) and the specific handle (`github_username_unverified` quotes it), and
 * re-deriving either here would drift. The map below is the fallback for a
 * transport failure or a body with no message at all.
 */
export function uploadAccessErrorMessage(
  status: number,
  code: string | undefined,
  backendMessage?: string,
): string {
  if (backendMessage && backendMessage.trim().length > 0) return backendMessage;
  switch (code) {
    case "why_required":
      return `Describe what you intend to upload in ${WHY_MIN_CHARS}-${WHY_MAX_CHARS} characters`;
    case "email_not_verified":
      return "Verify your email address first; the review happens over email.";
    case "profile_incomplete":
      return "Complete the fields below before requesting upload access.";
    case "github_username_unverified":
      return "That GitHub username doesn't exist. Upload access needs a GitHub account we can add to your dataset repository.";
    case "already_approved":
      return "This account already has upload access; there is nothing to request.";
    case "upstream_unreachable":
      return "Can't reach the account service. Try again in a moment.";
    default:
      break;
  }
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 404) return "This isn't available yet — check back soon.";
  if (status === 429) return "Too many attempts. Wait a few minutes and try again.";
  if (status >= 500) return "The server had a problem. Try again in a moment.";
  return "Couldn't send that request. Try again.";
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

/**
 * What to show after a failed `POST /auth/email/verify`, and whether the code
 * in hand is still worth retyping.
 *
 * `needsNewCode` is the load-bearing half. `code_expired` and an exhausted
 * `code_incorrect` (`attempts_remaining === 0`) both invalidate the code, so
 * leaving the input focused with a "try again" would walk the user into a
 * second guaranteed failure; the caller sends them back to the send-a-code
 * step instead. A `code_incorrect` with attempts left is the opposite — the
 * code is fine and they mistyped it.
 */
export interface VerifyEmailFailure {
  readonly message: string;
  readonly needsNewCode: boolean;
}

export function verifyEmailFailure(
  status: number,
  code: string | undefined,
  backendMessage?: string,
  attemptsRemaining?: number,
): VerifyEmailFailure {
  if (code === "code_expired") {
    return {
      message:
        backendMessage ?? "That code has expired or has already been used. Request a new one.",
      needsNewCode: true,
    };
  }
  if (code === "code_incorrect") {
    const exhausted = attemptsRemaining !== undefined && attemptsRemaining <= 0;
    return {
      message:
        backendMessage ??
        (exhausted
          ? "That code did not match and has now been invalidated. Request a new one."
          : "That code did not match. Check it and try again."),
      needsNewCode: exhausted,
    };
  }
  if (code === "verification_incomplete") {
    // The code was accepted but nothing was written and the backend put it
    // back, so the SAME code still works. Sending the user for a new one
    // would throw away a code that is fine.
    return {
      message:
        backendMessage ??
        "Your code was accepted but the change could not be saved, so nothing changed. Try the same code again.",
      needsNewCode: false,
    };
  }
  if (status === 429) {
    return { message: "Too many requests. Wait a minute and try again.", needsNewCode: false };
  }
  if (status === 401) {
    return {
      message: backendMessage ?? "That code didn't match, or it expired. Request a new one.",
      needsNewCode: true,
    };
  }
  if (status === 403) {
    return { message: "Your session expired. Sign in again.", needsNewCode: false };
  }
  if (status === 404) {
    return { message: "This isn't available yet — check back soon.", needsNewCode: false };
  }
  if (status === 503) {
    return {
      message: "We couldn't deliver the code. Try again shortly.",
      needsNewCode: false,
    };
  }
  if (status >= 500) {
    return { message: "The server had a problem. Try again in a moment.", needsNewCode: false };
  }
  return {
    message: backendMessage ?? "Couldn't verify that code. Try again.",
    needsNewCode: false,
  };
}

// ---------------------------------------------------------------------------
// Profile PATCH errors (username + name, added by nemar-cli ADR 0042)
// ---------------------------------------------------------------------------

/**
 * Human copy for a refused `PATCH /auth/profile`, covering the vocabulary
 * ADR 0042 added on top of the pre-existing one. Same preference order as
 * {@link uploadAccessErrorMessage}: the backend's sentence wins when it sent
 * one, because it is the only place that knows which handle was taken or
 * which ORCID record owns the name.
 */
export function profileErrorMessage(
  status: number,
  code: string | undefined,
  backendMessage?: string,
): string {
  if (backendMessage && backendMessage.trim().length > 0) return backendMessage;
  switch (code) {
    case "username_taken":
      return "That username is already taken.";
    case "username_locked":
      return "Your username is fixed once an admin has approved your account. Contact an admin to change it.";
    case "name_is_orcid_canonical":
      return "Your name comes from your ORCID record and is refreshed on every sign-in. Update it at orcid.org and sign in again.";
    case "username_too_short":
      return `Username must be at least ${USERNAME_MIN_LENGTH} characters`;
    case "username_too_long":
      return `Username must be at most ${USERNAME_MAX_LENGTH} characters`;
    case "username_charset":
      return "Username can only contain letters, numbers, underscores, and hyphens";
    case "given_name_required":
      return "Given name cannot be empty";
    case "family_name_required":
      return "Family name cannot be empty";
    case "city_required":
      return "City cannot be empty";
    case "country_required":
      return "Country cannot be empty";
    case "invalid_github_username":
      return "That GitHub handle looks invalid.";
    case "github_in_use":
      return "That GitHub account is already linked to another NEMAR account.";
    default:
      break;
  }
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 404 || status === 501) return "This isn't available yet — check back soon.";
  if (status === 409) return "That's already in use on another account.";
  if (status === 429) return "Too many attempts. Wait a few minutes and try again.";
  if (status >= 500) return "The server had a problem. Try again in a moment.";
  return "Something went wrong. Please try again.";
}

function isBlank(value: string | null | undefined): boolean {
  return (value ?? "").trim().length === 0;
}

function nonBlank(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
