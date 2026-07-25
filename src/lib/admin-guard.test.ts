import { describe, expect, it } from "vitest";
import { adminGate } from "./admin-guard";
import type { AuthSession } from "./auth";

function mkSession(role: "user" | "admin"): AuthSession {
  return {
    user: { id: "u_1", email: "person@example.com", role, status: "active" },
  };
}

describe("adminGate", () => {
  it("redirects to login with an encoded next when there is no session", () => {
    expect(adminGate(null, "/admin")).toBe("/login?next=%2Fadmin");
  });

  it("percent-encodes a nested admin path", () => {
    expect(adminGate(null, "/admin/publication-requests")).toBe(
      "/login?next=%2Fadmin%2Fpublication-requests",
    );
  });

  // Defensive only: call sites pass `Astro.url.pathname`, which never carries a
  // query string (that's `Astro.url.search`). This pins the encoding so a future
  // caller passing something richer can't break out of the `next` param.
  it("percent-encodes characters that would otherwise break out of next", () => {
    expect(adminGate(null, "/admin/x?status=requested&a=b")).toBe(
      "/login?next=%2Fadmin%2Fx%3Fstatus%3Drequested%26a%3Db",
    );
  });

  it("returns /404 for a signed-in non-admin", () => {
    expect(adminGate(mkSession("user"), "/admin")).toBe("/404");
  });

  it("returns null for a signed-in admin", () => {
    expect(adminGate(mkSession("admin"), "/admin")).toBeNull();
  });
});
