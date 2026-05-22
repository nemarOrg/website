import { describe, expect, it } from "vitest";
import {
  type AuthSession,
  REMEMBER_TTL_SECONDS,
  SESSION_COOKIE,
  SHORT_SESSION_SECONDS,
  isValidEmail,
  maskEmail,
  parseSessionCookie,
  safeRedirectPath,
  sessionCookieOptions,
  signSession,
  verifySession,
} from "./auth";

const SECRET = "test-secret-vitest";

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    user: {
      id: "mock-abc123",
      email: "u@example.com",
      role: "user",
      status: "active",
    },
    exp: Math.floor(Date.now() / 1000) + 3600,
    remember: false,
    ...overrides,
  };
}

describe("signSession + verifySession", () => {
  it("round-trips a valid session", async () => {
    const session = makeSession();
    const token = await signSession(session, SECRET);
    const verified = await verifySession(token, SECRET);
    expect(verified).toEqual(session);
  });

  it("returns null when the signature is tampered", async () => {
    const token = await signSession(makeSession(), SECRET);
    const [payload, sig] = token.split(".");
    // Avoid flipping the last char: if the HMAC length is not a multiple of 3
    // bytes, the final base64url char encodes only padding bits and flipping
    // it leaves the decoded byte sequence unchanged, producing a false-negative test.
    const flipped = `${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`;
    expect(await verifySession(`${payload}.${flipped}`, SECRET)).toBeNull();
  });

  it("returns null when the payload is tampered", async () => {
    const session = makeSession();
    const token = await signSession(session, SECRET);
    const [payload, sig] = token.split(".");
    const swapped = payload.startsWith("A") ? `B${payload.slice(1)}` : `A${payload.slice(1)}`;
    expect(await verifySession(`${swapped}.${sig}`, SECRET)).toBeNull();
  });

  it("returns null when the signing secret differs", async () => {
    const token = await signSession(makeSession(), SECRET);
    expect(await verifySession(token, "different-secret")).toBeNull();
  });

  it("returns null when the session has expired", async () => {
    const session = makeSession({ exp: Math.floor(Date.now() / 1000) - 1 });
    const token = await signSession(session, SECRET);
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("treats exp equal to now as expired (boundary)", async () => {
    const now = 1_700_000_000;
    const session = makeSession({ exp: now });
    const token = await signSession(session, SECRET);
    expect(await verifySession(token, SECRET, now)).toBeNull();
  });

  it("rejects a payload that does not match the AuthSession shape", async () => {
    // Construct a token with a valid HMAC over a payload missing required fields
    // so we exercise the isAuthSession guard, not the signature path.
    const payloadJson = JSON.stringify({ foo: "bar" });
    const payload = btoa(payloadJson).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBytes = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
    );
    let binary = "";
    for (const b of sigBytes) binary += String.fromCharCode(b);
    const sig = btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const token = `${payload}.${sig}`;
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("rejects a session with an empty user id", async () => {
    const session = makeSession({
      user: { id: "", email: "u@example.com", role: "user", status: "active" },
    });
    const token = await signSession(session, SECRET);
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("rejects a session with a syntactically invalid email", async () => {
    const session = makeSession({
      user: { id: "x", email: "not-an-email", role: "user", status: "active" },
    });
    const token = await signSession(session, SECRET);
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("accepts disabled status (forward-compat with the upstream user state)", async () => {
    const session = makeSession({
      user: { id: "u1", email: "u@example.com", role: "user", status: "disabled" },
    });
    const token = await signSession(session, SECRET);
    const verified = await verifySession(token, SECRET);
    expect(verified?.user.status).toBe("disabled");
  });
});

describe("parseSessionCookie", () => {
  it("returns null for nullish, empty, or malformed inputs", () => {
    expect(parseSessionCookie(null)).toBeNull();
    expect(parseSessionCookie(undefined)).toBeNull();
    expect(parseSessionCookie("")).toBeNull();
    expect(parseSessionCookie("nodot")).toBeNull();
    expect(parseSessionCookie(".onlysuffix")).toBeNull();
    expect(parseSessionCookie("onlyprefix.")).toBeNull();
  });
  it("returns null when the signature is not valid base64url", () => {
    expect(parseSessionCookie("payload.!!!notbase64!!!")).toBeNull();
  });
});

describe("safeRedirectPath", () => {
  it("accepts same-origin paths", () => {
    expect(safeRedirectPath("/")).toBe("/");
    expect(safeRedirectPath("/discover")).toBe("/discover");
    expect(safeRedirectPath("/dataset/ds002718")).toBe("/dataset/ds002718");
    expect(safeRedirectPath("/discover?modality=eeg")).toBe("/discover?modality=eeg");
  });
  it("falls back to / for off-origin or scheme-relative URLs", () => {
    expect(safeRedirectPath("//evil.com")).toBe("/");
    expect(safeRedirectPath("//evil.com/path")).toBe("/");
    expect(safeRedirectPath("https://evil.com")).toBe("/");
    expect(safeRedirectPath("http://example.com")).toBe("/");
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/");
  });
  it("decodes URL-encoded sequences before checking origin", () => {
    expect(safeRedirectPath("/%2F%2Fevil.com")).toBe("/");
    expect(safeRedirectPath("/%2f%2fevil.com")).toBe("/");
    expect(safeRedirectPath("%2F%2Fevil.com")).toBe("/");
  });
  it("falls back to / for nullish, empty, or non-string inputs", () => {
    expect(safeRedirectPath(null)).toBe("/");
    expect(safeRedirectPath(undefined)).toBe("/");
    expect(safeRedirectPath("")).toBe("/");
  });
  it("rejects control characters and backslashes", () => {
    expect(safeRedirectPath("/foo\\bar")).toBe("/");
    expect(safeRedirectPath("/foo\nbar")).toBe("/");
    expect(safeRedirectPath("/foo\rbar")).toBe("/");
  });
  it("treats malformed percent-encoding as unsafe", () => {
    expect(safeRedirectPath("/%E0%A4%A")).toBe("/");
  });
});

describe("sessionCookieOptions", () => {
  it("always sets httpOnly, sameSite=lax, and path=/", () => {
    const opts = sessionCookieOptions(SHORT_SESSION_SECONDS);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
  });
  it("passes maxAge through verbatim", () => {
    expect(sessionCookieOptions(SHORT_SESSION_SECONDS).maxAge).toBe(SHORT_SESSION_SECONDS);
    expect(sessionCookieOptions(REMEMBER_TTL_SECONDS).maxAge).toBe(REMEMBER_TTL_SECONDS);
  });
  it("uses the same cookie name across the codebase", () => {
    expect(SESSION_COOKIE).toBe("nemar_session");
  });
});

describe("maskEmail", () => {
  it("masks the local part keeping the first character and the domain", () => {
    expect(maskEmail("yahya@ieee.org")).toBe("y****@ieee.org");
    expect(maskEmail("a@b.co")).toBe("a***@b.co");
    expect(maskEmail("seyed@anthropic.com")).toBe("s****@anthropic.com");
  });
  it("caps the asterisk run at 5 for long locals", () => {
    expect(maskEmail("aaaaaaaaaaaaaa@x.io")).toBe("a*****@x.io");
  });
  it("returns the input unchanged when there is no @ or @ is at index 0", () => {
    expect(maskEmail("notanemail")).toBe("notanemail");
    expect(maskEmail("@nolocal")).toBe("@nolocal");
    expect(maskEmail("")).toBe("");
  });
});

describe("isValidEmail", () => {
  it("accepts typical addresses", () => {
    expect(isValidEmail("u@example.com")).toBe(true);
    expect(isValidEmail("first.last+tag@sub.example.co")).toBe(true);
  });
  it("rejects malformed addresses", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("noatsign")).toBe(false);
    expect(isValidEmail("@nolocal.com")).toBe(false);
    expect(isValidEmail("u@no-dot-domain")).toBe(false);
    expect(isValidEmail("two@@signs.com")).toBe(false);
    expect(isValidEmail("u@.startdot.com")).toBe(false);
    expect(isValidEmail("u@enddot.")).toBe(false);
  });
});
