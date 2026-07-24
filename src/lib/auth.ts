/**
 * Auth types + pure helpers. The cookie lifecycle (issue, sign, verify) is
 * owned by the backend at `api.nemar.org`; the website reads
 * `${apiBase}/auth/me` to resolve the current user from a request's cookie.
 */

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly role: "user" | "admin";
  readonly status: "active" | "pending" | "disabled";
  // Uncollapsed backend role (owner > admin > member), alongside the
  // website's collapsed `role` above. `parseAuthMeResponse` in
  // `src/middleware.ts` maps backend "owner"/"admin" -> website "admin" for
  // the existing admin gate; later admin-portal phases need to tell an
  // owner from an admin for owner-only actions (role change, delete user,
  // rollback of public/DOI datasets), so this carries the raw value too.
  readonly backend_role?: "owner" | "admin" | "member";
  // ---- Optional profile fields (backend may not populate them yet) ----
  // Name is canonical from ORCID (given/family backfilled on every login,
  // nemar-cli#836); the website never lets the user edit it here.
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
