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

  it("encodes query params in the next path", () => {
    expect(adminGate(null, "/admin/publication-requests?status=requested")).toBe(
      "/login?next=%2Fadmin%2Fpublication-requests%3Fstatus%3Drequested",
    );
  });

  it("returns /404 for a signed-in non-admin", () => {
    expect(adminGate(mkSession("user"), "/admin")).toBe("/404");
  });

  it("returns null for a signed-in admin", () => {
    expect(adminGate(mkSession("admin"), "/admin")).toBeNull();
  });
});
