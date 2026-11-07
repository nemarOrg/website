/**
 * The admin Compute client against fixtures captured from the REAL nemar-cli routes. Recapture:
 *
 *   NEMAR_CLI_DIR=<nemar-cli checkout of the Epic D branch> \
 *     bun scripts/capture-compute-admin-fixtures.mjs
 *
 * Nothing in the fixtures is hand-written; the cases that need a body the backend cannot be made
 * to produce (a malformed answer, a gateway page) build it inline and say so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import decisions from "../../test/fixtures/compute/admin-access-decisions.json";
import accessList from "../../test/fixtures/compute/admin-access-list.json";
import accessReport from "../../test/fixtures/compute/admin-access-report.json";
import flagged from "../../test/fixtures/compute/admin-jobs-flagged.json";
import unmatched from "../../test/fixtures/compute/admin-jobs-unmatched.json";
import pools from "../../test/fixtures/compute/admin-pools.json";
import status from "../../test/fixtures/compute/admin-status.json";
import {
  ComputeAdminApiError,
  classifyDecisionFailure,
  computeAccessQuery,
  computeAdminErrorText,
  computeJobsQuery,
  computePoolsQuery,
  decideComputeAccess,
  fetchComputeRequestsCount,
  getComputeAccessReport,
  getComputeAccount,
  getComputeStatus,
  listComputeAccess,
  listComputeJobs,
  listComputePools,
  listUnmatchedAccounting,
  readComputeAdminError,
  resetComputeBadgeWarning,
} from "./compute-admin-api";
import { COMPUTE_ACCESS_ADMIN_ERROR_CODES } from "./compute-admin-contract";

interface Seen {
  url: string;
  init: RequestInit;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch that records each call and answers with `answer(call index)`. */
function recorder(answer: (n: number) => Response | Promise<Response> | never) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return answer(seen.length - 1);
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

/** A captured `{ status, body }` as the Response the route sent. */
const captured = (c: { status: number; body: unknown }) => json(c.body, c.status);

type Captured = { status: number; body: unknown };
const dec = decisions as unknown as Record<string, Captured>;

beforeEach(() => {
  resetComputeBadgeWarning();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("each reader parses its captured fixture", () => {
  it("the access listing, in every state and page", async () => {
    for (const key of [
      "all",
      "requested",
      "active",
      "suspended",
      "denied",
      "revoked",
      "page_one",
      "page_two",
      "empty",
    ]) {
      const { fetchImpl } = recorder(() =>
        captured((accessList as unknown as Record<string, Captured>)[key]),
      );
      const page = await listComputeAccess({}, { fetch: fetchImpl });
      const raw = (accessList as unknown as Record<string, { body: { accounts: unknown[] } }>)[key];
      expect(page.accounts.length, key).toBe(raw.body.accounts.length);
    }
  });

  it("keeps the awkward rows as the backend served them", async () => {
    const { fetchImpl } = recorder(() => captured(accessList.all));
    const page = await listComputeAccess({}, { fetch: fetchImpl });
    const hostile = page.accounts.find((a) => a.username === "hostile");
    expect(hostile?.compute_purpose).toContain("<script>");
    expect(hostile?.compute_purpose).toContain("‮");
    const bare = page.accounts.find((a) => a.username === null);
    expect(bare).toMatchObject({ affiliation: null, given_name: null, family_name: null });
    expect(bare?.compute_purpose?.length).toBe(1000);
    expect(page.accounts.find((a) => a.account_kind === "service")).toBeDefined();
    const granted = page.accounts.find((a) => a.compute_access === "active");
    expect(granted?.compute_access_granted_by).toBeTypeOf("number");
  });

  it("a page carries the cursor the backend sent", async () => {
    const { fetchImpl } = recorder(() => captured(accessList.page_one));
    expect((await listComputeAccess({ limit: 2 }, { fetch: fetchImpl })).next_after).toBe(8);
    const last = recorder(() => captured(accessList.all));
    expect((await listComputeAccess({}, { fetch: last.fetchImpl })).next_after).toBeNull();
  });

  it("pools, jobs, unmatched rows, the report and the status", async () => {
    const p = await listComputePools(
      {},
      { fetch: recorder(() => captured(pools.account)).fetchImpl },
    );
    expect(p.pools.some((x) => x.available_milli < 0)).toBe(true);
    expect(p.pools.some((x) => x.frozen)).toBe(true);
    const plat = await listComputePools(
      {},
      { fetch: recorder(() => captured(pools.platform)).fetchImpl },
    );
    expect(plat.pools.map((x) => x.holder_ref).sort()).toEqual([
      "people",
      "people",
      "pipelines",
      "pipelines",
    ]);
    for (const flag of ["unreserved", "unattributed", "mismatch", "overrun"] as const) {
      const jobs = await listComputeJobs(
        { flag },
        { fetch: recorder(() => captured(flagged[flag])).fetchImpl },
      );
      expect(jobs.jobs.length, flag).toBeGreaterThan(0);
      for (const j of jobs.jobs) expect(j.flags, flag).toContain(flag);
    }
    const partner = (
      await listComputeJobs(
        { flag: "mismatch" },
        { fetch: recorder(() => captured(flagged.mismatch)).fetchImpl },
      )
    ).jobs.find((j) => j.source === "partner");
    expect(partner).toMatchObject({ partner_state: "mismatch", partner_flag: "owner_mismatch" });
    const um = await listUnmatchedAccounting(100, {
      fetch: recorder(() => captured(unmatched.list)).fetchImpl,
    });
    expect(um.total).toBe(2);
    expect(um.rows[0].charged_milli).toBeNull();
    const rep = await getComputeAccessReport("2026Q4", {
      fetch: recorder(() => captured(accessReport.q4)).fetchImpl,
    });
    expect(rep.totals).toEqual({ distinct_users: 2, jobs: 3 });
    const off = await getComputeStatus({
      fetch: recorder(() => captured(status.compute_off)).fetchImpl,
    });
    expect(off).toMatchObject({
      compute_enabled: false,
      reconciliation_paused: true,
      tapis_token: "unconfigured",
    });
    const att = await getComputeStatus({
      fetch: recorder(() => captured(status.attention)).fetchImpl,
    });
    expect(att.attention.cancel_pending_failed).toBe(1);
  });
});

describe("a body the guard rejects is an error, never an empty list", () => {
  const cases: Array<[string, () => Promise<unknown>, unknown]> = [
    [
      "access without accounts",
      () => listComputeAccess({}, { fetch: bad({ next_after: null }) }),
      0,
    ],
    [
      "access row without an id",
      () => listComputeAccess({}, { fetch: bad({ accounts: [{ email: "a" }], next_after: null }) }),
      0,
    ],
    [
      "pools whose totals are floats",
      () =>
        listComputePools(
          {},
          {
            fetch: bad({
              pools: [
                { ...(pools.account.body as { pools: object[] }).pools[0], granted_milli: 1.5 },
              ],
              next_after: null,
            }),
          },
        ),
      0,
    ],
    [
      "jobs with no flags array",
      () => listComputeJobs({}, { fetch: bad({ jobs: [{ id: "job_x" }], next_after: null }) }),
      0,
    ],
    [
      "unmatched without a total",
      () => listUnmatchedAccounting(5, { fetch: bad({ rows: [] }) }),
      0,
    ],
    [
      "a report without totals",
      () => getComputeAccessReport("2026Q4", { fetch: bad({ quarter: "2026Q4", rows: [] }) }),
      0,
    ],
    ["a status without switches", () => getComputeStatus({ fetch: bad({ tapis: {} }) }), 0],
  ];
  function bad(body: unknown): typeof fetch {
    return recorder(() => json(body)).fetchImpl;
  }
  for (const [name, run] of cases) {
    it(name, async () => {
      await expect(run()).rejects.toBeInstanceOf(ComputeAdminApiError);
    });
  }

  it("a 200 whose body is not JSON", async () => {
    const { fetchImpl } = recorder(() => new Response("<html>maintenance</html>", { status: 200 }));
    await expect(listComputeAccess({}, { fetch: fetchImpl })).rejects.toMatchObject({
      status: 200,
      sentence: expect.stringContaining("could not read"),
    });
  });

  it("tolerates an unknown extra key and an unknown state word", async () => {
    const body = JSON.parse(JSON.stringify(accessList.requested.body));
    body.accounts[0].a_new_field = { nested: true };
    body.accounts[0].compute_access = "paused_for_review";
    body.extra = 1;
    const page = await listComputeAccess({}, { fetch: recorder(() => json(body)).fetchImpl });
    expect(page.accounts[0].compute_access).toBe("paused_for_review");
  });
});

describe("queries drop what the route would refuse", () => {
  it("access", () => {
    expect(computeAccessQuery({ state: "requested", limit: 25, after: 7 })).toBe(
      "?state=requested&after=7&limit=25",
    );
    expect(computeAccessQuery({ state: "none" })).toBe("");
    expect(computeAccessQuery({ state: "bogus", after: "0", limit: "abc" })).toBe("");
    expect(computeAccessQuery({ limit: 5000 })).toBe("?limit=200");
    expect(computeAccessQuery({ after: "12" })).toBe("?after=12");
  });
  it("pools and jobs", () => {
    expect(computePoolsQuery({ holderKind: "platform", limit: 50 })).toBe(
      "?holder_kind=platform&limit=50",
    );
    expect(computePoolsQuery({ holderKind: "nobody" })).toBe("");
    expect(computeJobsQuery({ flag: "overrun", after: 9, limit: 25 })).toBe(
      "?flag=overrun&after=9&limit=25",
    );
    expect(computeJobsQuery({ flag: "everything", state: "running", account: 4 })).toBe(
      "?state=running&account=4",
    );
  });
  it("sends the cookie and the API base when rendering on the server, the proxy otherwise", async () => {
    const a = recorder(() => captured(accessList.empty));
    await listComputeAccess({ state: "denied" }, { fetch: a.fetchImpl, cookieHeader: "s=1" });
    expect(a.seen[0].url).toBe("https://api.nemar.org/admin/compute/access?state=denied");
    expect((a.seen[0].init.headers as Record<string, string>).Cookie).toBe("s=1");
    const b = recorder(() => captured(accessList.empty));
    await listComputeAccess({}, { fetch: b.fetchImpl });
    expect(b.seen[0].url).toBe("/api/v1/admin/compute/access");
  });
});

describe("decideComputeAccess", () => {
  it("posts to the by-id route for each decision with an empty body", async () => {
    for (const [decision, key] of [
      ["grant", "grant_allocated"],
      ["deny", "deny"],
      ["suspend", "suspend"],
      ["revoke", "revoke"],
    ] as const) {
      const { seen, fetchImpl } = recorder(() => captured(dec[key]));
      const out = await decideComputeAccess(42, decision, undefined, { fetch: fetchImpl });
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe(`/api/v1/admin/compute/access/${decision}/by-id/42`);
      expect(seen[0].init.method).toBe("POST");
      expect(seen[0].init.body).toBe("{}");
      expect((seen[0].init.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/json",
      );
      expect(out.decision).toBe(key === "grant_allocated" ? "grant" : decision);
    }
  });

  it("parses every captured success, with and without an allocation", async () => {
    const granted = await decideComputeAccess(1, "grant", undefined, {
      fetch: recorder(() => captured(dec.grant_allocated)).fetchImpl,
    });
    expect(granted.allocation).toEqual({
      granted: true,
      cpu_milli: 50000,
      gpu_milli: 5000,
      reason: null,
      policy_version: 1,
    });
    expect(granted.email_sent).toBe(true);
    const zero = await decideComputeAccess(1, "grant", undefined, {
      fetch: recorder(() => captured(dec.grant_default_zero)).fetchImpl,
    });
    expect(zero.allocation?.reason).toBe("policy_default_zero");
    const already = await decideComputeAccess(1, "grant", undefined, {
      fetch: recorder(() => captured(dec.lift_suspension_already_granted)).fetchImpl,
    });
    expect(already.allocation?.reason).toBe("already_granted");
    const denied = await decideComputeAccess(1, "deny", undefined, {
      fetch: recorder(() => captured(dec.deny)).fetchImpl,
    });
    expect(denied.allocation).toBeNull();
    const unsent = await decideComputeAccess(1, "grant", undefined, {
      fetch: recorder(() => captured(dec.grant_email_not_sent)).fetchImpl,
    });
    expect(unsent.email_sent).toBe(false);
  });

  it("sends the reason trimmed, omits an empty one, and holds the 500 boundary", async () => {
    const r = recorder(() => captured(dec.deny));
    await decideComputeAccess(3, "deny", "  outside scope \n", { fetch: r.fetchImpl });
    expect(r.seen[0].init.body).toBe(JSON.stringify({ reason: "outside scope" }));
    await decideComputeAccess(3, "deny", "   ", { fetch: r.fetchImpl });
    expect(r.seen[1].init.body).toBe("{}");
    await decideComputeAccess(3, "deny", "x".repeat(500), { fetch: r.fetchImpl });
    expect(r.seen).toHaveLength(3);
    await expect(
      decideComputeAccess(3, "deny", "x".repeat(501), { fetch: r.fetchImpl }),
    ).rejects.toMatchObject({ code: "invalid_body" });
    // Over-long only by the whitespace the route trims: allowed, sent trimmed.
    await decideComputeAccess(3, "deny", `${"x".repeat(500)}   `, { fetch: r.fetchImpl });
    expect(r.seen).toHaveLength(4);
    expect(r.seen[3].init.body).toBe(JSON.stringify({ reason: "x".repeat(500) }));
  });

  it("sends nothing for an id or a decision it cannot send", async () => {
    const r = recorder(() => captured(dec.deny));
    for (const id of [0, -1, 1.5, Number.NaN]) {
      await expect(
        decideComputeAccess(id, "grant", undefined, { fetch: r.fetchImpl }),
      ).rejects.toBeInstanceOf(ComputeAdminApiError);
    }
    await expect(
      decideComputeAccess(1, "delete" as never, undefined, { fetch: r.fetchImpl }),
    ).rejects.toBeInstanceOf(ComputeAdminApiError);
    expect(r.seen).toHaveLength(0);
  });

  it("surfaces the backend's sentence and word for every captured refusal, and classifies it", async () => {
    const expected: Record<string, ReturnType<typeof classifyDecisionFailure>> = {
      refused_not_requested_grant: "state_changed",
      refused_not_requested_deny: "state_changed",
      refused_already_active: "state_changed",
      refused_not_active: "state_changed",
      refused_stale_state: "state_changed",
      refused_account_not_found: "not_found",
      refused_invalid_id: "refused",
      refused_invalid_body_reason: "refused",
      refused_invalid_body_key: "refused",
      refused_not_in_good_standing: "refused",
      refused_self_decision: "refused",
      refused_policy_unreadable: "refused",
      refused_unauthenticated: "signed_out",
      refused_member: "refused",
      refused_owner_only_policy: "refused",
    };
    for (const [key, want] of Object.entries(expected)) {
      const c = dec[key];
      const err = await decideComputeAccess(5, "grant", undefined, {
        fetch: recorder(() => captured(c)).fetchImpl,
      }).catch((e) => e);
      expect(err, key).toBeInstanceOf(ComputeAdminApiError);
      const body = c.body as { error: string; code?: string };
      expect(err.status, key).toBe(c.status);
      expect(err.sentence, key).toBe(body.error);
      expect(err.code, key).toBe(body.code);
      expect(classifyDecisionFailure(err), key).toBe(want);
      expect(computeAdminErrorText(err), key).toBe(body.error);
    }
  });

  it("every decision word the contract lists classifies, and the 5xx ones are not refusals", () => {
    for (const code of COMPUTE_ACCESS_ADMIN_ERROR_CODES) {
      const status =
        code === "internal"
          ? 500
          : code === "policy_unreadable"
            ? 503
            : code === "account_not_found"
              ? 404
              : code.startsWith("invalid")
                ? 400
                : 409;
      const kind = classifyDecisionFailure(new ComputeAdminApiError(status, code, "sentence"));
      expect(["refused", "state_changed", "not_found", "unknown_outcome"], code).toContain(kind);
    }
    expect(classifyDecisionFailure(new ComputeAdminApiError(500, "internal", "x"))).toBe(
      "unknown_outcome",
    );
    expect(classifyDecisionFailure(new ComputeAdminApiError(503, "policy_unreadable", "x"))).toBe(
      "refused",
    );
  });

  it("a lost answer is an unknown outcome: gateway page, proxy word, timeout, network, unreadable body", async () => {
    const gateway = await decideComputeAccess(5, "grant", undefined, {
      fetch: recorder(() => new Response("<html>bad gateway</html>", { status: 502 })).fetchImpl,
    }).catch((e) => e);
    expect(classifyDecisionFailure(gateway)).toBe("unknown_outcome");
    const proxy = await decideComputeAccess(5, "grant", undefined, {
      fetch: recorder(() => json({ error: "upstream_unreachable" }, 502)).fetchImpl,
    }).catch((e) => e);
    expect(proxy.sentence).toBe("upstream_unreachable");
    expect(classifyDecisionFailure(proxy)).toBe("unknown_outcome");
    expect(computeAdminErrorText(proxy)).toContain("could not be reached");
    const redirect = await decideComputeAccess(5, "grant", undefined, {
      fetch: recorder(() => json({ error: "upstream_redirect" }, 502)).fetchImpl,
    }).catch((e) => e);
    expect(classifyDecisionFailure(redirect)).toBe("unknown_outcome");
    const timeout = await decideComputeAccess(5, "grant", undefined, {
      fetch: recorder(() => Promise.reject(new DOMException("timed out", "TimeoutError")))
        .fetchImpl,
    }).catch((e) => e);
    expect(classifyDecisionFailure(timeout)).toBe("unknown_outcome");
    expect(computeAdminErrorText(timeout)).toContain("did not answer in time");
    const network = await decideComputeAccess(5, "grant", undefined, {
      fetch: recorder(() => Promise.reject(new TypeError("Failed to fetch"))).fetchImpl,
    }).catch((e) => e);
    expect(classifyDecisionFailure(network)).toBe("unknown_outcome");
    const unreadable = await decideComputeAccess(5, "grant", undefined, {
      fetch: recorder(() => new Response("ok", { status: 200 })).fetchImpl,
    }).catch((e) => e);
    expect(classifyDecisionFailure(unreadable)).toBe("unknown_outcome");
    const odd = await decideComputeAccess(5, "grant", undefined, {
      fetch: recorder(() => json({ ok: true })).fetchImpl,
    }).catch((e) => e);
    expect(classifyDecisionFailure(odd)).toBe("unknown_outcome");
  });

  it("a 429 is a refusal and a 408 is not known", () => {
    expect(classifyDecisionFailure(new ComputeAdminApiError(429))).toBe("refused");
    expect(classifyDecisionFailure(new ComputeAdminApiError(408))).toBe("unknown_outcome");
    expect(classifyDecisionFailure(new Error("anything else"))).toBe("unknown_outcome");
  });
});

describe("readComputeAdminError", () => {
  it("reads { error, code } and tolerates anything else", async () => {
    expect(
      await readComputeAdminError(json({ error: "A sentence.", code: "stale_state" }, 409)),
    ).toEqual({ code: "stale_state", sentence: "A sentence." });
    expect(await readComputeAdminError(json({ error: "Admin access required" }, 403))).toEqual({
      code: undefined,
      sentence: "Admin access required",
    });
    expect(await readComputeAdminError(new Response("nope", { status: 502 }))).toEqual({});
    expect(await readComputeAdminError(json(["x"], 500))).toEqual({});
    expect(await readComputeAdminError(json({ error: 5, code: "" }, 500))).toEqual({
      code: undefined,
      sentence: undefined,
    });
  });
});

describe("getComputeAccount", () => {
  it("re-reads one account through the listing's keyset", async () => {
    const r = recorder(() => captured(accessList.one_by_cursor));
    const row = await getComputeAccount(8, { fetch: r.fetchImpl });
    expect(r.seen[0].url).toBe("/api/v1/admin/compute/access?after=7&limit=1");
    expect(row?.id).toBe(8);
  });
  it("is null when the listing answers a different account or none", async () => {
    expect(
      await getComputeAccount(9, {
        fetch: recorder(() => captured(accessList.one_by_cursor)).fetchImpl,
      }),
    ).toBeNull();
    expect(
      await getComputeAccount(9, { fetch: recorder(() => captured(accessList.empty)).fetchImpl }),
    ).toBeNull();
    expect(
      await getComputeAccount(0, { fetch: recorder(() => captured(accessList.empty)).fetchImpl }),
    ).toBeNull();
  });
  it("asks for the first account without a cursor", async () => {
    const r = recorder(() => captured(accessList.empty));
    await getComputeAccount(1, { fetch: r.fetchImpl });
    expect(r.seen[0].url).toBe("/api/v1/admin/compute/access?limit=1");
  });
});

describe("fetchComputeRequestsCount", () => {
  it("counts the served rows of the requested listing and says when it is capped", async () => {
    const r = recorder(() => captured(accessList.requested));
    expect(await fetchComputeRequestsCount({ fetch: r.fetchImpl })).toEqual({
      count: 3,
      capped: false,
    });
    expect(r.seen[0].url).toBe("/api/v1/admin/compute/access?state=requested&limit=200");
    const capped = recorder(() => captured(accessList.page_one));
    expect(await fetchComputeRequestsCount({ fetch: capped.fetchImpl })).toEqual({
      count: 2,
      capped: true,
    });
  });

  it("is null on a failed, an aborted and a malformed read, and never throws", async () => {
    expect(
      await fetchComputeRequestsCount({
        fetch: recorder(() => json({ error: "no" }, 500)).fetchImpl,
      }),
    ).toBeNull();
    expect(
      await fetchComputeRequestsCount({
        fetch: recorder(() => captured(accessList.member)).fetchImpl,
      }),
    ).toBeNull();
    expect(
      await fetchComputeRequestsCount({
        fetch: recorder(() => Promise.reject(new DOMException("aborted", "AbortError"))).fetchImpl,
      }),
    ).toBeNull();
    expect(
      await fetchComputeRequestsCount({ fetch: recorder(() => json({ accounts: "x" })).fetchImpl }),
    ).toBeNull();
    expect(
      await fetchComputeRequestsCount({
        fetch: recorder(() => new Response("<html>", { status: 200 })).fetchImpl,
      }),
    ).toBeNull();
  });

  it("logs the degrade at most once a minute", async () => {
    const warn = vi.mocked(console.warn);
    const failing = recorder(() => json({ error: "no" }, 500)).fetchImpl;
    await fetchComputeRequestsCount({ fetch: failing });
    await fetchComputeRequestsCount({ fetch: failing });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("the report reader refuses a quarter the route would refuse", () => {
  it("sends nothing", async () => {
    const r = recorder(() => captured(accessReport.q4));
    await expect(getComputeAccessReport("2026Q5", { fetch: r.fetchImpl })).rejects.toMatchObject({
      code: "invalid_query",
    });
    await expect(getComputeAccessReport("Q4", { fetch: r.fetchImpl })).rejects.toBeInstanceOf(
      ComputeAdminApiError,
    );
    expect(r.seen).toHaveLength(0);
  });
});
