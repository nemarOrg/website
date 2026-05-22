/**
 * Dev-mode local session helpers. Only consumed by code paths gated on
 * `import.meta.env.DEV`. The signing key is hardcoded (insecure by design);
 * production never reads this file's exports.
 *
 * Why it exists: after the Phase 5 cutover, login goes to api.nemar.org and
 * the session cookie is issued by the backend. Local dev against the real
 * backend works fine if you have an account; without one, you can't sign in
 * and can't exercise the dashboard / upload / admin surfaces. This module
 * lets the dev login route accept a demo code, issue a locally-signed
 * cookie, and the middleware to verify it without a network hop.
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
 * Build the AuthUser shape the dev mock issues. Emails ending in
 * `@nemar.admin` (or matching `NEMAR_DEV_ADMIN_EMAIL` if set) get
 * `role: "admin"` so the admin surfaces are exercisable in dev.
 */
export function buildDevUser(email: string): AuthUser {
  const lower = email.trim().toLowerCase();
  const adminOverride = (import.meta.env.NEMAR_DEV_ADMIN_EMAIL ?? "")
    .toString()
    .trim()
    .toLowerCase();
  const isAdmin =
    lower.endsWith("@nemar.admin") || (adminOverride.length > 0 && lower === adminOverride);
  return {
    id: `dev-${lower.replace(/[^a-z0-9]/g, "_")}`,
    email: lower,
    role: isAdmin ? "admin" : "user",
    status: "active",
  };
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
