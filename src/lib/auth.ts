import type { AstroCookieSetOptions, AstroCookies } from "astro";

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly role: "user" | "admin";
  readonly status: "active" | "pending" | "disabled";
}

export interface AuthSession {
  readonly user: AuthUser;
  readonly exp: number;
  readonly remember: boolean;
}

export const SESSION_COOKIE = "nemar_session";
export const REMEMBER_TTL_SECONDS = 30 * 86_400;
// Renewal fires only when fewer than SESSION_RENEW_WHEN_REMAINING seconds
// remain. With the defaults above that is the final ~24 h of a 30-day window,
// so dormant cookies expire and active users get rolled forward.
export const SESSION_RENEW_WHEN_REMAINING = 29 * 86_400;
export const SHORT_SESSION_SECONDS = 60 * 60 * 8;

const DEV_FALLBACK_SECRET = "phase1-dev-insecure-rotate-in-prod";
let warnedAboutDevSecret = false;

export function getSessionSecret(locals: App.Locals | undefined): string {
  const fromRuntime = locals?.runtime?.env?.SESSION_SECRET;
  if (fromRuntime) return fromRuntime;
  const fromVite = import.meta.env.SESSION_SECRET;
  if (typeof fromVite === "string" && fromVite.length > 0) return fromVite;
  if (import.meta.env.DEV) {
    if (!warnedAboutDevSecret) {
      // Only warn once per process to avoid spamming the dev log.
      console.warn(
        "[auth] SESSION_SECRET not set; using insecure dev fallback. Configure SESSION_SECRET for prod.",
      );
      warnedAboutDevSecret = true;
    }
    return DEV_FALLBACK_SECRET;
  }
  throw new Error("SESSION_SECRET is not configured");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const fullyPadded = pad === 0 ? padded : padded + "=".repeat(4 - pad);
  const binary = atob(fullyPadded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signSession(session: AuthSession, secret: string): Promise<string> {
  const payloadJson = JSON.stringify(session);
  const payload = bytesToBase64Url(new TextEncoder().encode(payloadJson));
  const key = await importHmacKey(secret, "sign");
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

export function parseSessionCookie(
  raw: string | null | undefined,
): { payload: string; signatureBytes: Uint8Array } | null {
  if (!raw || typeof raw !== "string") return null;
  const dot = raw.indexOf(".");
  if (dot < 1 || dot >= raw.length - 1) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  try {
    return { payload, signatureBytes: base64UrlToBytes(sig) };
  } catch {
    return null;
  }
}

export async function verifySession(
  token: string | null | undefined,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<AuthSession | null> {
  const parts = parseSessionCookie(token);
  if (!parts) return null;
  let key: CryptoKey;
  try {
    key = await importHmacKey(secret, "verify");
  } catch {
    return null;
  }
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      key,
      // The Uint8Array we built from base64url is backed by an ArrayBuffer,
      // but TS sees it as Uint8Array<ArrayBufferLike> which is too wide for
      // SubtleCrypto's BufferSource. The cast is safe here.
      parts.signatureBytes as unknown as BufferSource,
      new TextEncoder().encode(parts.payload),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  let session: unknown;
  try {
    session = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts.payload)));
  } catch {
    return null;
  }
  if (!isAuthSession(session)) return null;
  if (session.exp <= now) return null;
  return session;
}

function isAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== "object") return false;
  const u = value as Record<string, unknown>;
  if (typeof u.id !== "string" || u.id.length === 0) return false;
  if (typeof u.email !== "string" || !isValidEmail(u.email)) return false;
  if (u.role !== "user" && u.role !== "admin") return false;
  if (u.status !== "active" && u.status !== "pending" && u.status !== "disabled") return false;
  return true;
}

function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.exp !== "number") return false;
  if (typeof v.remember !== "boolean") return false;
  return isAuthUser(v.user);
}

export function sessionCookieOptions(maxAgeSeconds: number): AstroCookieSetOptions {
  return {
    httpOnly: true,
    secure: !import.meta.env.DEV,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export async function setSessionCookie(
  cookies: AstroCookies,
  session: AuthSession,
  secret: string,
): Promise<void> {
  const token = await signSession(session, secret);
  const maxAge = session.remember ? REMEMBER_TTL_SECONDS : SHORT_SESSION_SECONDS;
  cookies.set(SESSION_COOKIE, token, sessionCookieOptions(maxAge));
}

export function clearSessionCookie(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE, { path: "/" });
}

export function getSession(locals: App.Locals | undefined): AuthSession | null {
  return locals?.session ?? null;
}

export function safeRedirectPath(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return "/";
  if (raw.includes("\\") || raw.includes("\n") || raw.includes("\r")) return "/";
  // URL-encoded bypass guard: decode once so "/%2F%2Fevil.com" is checked as
  // "//evil.com" rather than passed through as a same-origin-looking string.
  // decodeURIComponent can throw on malformed sequences; treat those as unsafe.
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
  // Pragmatic email check: must contain a single @, with at least one char each side and a dot in the domain.
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  const at = trimmed.indexOf("@");
  if (at < 1 || at !== trimmed.lastIndexOf("@") || at === trimmed.length - 1) return false;
  const domain = trimmed.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

export async function mockUserIdFromEmail(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(email.toLowerCase()));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `mock-${hex.slice(0, 12)}`;
}
