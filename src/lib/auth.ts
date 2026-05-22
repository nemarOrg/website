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

export function isValidEmail(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  const at = trimmed.indexOf("@");
  if (at < 1 || at !== trimmed.lastIndexOf("@") || at === trimmed.length - 1) return false;
  const domain = trimmed.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}
