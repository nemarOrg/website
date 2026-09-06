import { describe, expect, it } from "vitest";
import { DashboardApiError } from "./dashboard-api";
import {
  ADMIN_TIER_LABELS,
  type AdminUserListRow,
  REVIEW_DETAIL_LIMIT,
  adminActionErrorText,
  adminActionMessage,
  adminTier,
  adminUsersQuery,
  approveErrorText,
  approveUserById,
  canApproveUser,
  changeUserRole,
  deleteUserById,
  fetchAwaitingApprovalCount,
  getAdminUser,
  isActionable,
  isAwaitingUploadApproval,
  isSelf,
  listAdminUsers,
  loadReviewDetails,
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

describe("approveUserById", () => {
  // Keyed by numeric id, not username, because a web/ORCID account has none
  // (nemar-cli migration 0026) and under ADR 0040 approval is the only way it
  // ever gets upload access. The username-keyed route could not address it.
  it("POSTs to /admin/approve/by-id/:id", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/approve/by-id/42");
      expect(init.method).toBe("POST");
      return new Response(
        JSON.stringify({
          message: "User alice has been approved",
          user: {
            username: "alice",
            email: "alice@example.com",
            status: "approved",
            service_access: true,
          },
          email_sent: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await approveUserById(42, { fetch: fakeFetch });
    expect(out.user.status).toBe("approved");
    expect(out.user.service_access).toBe(true);
  });

  it("reaches a row that has no username at all", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/admin/approve/by-id/99");
      return new Response(
        JSON.stringify({
          message: "User approved",
          user: { username: null, email: "web@example.com", status: "approved" },
          email_sent: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await approveUserById(99, { fetch: fakeFetch });
    expect(out.user.username).toBeNull();
  });

  it("keeps BOTH sentences of the unverified-email refusal", async () => {
    // `error` is the headline and `message` says what to do about it. The
    // shared `friendly()` in the admin pages renders `code` alone, which
    // would drop the only actionable half — hence the combined message here.
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          error: "User is not eligible for approval",
          status: "pending",
          message:
            "User must verify their email address first; approval cannot skip the inbox check",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    await expect(approveUserById(7, { fetch: fakeFetch })).rejects.toMatchObject({
      status: 400,
      code: "User is not eligible for approval",
      message:
        "User is not eligible for approval — User must verify their email address first; approval cannot skip the inbox check",
    });
  });

  it("surfaces the repair path's note when only the grant was written", async () => {
    // An account already at `approved` with no grant is repaired rather than
    // 409'd, so an admin has a way to fix a row whose status says approved
    // while the upload gate says no.
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          message: "User alice already had status 'approved'; upload access granted",
          note: "Only the upload grant was written",
          user: { username: "alice", email: "a@b.org", status: "approved", service_access: true },
          email_sent: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    const out = await approveUserById(1, { fetch: fakeFetch });
    expect(out.note).toContain("Only the upload grant");
    expect(out.email_sent).toBe(false);
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
  // Counts OPEN upload-access requests, not the base tier. It used to send
  // `?status=verified`, which since nemar-cli ADR 0040 is every browse-only
  // account — a badge in the hundreds with nothing actionable behind it.
  it("counts accounts with an open upload-access request", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/admin/users?awaiting_approval=1");
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
    await expect(approveUserById(1, { fetch: hangingFetch, timeoutMs: 10 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});

// ---------------------------------------------------------------------------
// Tier + upload-request derivations (website#301)
// ---------------------------------------------------------------------------

describe("adminUsersQuery", () => {
  it("sends awaiting_approval=1 for the queue", () => {
    // Spelled out because this is a server-side predicate over two columns —
    // getting the name or the value wrong returns every user rather than an
    // error, which reads as an enormous queue rather than a broken filter.
    expect(adminUsersQuery({ awaitingApproval: true })).toBe("awaiting_approval=1");
  });

  it("omits the parameter entirely when the queue is not asked for", () => {
    expect(adminUsersQuery({})).toBe("");
    expect(adminUsersQuery({ awaitingApproval: false })).toBe("");
  });

  it("still carries the lifecycle filters, in a stable order", () => {
    expect(adminUsersQuery({ status: "approved" })).toBe("status=approved");
    expect(adminUsersQuery({ role: "admin" })).toBe("role=admin");
    expect(adminUsersQuery({ includeDeleted: true })).toBe("include_deleted=true");
    expect(adminUsersQuery({ status: "verified", role: "member", awaitingApproval: true })).toBe(
      "status=verified&role=member&awaiting_approval=1",
    );
  });
});

describe("adminTier", () => {
  it("separates an uploader from a browse-only account", () => {
    expect(adminTier(row({ service_access: 1 }))).toBe("upload");
    expect(adminTier(row({ service_access: 0 }))).toBe("browse");
  });

  it("reports unknown — not browse — when the backend did not say", () => {
    // Coercing an absent key to 0 would tell an admin an uploader has no
    // grant, which is the one wrong answer that looks plausible. A CLI
    // talking to a pre-#1251 backend hits exactly this.
    expect(adminTier(row({}))).toBe("unknown");
    expect(adminTier(row({ service_access: null }))).toBe("unknown");
    expect(ADMIN_TIER_LABELS.unknown).toBe("Unknown");
  });
});

describe("isAwaitingUploadApproval", () => {
  it("is true for a request stamp with no grant", () => {
    expect(
      isAwaitingUploadApproval(
        row({ upload_access_requested_at: "2026-09-01 10:00:00", service_access: 0 }),
      ),
    ).toBe(true);
  });

  it("is false once an admin has answered, even though the stamp stays", () => {
    // The grant is what closes a request; the stamp survives as the record of
    // when they asked, so an approved account must leave the queue.
    expect(
      isAwaitingUploadApproval(
        row({ upload_access_requested_at: "2026-09-01 10:00:00", service_access: 1 }),
      ),
    ).toBe(false);
  });

  it("is false for an account that never asked", () => {
    expect(isAwaitingUploadApproval(row({ service_access: 0 }))).toBe(false);
    expect(
      isAwaitingUploadApproval(row({ upload_access_requested_at: null, service_access: 0 })),
    ).toBe(false);
    expect(
      isAwaitingUploadApproval(row({ upload_access_requested_at: "  ", service_access: 0 })),
    ).toBe(false);
  });

  it("is false when the grant is unknown", () => {
    // With `service_access` absent, "asked and unanswered" cannot be
    // established; guessing yes would put approved accounts in the queue.
    expect(isAwaitingUploadApproval(row({ upload_access_requested_at: "2026-09-01" }))).toBe(false);
  });
});

describe("adminActionMessage", () => {
  it("joins both halves of an approve refusal", () => {
    expect(
      adminActionMessage(
        "User is not eligible for approval",
        "User must verify their email address first; approval cannot skip the inbox check",
        "Approve failed",
      ),
    ).toBe(
      "User is not eligible for approval — User must verify their email address first; approval cannot skip the inbox check",
    );
  });

  it("does not repeat itself when the two agree", () => {
    expect(adminActionMessage("User not found", "User not found", "fallback")).toBe(
      "User not found",
    );
  });

  it("uses whichever half arrived", () => {
    expect(adminActionMessage("User already approved", undefined, "fallback")).toBe(
      "User already approved",
    );
    expect(adminActionMessage(undefined, "Something specific", "fallback")).toBe(
      "Something specific",
    );
  });

  it("falls back to the status text when the body carried nothing", () => {
    expect(adminActionMessage(undefined, undefined, "Bad Gateway")).toBe("Bad Gateway");
    expect(adminActionMessage("  ", "  ", "Bad Gateway")).toBe("Bad Gateway");
  });
});

describe("canApproveUser", () => {
  // Mirrors `isApprovable` in nemar-cli backend/src/routes/admin/users.ts. It
  // was a four-condition inline boolean in UserAdminRow.astro until
  // website#301's review: dropping the signup_source guard — which offers
  // Approve on every unverified CLI signup, for the backend to refuse —
  // passed the whole suite.
  it("approves a base-tier account waiting for the grant", () => {
    expect(canApproveUser(row({ status: "verified" }))).toBe(true);
  });

  it("re-approves a revoked account, including a partial IAM revoke", () => {
    expect(canApproveUser(row({ status: "revoked" }))).toBe(true);
    expect(canApproveUser(row({ status: "revoked_iam_pending" }))).toBe(true);
  });

  it("approves a pending WEB signup, which ORCID has already identified", () => {
    expect(canApproveUser(row({ status: "pending", signup_source: "web" }))).toBe(true);
  });

  it("does NOT approve a pending signup from any other source", () => {
    // The allowance is specifically for the ORCID web flow. A CLI signup at
    // `pending` has proved nothing yet, and the backend refuses it — offering
    // the button would be walking an admin into a 400.
    expect(canApproveUser(row({ status: "pending", signup_source: "cli" }))).toBe(false);
    expect(canApproveUser(row({ status: "pending", signup_source: null }))).toBe(false);
    expect(canApproveUser(row({ status: "pending" }))).toBe(false);
  });

  it("does not re-approve an already-approved account", () => {
    expect(canApproveUser(row({ status: "approved" }))).toBe(false);
  });

  it("does not require a username", () => {
    // Approval is keyed by numeric id precisely so a web row without one is
    // reachable; gating this on `isActionable` would put those accounts back
    // out of reach, which is the whole problem ADR 0040 had to solve.
    expect(canApproveUser({ status: "verified", signup_source: "web" })).toBe(true);
    expect(isActionable(row({ username: null }))).toBe(false);
  });

  it("does not second-guess the verified-email precondition", () => {
    // `email_verified` on a listing row can be stale relative to a code the
    // user redeemed a second ago, and the backend's refusal names exactly
    // what to do. A button that silently is not there does not.
    expect(canApproveUser(row({ status: "verified", email_verified: 0 }))).toBe(true);
  });
});

describe("loadReviewDetails", () => {
  function openRequest(id: number): AdminUserListRow {
    return row({
      id,
      username: `user${id}`,
      upload_access_requested_at: "2026-09-01 10:00:00",
      service_access: 0,
    });
  }

  function detailFetch(onCall?: (url: string) => void): typeof fetch {
    return (async (url: string) => {
      onCall?.(url);
      return new Response(
        JSON.stringify({ user: { ...row(), city: "London", description: "why" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  }

  it("fetches a detail for each open request", async () => {
    const seen: string[] = [];
    const out = await loadReviewDetails([openRequest(1), openRequest(2)], {
      fetch: detailFetch((url) => seen.push(url)),
    });
    expect(seen).toHaveLength(2);
    expect(out.details.size).toBe(2);
    expect(out.details.get(1)?.city).toBe("London");
    expect(out.failures).toBe(0);
    expect(out.truncated).toBe(false);
  });

  it("fetches nothing for rows that are not open requests", async () => {
    // An approved account keeps its `upload_access_requested_at` stamp as the
    // record of when it asked, so keying the fan-out on the stamp alone would
    // fetch a detail for every account that has ever asked.
    const seen: string[] = [];
    const out = await loadReviewDetails(
      [row({ id: 1 }), row({ id: 2, upload_access_requested_at: "2026-09-01", service_access: 1 })],
      { fetch: detailFetch((url) => seen.push(url)) },
    );
    expect(seen).toHaveLength(0);
    expect(out.details.size).toBe(0);
  });

  it("bounds the fan-out and says so", async () => {
    // The endpoint has no pagination, so nothing but this caps how many HTTP
    // calls one render makes.
    const seen: string[] = [];
    const users = Array.from({ length: 5 }, (_, i) => openRequest(i + 1));
    const out = await loadReviewDetails(users, {
      limit: 2,
      fetch: detailFetch((url) => seen.push(url)),
    });
    expect(seen).toHaveLength(2);
    expect(out.details.size).toBe(2);
    expect(out.truncated).toBe(true);
  });

  it("is not truncated when the open requests fit", async () => {
    const out = await loadReviewDetails([openRequest(1)], { limit: 2, fetch: detailFetch() });
    expect(out.truncated).toBe(false);
  });

  it("defaults to REVIEW_DETAIL_LIMIT", async () => {
    const seen: string[] = [];
    const users = Array.from({ length: REVIEW_DETAIL_LIMIT + 3 }, (_, i) => openRequest(i + 1));
    const out = await loadReviewDetails(users, { fetch: detailFetch((url) => seen.push(url)) });
    expect(seen).toHaveLength(REVIEW_DETAIL_LIMIT);
    expect(out.truncated).toBe(true);
  });

  it("fails soft per row, and COUNTS the failure", async () => {
    // A card silently missing its location and request text is
    // indistinguishable from a user who supplied neither, so the count is
    // what the page turns into a notice.
    const failing = (async (url: string) => {
      if (url.includes("user2")) throw new Error("upstream down");
      return new Response(JSON.stringify({ user: row() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const out = await loadReviewDetails([openRequest(1), openRequest(2), openRequest(3)], {
      fetch: failing,
    });
    expect(out.details.size).toBe(2);
    expect(out.details.has(2)).toBe(false);
    expect(out.failures).toBe(1);
  });

  it("counts a non-ok detail response as a failure rather than throwing", async () => {
    const notFound = (async () =>
      new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const out = await loadReviewDetails([openRequest(1)], { fetch: notFound });
    expect(out.failures).toBe(1);
    expect(out.details.size).toBe(0);
  });

  it("skips a row with no username, which the detail route cannot address", async () => {
    const seen: string[] = [];
    const out = await loadReviewDetails(
      [row({ id: 9, username: null, upload_access_requested_at: "2026-09-01", service_access: 0 })],
      { fetch: detailFetch((url) => seen.push(url)) },
    );
    expect(seen).toHaveLength(0);
    // Still counted as an open request for truncation purposes: an admin
    // seeing a card with no detail needs to know why either way.
    expect(out.truncated).toBe(false);
    expect(out.failures).toBe(0);
  });
});

describe("admin action error copy", () => {
  const apiError = (message: string, code?: string) => new DashboardApiError(message, 400, code);

  it("prefers the code on every route except approve", () => {
    // These routes put the sentence in `error`, so the code IS the text and
    // the message only wraps it in a prefix.
    expect(
      adminActionErrorText(apiError("Revoke failed: x", "Cannot revoke your own access")),
    ).toBe("Cannot revoke your own access");
  });

  it("prefers the message on approve", () => {
    // The difference these two functions exist for: an ineligible account
    // answers a headline in `error` and the actionable half in `message`.
    const err = apiError(
      "User is not eligible for approval — User must verify their email address first",
      "User is not eligible for approval",
    );
    expect(approveErrorText(err)).toContain("must verify their email address first");
    expect(adminActionErrorText(err)).toBe("User is not eligible for approval");
  });

  it("translates transport codes on both, which are not human text", () => {
    for (const render of [adminActionErrorText, approveErrorText]) {
      expect(render(apiError("boom", "upstream_unreachable"))).toContain("Can't reach");
      expect(render(apiError("boom", "unauthenticated"))).toContain("Sign in again");
    }
  });

  it("falls back to the message when the body carried no code", () => {
    expect(adminActionErrorText(apiError("Delete failed: Bad Gateway"))).toBe(
      "Delete failed: Bad Gateway",
    );
    expect(approveErrorText(apiError("Approve failed: Bad Gateway"))).toBe(
      "Approve failed: Bad Gateway",
    );
  });

  it("handles a non-API throw on both", () => {
    expect(adminActionErrorText(new Error("network down"))).toBe("network down");
    expect(approveErrorText(new Error("network down"))).toBe("network down");
    expect(adminActionErrorText("not an error")).toBe("Action failed.");
    expect(approveErrorText(null)).toBe("Action failed.");
  });
});
