import { describe, expect, it, vi } from "vitest";
import type { AuthSession } from "./auth";
import {
  type Collaborator,
  inviteCollaborator,
  isCollaboratorManager,
  listCollaborators,
} from "./collaborators-api";
import type { Dataset } from "./types";

function session(role: AuthSession["user"]["role"], email = "alice@example.com"): AuthSession {
  return {
    user: { id: "u1", email, role, status: "active" },
    exp: Math.floor(Date.now() / 1000) + 3600,
    remember: false,
  };
}

function ds(owner: string | null = "alice"): Pick<Dataset, "owner_username"> {
  return { owner_username: owner };
}

function collab(username: string): Collaborator {
  return {
    username,
    github_username: username,
    access_type: "invited",
    granted_at: "2026-05-22T00:00:00Z",
    granted_by_username: "alice",
  };
}

describe("isCollaboratorManager", () => {
  it("true when the caller is the dataset owner", () => {
    expect(isCollaboratorManager(session("user"), ds("alice"))).toBe(true);
  });
  it("true when the caller is an admin (even if not the owner)", () => {
    expect(isCollaboratorManager(session("admin", "boss@example.com"), ds("alice"))).toBe(true);
  });
  it("false when the caller is a regular user who is not the owner", () => {
    expect(isCollaboratorManager(session("user", "bob@example.com"), ds("alice"))).toBe(false);
  });
  it("false when there is no session at all", () => {
    expect(isCollaboratorManager(null, ds("alice"))).toBe(false);
  });
  it("false when the dataset has no recorded owner_username", () => {
    expect(isCollaboratorManager(session("user"), ds(null))).toBe(false);
  });
});

describe("listCollaborators", () => {
  it("hits /api/datasets/:id/collaborators with credentials", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/datasets/nm-xyz/collaborators");
      expect(init.method).toBe("GET");
      expect(init.credentials).toBe("include");
      return new Response(
        JSON.stringify({ dataset_id: "nm-xyz", collaborators: [collab("bob")], count: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await listCollaborators("nm-xyz", { fetch: fakeFetch });
    expect(out.count).toBe(1);
    expect(out.collaborators[0].username).toBe("bob");
  });

  it("forwards the cookie header for SSR callers", async () => {
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers.Cookie).toBe("nemar_session=abc.def");
      return new Response(JSON.stringify({ dataset_id: "nm-xyz", collaborators: [], count: 0 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await listCollaborators("nm-xyz", { fetch: fakeFetch, cookieHeader: "nemar_session=abc.def" });
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("propagates forbidden on 403", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    await expect(listCollaborators("nm-xyz", { fetch: fakeFetch })).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 403,
      code: "forbidden",
    });
  });
});

describe("inviteCollaborator", () => {
  it("POSTs to /api/datasets/:id/collaborators with the username body", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/datasets/nm-xyz/collaborators");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      expect(init.body).toBe(JSON.stringify({ username: "bob" }));
      return new Response(JSON.stringify({ message: "ok", dataset_id: "nm-xyz", invitee: "bob" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const out = await inviteCollaborator("nm-xyz", "bob", { fetch: fakeFetch });
    expect(out.invitee).toBe("bob");
  });

  it("propagates not_invitable on 409 (duplicate)", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "not_invitable", message: "Already a collaborator" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    await expect(inviteCollaborator("nm-xyz", "bob", { fetch: fakeFetch })).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 409,
      code: "not_invitable",
    });
  });

  it("encodes the dataset id and uses the body verbatim", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/datasets/nm%2Fweird/collaborators");
      expect(init.body).toBe(JSON.stringify({ username: "carol" }));
      return new Response(
        JSON.stringify({ message: "ok", dataset_id: "nm/weird", invitee: "carol" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await inviteCollaborator("nm/weird", "carol", { fetch: fakeFetch });
    expect(fakeFetch).toHaveBeenCalledOnce();
  });
});
