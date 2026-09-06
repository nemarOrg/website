/**
 * Auth types + pure helpers. The cookie lifecycle (issue, sign, verify) is
 * owned by the backend at `api.nemar.org`; the website reads
 * `${apiBase}/auth/me` to resolve the current user from a request's cookie.
 */

// Type-only, so this stays a leaf module at runtime: `profile-gaps.ts`
// describes its own account shape structurally rather than importing
// `AuthUser`, and nothing here imports it back.
import type { WireProfileGap } from "./profile-gaps";

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly role: "user" | "admin";
  /**
   * Two-state, and both states mean something the page can act on since
   * nemar-cli ADR 0040: the backend maps `verified` AND `approved` to
   * `"active"`, so `"pending"` now means exactly one thing — the email
   * address has not been confirmed, and confirming it is the only thing
   * this account can do. What it does NOT say is whether the account may
   * upload; that is {@link AuthUser.service_access}, reported separately.
   */
  readonly status: "active" | "pending" | "disabled";
  // Uncollapsed backend role (owner > admin > member), alongside the
  // website's collapsed `role` above. `parseAuthMeResponse` in
  // `src/middleware.ts` maps backend "owner"/"admin" -> website "admin" for
  // the existing admin gate; later admin-portal phases need to tell an
  // owner from an admin for owner-only actions (role change, delete user,
  // rollback of public/DOI datasets), so this carries the raw value too.
  readonly backend_role?: "owner" | "admin" | "member";
  // ---- Optional profile fields (backend may not populate them yet) ----
  /**
   * Login handle. **Not on `/auth/me` as of nemar-cli epic #1250 phase 3** —
   * `publicUser` in `backend/src/routes/auth-web.ts` does not select it. It
   * is parsed here anyway so the field lands for free if the backend adds it,
   * and `fetchAccountIdentity` in `./account-api.ts` reads it from
   * `GET /users/me` (which does carry it) in the meantime. `undefined` is
   * therefore "not known from this source", never "the account has none".
   */
  readonly username?: string;
  /**
   * Whether the emailed 6-digit code has been redeemed (nemar-cli ADR 0040
   * phase 2). Boolean-only like `service_access`; absent from an older
   * backend, where `undefined` means "unknown", never "no".
   */
  readonly email_verified?: boolean;
  // Name is canonical from ORCID (given/family backfilled on every login,
  // nemar-cli#836) and editable here only when no verified iD is linked
  // (nemar-cli ADR 0042; PATCH /auth/profile 409s `name_is_orcid_canonical`
  // otherwise).
  readonly given_name?: string;
  readonly family_name?: string;
  // Linked ORCID iD (bare `0000-0000-0000-0000`, no URL) + verified flag.
  readonly orcid?: string;
  readonly orcid_verified?: boolean;
  // Self-service profile fields (migrations 0051/0052). city/country are
  // required for export-control screening; the rest are optional.
  readonly github_username?: string;
  readonly city?: string;
  readonly country?: string;
  readonly affiliation?: string;
  // Tiered access (ADR 0010): true once an admin has granted the
  // upload/compute tier. The backend enforces it on every real upload
  // (nemar-cli backend/src/services/upload-gate.ts); the website reads it
  // only to choose UI posture (#236: soften the profile gate for users who
  // are already authorized to upload). Absent when the backend predates the
  // field — treat undefined as "not granted", never as "granted".
  readonly service_access?: boolean;
  /**
   * When an admin granted upload access, and when the account asked for it
   * (nemar-cli ADR 0042, migration 0076). **Neither is on `/auth/me` as of
   * epic #1250 phase 3** — both are on `GET /admin/users` rows only — so
   * Settings renders the undated form of each state until they appear, and
   * the request endpoint's own `requested_at` fills the second one in for
   * the session that just asked. Parsed here so they land for free if the
   * backend adds them.
   */
  readonly service_access_granted_at?: string;
  readonly upload_access_requested_at?: string;
  /**
   * The server-computed profile-gap list (nemar-cli#1268, epic #1250 phase
   * 8): one entry per field the account is still missing, with what it blocks
   * and where it is set. **Not on `/auth/me` yet** — `./profile-gaps.ts`
   * derives the identical list from the fields above until it is, and uses
   * this verbatim the day it appears.
   *
   * An empty ARRAY is a real answer ("nothing is missing"); `undefined` means
   * the backend does not compute it yet. The two must not be collapsed, which
   * is why this is optional rather than defaulted to `[]`.
   */
  readonly profile_gaps?: readonly WireProfileGap[];
  /**
   * True when the backend picked this account's username for it rather than
   * the user choosing one (nemar-cli#1268: an account whose username is NULL
   * gets one assigned from its name at the next successful sign-in, so it
   * cannot stay NULL if onboarding is abandoned). `/onboarding` offers the
   * one-time change when it is set. Absent means false — an account that
   * chose its own handle, or a backend that predates the assignment.
   */
  readonly username_auto_assigned?: boolean;
}

/**
 * Session shape served by `${apiBase}/auth/me`. The wrapping `user` object
 * mirrors the backend response so we can pass the parsed body through
 * without restructuring. No `exp` / `remember` — those are cookie-internal
 * concerns the backend owns.
 */
export interface AuthSession {
  readonly user: AuthUser;
}

export const SESSION_COOKIE_NAME = "nemar_session";

export function getSession(locals: App.Locals | undefined): AuthSession | null {
  return locals?.session ?? null;
}

export function safeRedirectPath(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return "/";
  if (raw.includes("\\") || raw.includes("\n") || raw.includes("\r")) return "/";
  // URL-encoded bypass guard: decode once so "/%2F%2Fevil.com" is checked as
  // "//evil.com" rather than passed through as a same-origin-looking string.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "/";
  }
  if (!decoded.startsWith("/")) return "/";
  if (decoded.startsWith("//")) return "/";
  if (decoded.includes("\\") || decoded.includes("\n") || decoded.includes("\r")) return "/";
  return raw;
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length <= 1) return `${local}***@${domain}`;
  return `${local[0]}${"*".repeat(Math.min(local.length - 1, 5))}@${domain}`;
}

/**
 * GitHub username rules: 1–39 chars, alphanumeric or single hyphens, may not
 * start or end with a hyphen and may not contain consecutive hyphens. Used to
 * validate the handle before it's sent to the profile endpoint (required to
 * publish a dataset). A leading `@` is tolerated and stripped by the caller.
 */
export function isValidGithubUsername(value: string): boolean {
  if (typeof value !== "string") return false;
  const handle = value.trim().replace(/^@/, "");
  return /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/.test(handle);
}

/**
 * ORCID iD structural check: four hyphen-separated 4-digit groups, last group
 * ending in a digit or `X` checksum. Accepts a bare iD; the caller strips any
 * `https://orcid.org/` prefix first. Not a checksum validation — that's the
 * backend's job — just enough to avoid rendering a broken orcid.org link.
 */
export function isValidOrcid(value: string): boolean {
  if (typeof value !== "string") return false;
  return /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(value.trim());
}

/**
 * Compose the display name from ORCID-canonical parts. Returns "" when both
 * are absent so callers can null-check and fall back (Astro drops cards whose
 * render throws — never assume a name exists).
 */
export function fullName(user: {
  given_name?: string;
  family_name?: string;
}): string {
  return [user.given_name, user.family_name]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(" ");
}

export function isValidEmail(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  const at = trimmed.indexOf("@");
  if (at < 1 || at !== trimmed.lastIndexOf("@") || at === trimmed.length - 1) return false;
  const domain = trimmed.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}
