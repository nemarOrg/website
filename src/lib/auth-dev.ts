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
 * Three personas, all selected by email domain so no config is needed:
 * - `@nemar.admin` (or `NEMAR_DEV_ADMIN_EMAIL`) gets `role: "admin"`, so the
 *   admin surfaces are exercisable in dev.
 * - `@nemar.blank` gets an empty profile WITH service access, so the
 *   profile-completeness nudge (#226) and the softened /upload warning
 *   banner (#236) are exercisable. This mirrors the real grandfathered
 *   population: every production service-access account predates the
 *   profile columns.
 * - `@nemar.base` gets an empty profile WITHOUT service access — the base
 *   tier, so `/upload`'s "request upload access" landing and the dashboard's
 *   tier card stay reachable locally.
 * - `@nemar.pending` is `status: "pending"`: the unverified tier, so the
 *   verify-your-email step on `/dashboard` and `/upload` can be exercised
 *   (the dev proxies at `/api/auth/email/verify*` accept `123456` and
 *   re-issue the session at `"active"`).
 * - `@nemar.asked` is the base tier with an open upload-access request, so
 *   the "waiting on an admin" states render without a backend.
 * - `@nemar.new` has no username and no name, so `/onboarding` renders every
 *   step. It is deliberately NOT ORCID-verified: with a verified iD the name
 *   step is skipped by design (nemar-cli ADR 0042).
 */
export function buildDevUser(email: string): AuthUser {
  const lower = email.trim().toLowerCase();
  const adminOverride = (import.meta.env.NEMAR_DEV_ADMIN_EMAIL ?? "")
    .toString()
    .trim()
    .toLowerCase();
  const isAdmin =
    lower.endsWith("@nemar.admin") || (adminOverride.length > 0 && lower === adminOverride);
  const unverified = lower.endsWith("@nemar.pending");
  const asked = lower.endsWith("@nemar.asked");
  const fresh = lower.endsWith("@nemar.new");
  const baseTier = lower.endsWith("@nemar.base") || unverified || asked || fresh;
  const blankProfile = lower.endsWith("@nemar.blank") || baseTier;
  return {
    id: `dev-${lower.replace(/[^a-z0-9]/g, "_")}`,
    email: lower,
    role: isAdmin ? "admin" : "user",
    status: unverified ? "pending" : "active",
    // Every road out of `pending` sets this (nemar-cli ADR 0040 phase 2), so
    // the two move together here as well.
    email_verified: !unverified,
    // NULL on a real ORCID/web signup until onboarding fills it in. Empty
    // string rather than omitted so the local session still ANSWERS the
    // question — an omitted key sends `fetchAccountIdentity` to `/users/me`,
    // which no dev session can reach.
    username: fresh ? "" : "alovelace",
    // Sample ORCID-canonical + profile fields so the Settings surface renders
    // its populated states locally without a real backend. Production reads
    // these from /auth/me instead; this block is dev-only (gated on DEV).
    // `@nemar.new` has neither a name nor a verified iD, which is the only
    // combination in which onboarding may ask for one.
    given_name: fresh ? "" : "Ada",
    family_name: fresh ? "" : "Lovelace",
    orcid: fresh ? "" : "0000-0002-1825-0097",
    orcid_verified: !fresh,
    // The self-service fields, blank for the incomplete-profile persona.
    // Empty string rather than undefined mirrors what the backend returns
    // for a column that exists but was never filled in.
    github_username: blankProfile ? "" : "ada",
    city: blankProfile ? "" : "London",
    country: blankProfile ? "" : "United Kingdom",
    affiliation: blankProfile ? "" : "Analytical Engine Lab",
    // Tiered access (ADR 0010): granted for every persona except the
    // base-tier ones, whose whole purpose is exercising the ungranted states.
    service_access: !baseTier,
    // An open upload-access request (nemar-cli ADR 0042). Only `@nemar.asked`
    // has one; every other base-tier persona sits at "not requested" so the
    // request CTA is the state that renders.
    ...(asked ? { upload_access_requested_at: "2026-09-01 10:00:00" } : {}),
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
