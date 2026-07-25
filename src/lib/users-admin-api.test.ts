import { describe, expect, it } from "vitest";
import {
  type AdminUserListRow,
  approveUser,
  changeUserRole,
  deleteUserById,
  fetchAwaitingApprovalCount,
  getAdminUser,
  isActionable,
  isSelf,
  listAdminUsers,
  revokeUser,
} from "./users-admin-api";

function row(overrides: Partial<AdminUserListRow> = {}): AdminUserListRow {
  return {
    id: 1,
    username: "alice",
    email: "alice@example.com",
    github_username: "alice-gh",
    status: "verified",
    email_verified: 1,
    role: "member",
    created_at: "2026-07-20 12:00:00",
    approved_at: null,
    revoked_at: null,
    ...overrides,
  };
}

describe("isActionable", () => {
  it("true when username is a non-empty string", () => {
    expect(isActionable(row({ username: "alice" }))).toBe(true);
  });

  // The core null-username case (nemarOrg/nemar-cli#1012): ORCID/web
  // signups land with no username, and every write endpoint except delete
  // is keyed by username. This must resolve to false without throwing so
  // the row still renders, just non-actionable.
  it("false when username is null", () => {
    expect(isActionable(row({ username: null }))).toBe(false);
  });

  it("false when username is an empty string", () => {
    expect(isActionable(row({ username: "" }))).toBe(false);
  });
});

describe("isSelf", () => {
  it("true when the row id matches the session user id", () => {
    expect(isSelf(1, "1")).toBe(true);
  });

  it("false when the ids differ", () => {
    expect(isSelf(1, "2")).toBe(false);
  });

  // The dev-mock session issues non-numeric ids (e.g. "dev-qa_nemar_admin").
  // A `Number(sessionUserId)` comparison would silently evaluate to NaN and
  // never match, so the self-gating would look correct against a real
  // numeric session but stay broken for every local dev render. Comparing
  // as strings pins this case.
  it("compares as strings, not Number() — non-numeric session id", () => {
    expect(isSelf(42, "dev-qa_nemar_admin")).toBe(false);
  });

  it("compares as strings, not Number() — matching numeric-looking string", () => {
    expect(isSelf(42, "42")).toBe(true);
  });
});

describe("listAdminUsers", () => {
  it("hits /admin/users with no query when filter is empty", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/users");
      expect(init.credentials).toBe("include");
      return new Response(JSON.stringify({ users: [], count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const out = await listAdminUsers({}, { fetch: fakeFetch });
    expect(out.count).toBe(0);
  });

  it("appends ?status= when a status filter reaches the right URL", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/admin/users?status=verified");
      return new Response(JSON.stringify({ users: [], count: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    await listAdminUsers({ status: "verified" }, { fetch: fakeFetch });
  });

  it("combines status, role, and include_deleted in the query string", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/admin/users?status=approved&role=admin&include_deleted=true");
      return new Response(JSON.stringify({ users: [], count: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    await listAdminUsers(
      { status: "approved", role: "admin", includeDeleted: true },
      { fetch: fakeFetch },
    );
  });

  it("SSR calls hit api.nemar.org directly and attach the Cookie header", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.nemar.org/admin/users");
      expect((init.headers as Record<string, string>).Cookie).toBe("nemar_session=abc");
      return new Response(JSON.stringify({ users: [], count: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    await listAdminUsers({}, { fetch: fakeFetch, cookieHeader: "nemar_session=abc" });
  });

  it("returns parsed rows including a null username", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ users: [row({ username: null })], count: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const out = await listAdminUsers({}, { fetch: fakeFetch });
    expect(out.users[0]?.username).toBeNull();
  });

  it("propagates the backend's human-readable error text via .code", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(listAdminUsers({}, { fetch: fakeFetch })).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 403,
      code: "Admin access required",
    });
  });
});

describe("getAdminUser", () => {
  it("GETs /admin/users/:username and unwraps { user }", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/admin/users/alice");
      return new Response(
        JSON.stringify({
          user: { ...row(), dataset_count: 3, active_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await getAdminUser("alice", { fetch: fakeFetch });
    expect(out.dataset_count).toBe(3);
    expect(out.active_tokens).toBe(1);
  });

  it("URL-encodes the username", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/admin/users/al%2Fice");
      return new Response(JSON.stringify({ user: row() }), { status: 200 });
    }) as unknown as typeof fetch;
    await getAdminUser("al/ice", { fetch: fakeFetch });
  });

  it("propagates a 404 as DashboardApiError so the page can render gracefully", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(getAdminUser("ghost", { fetch: fakeFetch })).rejects.toMatchObject({
      status: 404,
      code: "User not found",
    });
  });
});

describe("approveUser", () => {
  it("POSTs to /admin/approve/:username", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/approve/alice");
      expect(init.method).toBe("POST");
      return new Response(
        JSON.stringify({
          message: "User alice has been approved",
          user: { username: "alice", email: "alice@example.com", status: "approved" },
          email_sent: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await approveUser("alice", { fetch: fakeFetch });
    expect(out.user.status).toBe("approved");
  });

  it("surfaces the backend's ineligibility reason", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          error: "User is not eligible for approval",
          status: "pending",
          message: "User needs to verify their email first",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    await expect(approveUser("alice", { fetch: fakeFetch })).rejects.toMatchObject({
      status: 400,
      code: "User is not eligible for approval",
    });
  });
});

describe("revokeUser", () => {
  it("POSTs to /admin/revoke/:username", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/revoke/alice");
      expect(init.method).toBe("POST");
      return new Response(
        JSON.stringify({
          message: "User alice access has been fully revoked",
          user: { username: "alice", status: "revoked" },
          email_sent: true,
          iam_revoked: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await revokeUser("alice", { fetch: fakeFetch });
    expect(out.user.status).toBe("revoked");
  });

  it("treats a 207 partial-success as ok and surfaces the warning", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          warning: "User revoked with IAM cleanup failure",
          message:
            "User's API tokens and database access revoked, but S3 credentials may still be active",
          user: { username: "alice", status: "revoked_iam_pending" },
          email_sent: true,
          iam_revoked: false,
        }),
        { status: 207, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    const out = await revokeUser("alice", { fetch: fakeFetch });
    expect(out.warning).toBe("User revoked with IAM cleanup failure");
    expect(out.user.status).toBe("revoked_iam_pending");
  });

  it("propagates the self-revoke guard as a friendly error code", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "Cannot revoke your own access" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(revokeUser("me", { fetch: fakeFetch })).rejects.toMatchObject({
      status: 400,
      code: "Cannot revoke your own access",
    });
  });
});

describe("changeUserRole", () => {
  it("POSTs the target role to /admin/users/:username/role", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/users/alice/role");
      expect(init.body).toBe(JSON.stringify({ role: "admin" }));
      return new Response(
        JSON.stringify({
          message: "User alice role changed from 'member' to 'admin'",
          user: { username: "alice", role: "admin" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await changeUserRole("alice", "admin", { fetch: fakeFetch });
    expect(out.user.role).toBe("admin");
  });

  it("propagates owner-only 403 (a plain admin hit the endpoint)", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "Owner access required" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(changeUserRole("alice", "admin", { fetch: fakeFetch })).rejects.toMatchObject({
      status: 403,
      code: "Owner access required",
    });
  });
});

describe("deleteUserById", () => {
  it("DELETEs /admin/users/by-id/:id", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/users/by-id/42");
      expect(init.method).toBe("DELETE");
      return new Response(JSON.stringify({ deleted: true, id: 42, masked: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const out = await deleteUserById(42, { fetch: fakeFetch });
    expect(out).toEqual({ deleted: true, id: 42, masked: true });
  });

  it("still works for a row that has no username (id-keyed)", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/admin/users/by-id/99");
      return new Response(JSON.stringify({ deleted: true, id: 99, already_deleted: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const out = await deleteUserById(99, { fetch: fakeFetch });
    expect(out.already_deleted).toBe(true);
  });
});

describe("fetchAwaitingApprovalCount", () => {
  it("returns the count of verified-status users", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/admin/users?status=verified");
      return new Response(JSON.stringify({ users: [row(), row()], count: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await expect(fetchAwaitingApprovalCount({ fetch: fakeFetch })).resolves.toBe(2);
  });

  it("never throws: resolves to null on a non-ok response", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as unknown as typeof fetch;
    await expect(fetchAwaitingApprovalCount({ fetch: fakeFetch })).resolves.toBeNull();
  });

  it("never throws: resolves to null when fetch itself rejects", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(fetchAwaitingApprovalCount({ fetch: fakeFetch })).resolves.toBeNull();
  });
});

// A fetch that never settles on its own — it only rejects when its signal
// aborts. This is the failure mode a plain try/catch cannot cover: a
// connection that opens and then never writes a response. Without a deadline
// these calls would hang the SSR render of every admin page, since
// fetchAwaitingApprovalCount is awaited from the shared AdminLayout.
const hangingFetch = ((_url: string, requestInit: RequestInit) =>
  new Promise((_resolve, reject) => {
    requestInit.signal?.addEventListener("abort", () => reject(requestInit.signal?.reason));
  })) as unknown as typeof fetch;

describe("request deadlines", () => {
  it("aborts a hung list request rather than hanging forever", async () => {
    await expect(listAdminUsers({}, { fetch: hangingFetch, timeoutMs: 10 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("degrades the badge count to null when the request hangs", async () => {
    await expect(
      fetchAwaitingApprovalCount({ fetch: hangingFetch, timeoutMs: 10 }),
    ).resolves.toBeNull();
  });

  it("aborts a hung mutation rather than leaving the button stuck", async () => {
    await expect(
      approveUser("alice", { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
