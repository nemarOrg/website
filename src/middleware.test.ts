import { describe, expect, it } from "vitest";
import { isPublicCacheable, parseAuthMeResponse } from "./middleware";

describe("isPublicCacheable", () => {
  const r = (cc: string | null) =>
    new Response(null, { status: 200, headers: cc ? { "Cache-Control": cc } : {} });

  it("returns false when Cache-Control is missing", () => {
    expect(isPublicCacheable(r(null))).toBe(false);
  });

  it("returns false for private responses", () => {
    expect(isPublicCacheable(r("private, max-age=600"))).toBe(false);
  });

  it("returns false for no-store", () => {
    expect(isPublicCacheable(r("public, no-store, max-age=600"))).toBe(false);
  });

  it("returns false for public without a max-age / s-maxage", () => {
    expect(isPublicCacheable(r("public"))).toBe(false);
  });

  it("returns true for public + max-age", () => {
    expect(isPublicCacheable(r("public, max-age=600"))).toBe(true);
  });

  it("returns true for public + s-maxage", () => {
    expect(isPublicCacheable(r("public, s-maxage=600"))).toBe(true);
  });
});

describe("parseAuthMeResponse", () => {
  it("returns a valid session for a well-formed /auth/me body", () => {
    const out = parseAuthMeResponse({
      user: { id: "u_1", email: "alice@example.com", role: "user", status: "active" },
    });
    expect(out).toEqual({
      user: { id: "u_1", email: "alice@example.com", role: "user", status: "active" },
    });
  });

  it("returns null for null / non-object input", () => {
    expect(parseAuthMeResponse(null)).toBeNull();
    expect(parseAuthMeResponse(undefined)).toBeNull();
    expect(parseAuthMeResponse("string")).toBeNull();
    expect(parseAuthMeResponse(42)).toBeNull();
  });

  it("returns null when `user` is missing or null", () => {
    expect(parseAuthMeResponse({})).toBeNull();
    expect(parseAuthMeResponse({ user: null })).toBeNull();
    expect(parseAuthMeResponse({ user: "not-an-object" })).toBeNull();
  });

  it("returns null when `id` is empty or non-string", () => {
    expect(
      parseAuthMeResponse({
        user: { id: "", email: "a@b.com", role: "user", status: "active" },
      }),
    ).toBeNull();
    expect(
      parseAuthMeResponse({
        user: { id: 42, email: "a@b.com", role: "user", status: "active" },
      }),
    ).toBeNull();
  });

  it("returns null for unknown role values", () => {
    expect(
      parseAuthMeResponse({
        user: { id: "u", email: "a@b.com", role: "superuser", status: "active" },
      }),
    ).toBeNull();
  });

  it("returns null for unknown status values", () => {
    expect(
      parseAuthMeResponse({
        user: { id: "u", email: "a@b.com", role: "user", status: "deleted" },
      }),
    ).toBeNull();
  });

  it("accepts admin role and pending status", () => {
    const out = parseAuthMeResponse({
      user: { id: "u", email: "boss@example.com", role: "admin", status: "pending" },
    });
    expect(out?.user.role).toBe("admin");
    expect(out?.user.status).toBe("pending");
  });

  it("strips any extra fields the backend might send", () => {
    const out = parseAuthMeResponse({
      user: {
        id: "u",
        email: "a@b.com",
        role: "user",
        status: "active",
        secret_password: "hunter2",
        admin: true,
      },
    });
    expect(out?.user).toEqual({
      id: "u",
      email: "a@b.com",
      role: "user",
      status: "active",
    });
    expect((out?.user as { admin?: unknown }).admin).toBeUndefined();
  });
});
