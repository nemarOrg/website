import { describe, expect, it } from "vitest";
import {
  LEGACY_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  fullName,
  isValidEmail,
  isValidGithubUsername,
  isValidOrcid,
  maskEmail,
  readSessionCookie,
  safeRedirectPath,
} from "./auth";

describe("safeRedirectPath", () => {
  it("returns / for null/undefined/non-string input", () => {
    expect(safeRedirectPath(null)).toBe("/");
    expect(safeRedirectPath(undefined)).toBe("/");
  });
  it("returns / for paths that don't start with /", () => {
    expect(safeRedirectPath("https://evil.com")).toBe("/");
    expect(safeRedirectPath("//evil.com")).toBe("/");
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/");
  });
  it("returns / for paths with backslash or newline", () => {
    expect(safeRedirectPath("/path\\with\\backslash")).toBe("/");
    expect(safeRedirectPath("/path\nwith\nnewline")).toBe("/");
    expect(safeRedirectPath("/path\rwith\rcr")).toBe("/");
  });
  it("guards against URL-encoded protocol-relative URLs", () => {
    expect(safeRedirectPath("/%2F%2Fevil.com")).toBe("/");
    expect(safeRedirectPath("/%5C%5Cevil.com")).toBe("/");
  });
  it("returns / for malformed URI encoding", () => {
    expect(safeRedirectPath("/%XX")).toBe("/");
  });
  it("returns the path unchanged when it's a same-origin path", () => {
    expect(safeRedirectPath("/dashboard")).toBe("/dashboard");
    expect(safeRedirectPath("/dataset/nm000103?tab=files")).toBe("/dataset/nm000103?tab=files");
  });
});

describe("isValidEmail", () => {
  it("accepts a basic well-formed address", () => {
    expect(isValidEmail("alice@example.com")).toBe(true);
  });
  it("rejects strings without @", () => {
    expect(isValidEmail("alice.example.com")).toBe(false);
  });
  it("rejects strings with multiple @", () => {
    expect(isValidEmail("alice@@example.com")).toBe(false);
    expect(isValidEmail("a@b@c.com")).toBe(false);
  });
  it("rejects strings with @ at the end", () => {
    expect(isValidEmail("alice@")).toBe(false);
  });
  it("rejects strings with @ at the start", () => {
    expect(isValidEmail("@example.com")).toBe(false);
  });
  it("rejects domains without a dot", () => {
    expect(isValidEmail("alice@localhost")).toBe(false);
  });
  it("rejects empty / very short / very long strings", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a".repeat(256))).toBe(false);
  });
  it("rejects non-string input", () => {
    // @ts-expect-error testing runtime behavior
    expect(isValidEmail(null)).toBe(false);
  });
  it("trims whitespace before validating", () => {
    expect(isValidEmail("  alice@example.com  ")).toBe(true);
  });
});

describe("maskEmail", () => {
  it("masks the local part down to first char + asterisks", () => {
    expect(maskEmail("alice@example.com")).toBe("a****@example.com");
  });
  it("caps the asterisks at 5 even for long local parts", () => {
    expect(maskEmail("alexandrina@example.com")).toBe("a*****@example.com");
  });
  it("uses ***@ for single-char local part", () => {
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
  });
  it("returns input unchanged when no @ present", () => {
    expect(maskEmail("not-an-email")).toBe("not-an-email");
  });
});

describe("isValidGithubUsername", () => {
  it("accepts plain alphanumeric handles", () => {
    expect(isValidGithubUsername("ada")).toBe(true);
    expect(isValidGithubUsername("octocat99")).toBe(true);
  });
  it("accepts single hyphens between alphanumerics", () => {
    expect(isValidGithubUsername("nemar-org")).toBe(true);
  });
  it("tolerates a leading @", () => {
    expect(isValidGithubUsername("@ada")).toBe(true);
  });
  it("rejects leading/trailing hyphens and doubled hyphens", () => {
    expect(isValidGithubUsername("-ada")).toBe(false);
    expect(isValidGithubUsername("ada-")).toBe(false);
    expect(isValidGithubUsername("a--b")).toBe(false);
  });
  it("rejects empty, over-length, and invalid chars", () => {
    expect(isValidGithubUsername("")).toBe(false);
    expect(isValidGithubUsername("a".repeat(40))).toBe(false);
    expect(isValidGithubUsername("ada lovelace")).toBe(false);
    expect(isValidGithubUsername("ada_lovelace")).toBe(false);
  });
});

describe("isValidOrcid", () => {
  it("accepts a well-formed iD", () => {
    expect(isValidOrcid("0000-0002-1825-0097")).toBe(true);
  });
  it("accepts a trailing X checksum", () => {
    expect(isValidOrcid("0000-0002-1694-233X")).toBe(true);
  });
  it("rejects malformed iDs and URLs", () => {
    expect(isValidOrcid("0000-0002-1825")).toBe(false);
    expect(isValidOrcid("https://orcid.org/0000-0002-1825-0097")).toBe(false);
    expect(isValidOrcid("")).toBe(false);
    // @ts-expect-error runtime behavior
    expect(isValidOrcid(null)).toBe(false);
  });
});

describe("fullName", () => {
  it("joins given + family", () => {
    expect(fullName({ given_name: "Ada", family_name: "Lovelace" })).toBe("Ada Lovelace");
  });
  it("returns the present part when one is missing", () => {
    expect(fullName({ given_name: "Ada" })).toBe("Ada");
    expect(fullName({ family_name: "Lovelace" })).toBe("Lovelace");
  });
  it("returns empty string when both absent or blank", () => {
    expect(fullName({})).toBe("");
    expect(fullName({ given_name: "  ", family_name: "" })).toBe("");
  });
});

describe("the session cookie's name (nemar-cli ADR 0119)", () => {
  // Literals on purpose: a test that imported the constant would agree with whatever it said.
  it("is __Host-nemar_session, with nemar_session as the legacy name", () => {
    expect(SESSION_COOKIE_NAME).toBe("__Host-nemar_session");
    expect(LEGACY_SESSION_COOKIE_NAME).toBe("nemar_session");
  });

  /** The shape of Astro's `cookies`: `get` returns an object with a `value`, or undefined. */
  const jar = (values: Record<string, string>) => ({
    get: (name: string) => (name in values ? { value: values[name] } : undefined),
  });

  it("reads the new name", () => {
    expect(readSessionCookie(jar({ "__Host-nemar_session": "new" }))).toEqual({
      name: "__Host-nemar_session",
      value: "new",
    });
  });

  it("falls back to the legacy name only when the new one is absent", () => {
    expect(readSessionCookie(jar({ nemar_session: "old" }))).toEqual({
      name: "nemar_session",
      value: "old",
    });
  });

  it("prefers the new name when both are present", () => {
    expect(readSessionCookie(jar({ nemar_session: "old", "__Host-nemar_session": "new" }))).toEqual(
      { name: "__Host-nemar_session", value: "new" },
    );
  });

  it("does not rescue an empty new cookie with a legacy one (the API's rule)", () => {
    // The API treats a present-but-empty new cookie as no session; a site that fell back to the
    // legacy cookie here would show a signed-in page the API had already refused.
    expect(readSessionCookie(jar({ "__Host-nemar_session": "", nemar_session: "old" }))).toEqual({
      name: "__Host-nemar_session",
      value: "",
    });
  });

  it("is null when neither is present, and ignores every other cookie", () => {
    expect(readSessionCookie(jar({}))).toBeNull();
    expect(readSessionCookie(jar({ analytics: "reject" }))).toBeNull();
  });
});
