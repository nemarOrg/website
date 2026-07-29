import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "./auth";
import {
  COLLABORATOR_TIMEOUTS_MS,
  type Collaborator,
  inviteCollaborator,
  isCollaboratorManager,
  listCollaborators,
} from "./collaborators-api";
import type { Dataset } from "./types";

function session(role: AuthSession["user"]["role"], email = "alice@example.com"): AuthSession {
  return { user: { id: "u1", email, role, status: "active" } };
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
  it("false when the email local part doesn't match owner_username (no SSO username yet)", () => {
    // Pins the mock-era behavior that username is derived from email.
    // Once nemar-cli#572 ships a real `username` field on the session, the
    // implementation switches to using that field directly and this test
    // should be revisited.
    expect(
      isCollaboratorManager(session("user", "alice.smith@example.com"), ds("alicesmith")),
    ).toBe(false);
  });
});

describe("listCollaborators", () => {
  it("hits /api/datasets/:id/collaborators with credentials", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/datasets/nm-xyz/collaborators");
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
  it("POSTs to /datasets/:id/invite with the username body", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/datasets/nm-xyz/invite");
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
      expect(url).toBe("/api/v1/datasets/nm%2Fweird/invite");
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

// A fetch that never settles on its own — it only rejects when its signal
// aborts. This is the failure mode a plain try/catch cannot cover: a
// connection that opens and then never writes a response.
// `/dataset/:id/collaborators` awaits listCollaborators during SSR, so without
// a deadline a hung api.nemar.org stalls the render itself.
const hangingFetch = ((_url: string, requestInit: RequestInit) =>
  new Promise((_resolve, reject) => {
    requestInit.signal?.addEventListener("abort", () => reject(requestInit.signal?.reason));
  })) as unknown as typeof fetch;

describe("request deadlines", () => {
  it("aborts a hung list rather than stalling the SSR render", async () => {
    await expect(
      listCollaborators("nm-xyz", { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts a hung invite rather than leaving the form stuck", async () => {
    await expect(
      inviteCollaborator("nm-xyz", "carol", { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  // A caller-supplied signal must still abort even though a deadline is also
  // in play — AbortSignal.any() combines them, it doesn't replace one.
  it("honours a caller-supplied signal alongside the deadline", async () => {
    const controller = new AbortController();
    const pending = listCollaborators("nm-xyz", {
      fetch: hangingFetch,
      signal: controller.signal,
    });
    controller.abort(new Error("caller went away"));
    await expect(pending).rejects.toThrow("caller went away");
  });

  // Invite carries a GitHub round-trip the read does not, so it must stay
  // strictly slower than the list read.
  it("gives invite a longer deadline than the list read", () => {
    expect(COLLABORATOR_TIMEOUTS_MS.invite).toBeGreaterThan(COLLABORATOR_TIMEOUTS_MS.list);
  });
});

// The suite above proves a deadline EXISTS, not which constant a call site
// passes — every case there supplies an explicit `timeoutMs`, which
// `resolveSignal` always prefers over the fallback. Spy on the static instead,
// with no override, so the fallback becomes observable.
describe("deadline wiring", () => {
  function okFetch(body: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the list deadline when listing collaborators", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await listCollaborators("nm-xyz", {
      fetch: okFetch({ dataset_id: "nm-xyz", collaborators: [], count: 0 }),
    });
    expect(spy).toHaveBeenCalledWith(COLLABORATOR_TIMEOUTS_MS.list);
  });

  // The regression this exists for: invite carries a GitHub round-trip, so
  // inheriting the read deadline would abort healthy invites.
  it("passes the invite deadline when inviting", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await inviteCollaborator("nm-xyz", "carol", {
      fetch: okFetch({ message: "ok", dataset_id: "nm-xyz", invitee: "carol" }),
    });
    expect(spy).toHaveBeenCalledWith(COLLABORATOR_TIMEOUTS_MS.invite);
  });
});
