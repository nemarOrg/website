/**
 * Dev-mode local session helpers. Only consumed by code paths gated on
 * `import.meta.env.DEV`. The signing key is hardcoded (insecure by design);
 * production never reads this file's exports.
 *
 * Why it exists: production login goes to api.nemar.org and the backend
 * issues the session cookie. A developer without a NEMAR account can't
 * exercise the dashboard / upload / admin surfaces locally. This module
 * lets the dev login route accept a demo code and issue a locally-signed
 * cookie; the middleware verifies it without a network hop.
 */

import type { AuthSession, AuthUser } from "./auth";

const DEV_SECRET = "nemar-dev-insecure-key-do-not-use-in-prod";
const DEV_SESSION_TTL_SECONDS = 7 * 86_400;

export const DEV_ACCEPTED_CODE = "123456";

interface DevPayload {
  readonly user: AuthUser;
  /** Unix seconds. */
  readonly exp: number;
}

async function importKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(DEV_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const str = atob(padded);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

async function hmacSign(payloadB64: string): Promise<string> {
  const key = await importKey();
  const sig = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64) as unknown as BufferSource,
  );
  return bytesToBase64Url(new Uint8Array(sig));
}

async function hmacVerify(payloadB64: string, sigB64: string): Promise<boolean> {
  const key = await importKey();
  const sigBytes = base64UrlToBytes(sigB64);
  return globalThis.crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes as unknown as BufferSource,
    new TextEncoder().encode(payloadB64) as unknown as BufferSource,
  );
}

export async function signDevSession(user: AuthUser): Promise<string> {
  const payload: DevPayload = {
    user,
    exp: Math.floor(Date.now() / 1000) + DEV_SESSION_TTL_SECONDS,
  };
  const payloadB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(payloadB64);
  return `${payloadB64}.${sig}`;
}

export async function verifyDevSession(token: string): Promise<AuthSession | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const ok = await hmacVerify(payloadB64, sigB64);
    if (!ok) return null;
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payloadB64)),
    ) as DevPayload;
    if (typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    if (!payload.user || typeof payload.user.email !== "string") return null;
    return { user: payload.user };
  } catch {
    return null;
  }
}

/**
 * Build the AuthUser shape the dev mock issues.
 *
 * Two personas, both selected by email domain so no config is needed:
 * - `@nemar.admin` (or `NEMAR_DEV_ADMIN_EMAIL`) gets `role: "admin"`, so the
 *   admin surfaces are exercisable in dev.
 * - `@nemar.blank` gets an empty profile, so the profile-completeness nudge
 *   and the /upload city+country gate (#226) are exercisable. Without it the
 *   mock always looks complete and neither state can be reached locally.
 */
export function buildDevUser(email: string): AuthUser {
  const lower = email.trim().toLowerCase();
  const adminOverride = (import.meta.env.NEMAR_DEV_ADMIN_EMAIL ?? "")
    .toString()
    .trim()
    .toLowerCase();
  const isAdmin =
    lower.endsWith("@nemar.admin") || (adminOverride.length > 0 && lower === adminOverride);
  const blankProfile = lower.endsWith("@nemar.blank");
  return {
    id: `dev-${lower.replace(/[^a-z0-9]/g, "_")}`,
    email: lower,
    role: isAdmin ? "admin" : "user",
    status: "active",
    // Sample ORCID-canonical + profile fields so the Settings surface renders
    // its populated states locally without a real backend. Production reads
    // these from /auth/me instead; this block is dev-only (gated on DEV).
    given_name: "Ada",
    family_name: "Lovelace",
    orcid: "0000-0002-1825-0097",
    orcid_verified: true,
    // The self-service fields, blank for the incomplete-profile persona.
    // Empty string rather than undefined mirrors what the backend returns
    // for a column that exists but was never filled in.
    github_username: blankProfile ? "" : "ada",
    city: blankProfile ? "" : "London",
    country: blankProfile ? "" : "United Kingdom",
    affiliation: blankProfile ? "" : "Analytical Engine Lab",
  };
}

/**
 * Re-issue the dev session cookie after a mock mutation (email change, profile
 * edit, ORCID unlink) so the local Settings page reflects the change on the
 * next request without a real backend. Merges `patch` over the current user.
 */
export async function reissueDevSession(
  current: AuthUser,
  patch: Partial<AuthUser>,
): Promise<string> {
  const next: AuthUser = { ...current, ...patch };
  const token = await signDevSession(next);
  return devSessionCookie(token);
}

export function devSessionCookie(token: string): string {
  // HttpOnly so the dev cookie behaves like the real one (JS can't read it).
  // Secure is omitted in dev because localhost is plain http.
  return [
    `nemar_session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${DEV_SESSION_TTL_SECONDS}`,
  ].join("; ");
}

export const devClearSessionCookie = ["nemar_session=", "Path=/", "Max-Age=0"].join("; ");
