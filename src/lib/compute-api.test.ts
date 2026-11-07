/**
 * The compute read client. Every success case parses a body captured from the real routes:
 *
 *   NEMAR_CLI_DIR=<nemar-cli checkout of the Epic D branch> \
 *     bun scripts/capture-compute-read-fixtures.mjs
 *
 * The transport conditions that no route can be made to produce (a 502 with no JSON, a timeout, a
 * refused connection) use a real `Response` or a real aborted signal, which the repo's rule allows for
 * failure paths.
 */
import { describe, expect, it } from "vitest";
import errors from "../../test/fixtures/compute/errors.json";
import jobsAll from "../../test/fixtures/compute/jobs-all-states.json";
import jobsEmpty from "../../test/fixtures/compute/jobs-empty.json";
import jobsPage1 from "../../test/fixtures/compute/jobs-page1.json";
import jobsPage2 from "../../test/fixtures/compute/jobs-page2.json";
import meActive from "../../test/fixtures/compute/me-active-with-usage.json";
import meOverrun from "../../test/fixtures/compute/me-overrun.json";
import meStates from "../../test/fixtures/compute/me-states.json";
import meThin from "../../test/fixtures/compute/me-thin-queue.json";
import usageDay from "../../test/fixtures/compute/usage-day-partition.json";
import usageEmpty from "../../test/fixtures/compute/usage-empty.json";
import {
  ComputeApiError,
  computeUrl,
  getComputeMe,
  getComputeUsage,
  listComputeJobs,
  parseComputeJobs,
  parseComputeMe,
  parseComputeUsage,
} from "./compute-api";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers one fixed Response and remembers the request. */
function answering(res: Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return res;
  }) as unknown as typeof fetch;
  return { fn, seen };
}

async function failure(promise: Promise<unknown>): Promise<ComputeApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ComputeApiError);
    return err as ComputeApiError;
  }
  throw new Error("expected the call to fail");
}

type Body = typeof meActive.body;

describe("GET /compute/me", () => {
  it("parses every captured access state", () => {
    for (const state of [
      "none",
      "requested",
      "active",
      "suspended",
      "denied",
      "revoked",
    ] as const) {
      const me = parseComputeMe(meStates[state].body);
      expect(me.access.state).toBe(state);
      expect(me.pools.cpu.granted_milli).toBe(0);
      expect(me.queue.length).toBeGreaterThan(0);
    }
  });

  it("keeps requests_open when sent and leaves it out when absent", () => {
    expect(parseComputeMe(meStates.none.body).access.requests_open).toBe(false);
    expect(parseComputeMe(meStates.none_requests_open.body).access.requests_open).toBe(true);
    const { requests_open: _drop, ...access } = meStates.none.body.access;
    const without = parseComputeMe({ ...meStates.none.body, access });
    expect("requests_open" in without.access).toBe(false);
  });

  it("parses balances exactly, a hold included", () => {
    const me = parseComputeMe(meActive.body);
    expect(me.pools.cpu).toEqual({
      granted_milli: 100_000,
      held_milli: 20_000,
      charged_milli: 40_200,
      available_milli: 39_800,
    });
    expect(me.frozen).toBe(false);
    expect(me.partitions.map((p) => p.name)).toEqual([
      "shared",
      "compute",
      "debug",
      "gpu-shared",
      "gpu",
      "gpu-debug",
    ]);
  });

  it("keeps a negative available_milli negative", () => {
    expect(parseComputeMe(meOverrun.body).pools.cpu.available_milli).toBe(-2_500);
  });

  it("keeps null queue figures null, with the count", () => {
    const me = parseComputeMe(meThin.body);
    const compute = me.queue.find((q) => q.partition === "compute");
    expect(compute).toMatchObject({ median_seconds: null, p90_seconds: null, count: 3 });
    expect(me.queue.find((q) => q.partition === "shared")?.median_seconds).toBe(30);
  });

  it("keeps a zero-second figure as 0, which is not null", () => {
    const me = parseComputeMe(meActive.body);
    expect(me.queue.find((q) => q.partition === "gpu-shared")?.median_seconds).toBe(0);
  });

  it("drops a pool the Worker adds and any key it does not read", () => {
    const body = {
      ...meActive.body,
      pools: {
        ...meActive.body.pools,
        tenant: { granted_milli: 9, held_milli: 0, charged_milli: 0, available_milli: 9 },
      },
      platform_remaining_milli: 123,
      extra: { anything: true },
    };
    const me = parseComputeMe(body);
    expect(Object.keys(me.pools)).toEqual(["cpu", "gpu"]);
    expect(Object.keys(me)).toEqual(["access", "pools", "frozen", "partitions", "queue"]);
    expect(JSON.stringify(me)).not.toContain("tenant");
    expect(JSON.stringify(me)).not.toContain("platform_remaining");
  });

  it("passes a state word it has never seen", () => {
    const body = { ...meActive.body, access: { ...meActive.body.access, state: "paused" } };
    expect(parseComputeMe(body).access.state).toBe("paused");
  });

  it.each([
    ["a missing gpu pool", (b: Body) => ({ ...b, pools: { cpu: b.pools.cpu } })],
    [
      "a float amount",
      (b: Body) => ({ ...b, pools: { ...b.pools, cpu: { ...b.pools.cpu, held_milli: 1.5 } } }),
    ],
    [
      "a string amount",
      (b: Body) => ({ ...b, pools: { ...b.pools, cpu: { ...b.pools.cpu, granted_milli: "100" } } }),
    ],
    [
      "a negative granted amount",
      (b: Body) => ({ ...b, pools: { ...b.pools, cpu: { ...b.pools.cpu, granted_milli: -1 } } }),
    ],
    [
      "an unsafe integer",
      (b: Body) => ({
        ...b,
        pools: { ...b.pools, cpu: { ...b.pools.cpu, charged_milli: 2 ** 60 } },
      }),
    ],
    ["frozen not a boolean", (b: Body) => ({ ...b, frozen: "no" })],
    ["queue not an array", (b: Body) => ({ ...b, queue: {} })],
    [
      "a queue count missing",
      (b: Body) => ({
        ...b,
        queue: [{ partition: "shared", median_seconds: 1, p90_seconds: 2, window_days: 7 }],
      }),
    ],
    [
      "a negative queue figure",
      (b: Body) => ({ ...b, queue: [{ ...b.queue[0], median_seconds: -1 }] }),
    ],
    [
      "requests_open a string",
      (b: Body) => ({ ...b, access: { ...b.access, requests_open: "yes" } }),
    ],
    ["access missing", (b: Body) => ({ ...b, access: null })],
    ["a body that is a list", () => []],
  ])("rejects %s as a shape error, never as zeros", (_name, mutate) => {
    expect(() => parseComputeMe(mutate(structuredClone(meActive.body)))).toThrow(ComputeApiError);
    try {
      parseComputeMe(mutate(structuredClone(meActive.body)));
    } catch (err) {
      expect((err as ComputeApiError).kind).toBe("shape");
    }
  });
});

describe("GET /compute/me/usage", () => {
  it("parses the captured rows, a correction's null partition included", () => {
    const usage = parseComputeUsage(usageDay.body);
    expect(usage.from).toBe("2026-10-09");
    expect(usage.to).toBe("2026-11-07");
    expect(usage.rows).toHaveLength(usageDay.body.rows.length);
    expect(usage.rows.find((r) => r.partition === null)?.charged_milli).toBe(1_750);
    expect(usage.rows.find((r) => r.charged_milli < 0)?.charged_milli).toBe(-300);
  });

  it("returns an empty list only for a body that says rows is empty", () => {
    expect(parseComputeUsage(usageEmpty.body).rows).toEqual([]);
    expect(() => parseComputeUsage({ ...usageEmpty.body, rows: undefined })).toThrow(
      ComputeApiError,
    );
    expect(() => parseComputeUsage({ ...usageEmpty.body, rows: "none" })).toThrow(ComputeApiError);
  });

  it("rejects a grouping without day and partition, and an unsafe or float amount", () => {
    expect(() => parseComputeUsage({ ...usageDay.body, group: ["day"] })).toThrow(ComputeApiError);
    const row = { ...usageDay.body.rows[0], charged_milli: 1.5 };
    expect(() => parseComputeUsage({ ...usageDay.body, rows: [row] })).toThrow(ComputeApiError);
  });

  it("asks for group=day,partition and no window, so the server's default window rules", async () => {
    const { fn, seen } = answering(json(usageDay.body));
    const usage = await getComputeUsage({ fetch: fn });
    expect(usage.rows.length).toBeGreaterThan(0);
    expect(seen[0].url).toBe("/api/v1/compute/me/usage?group=day%2Cpartition");
    expect(seen[0].url).not.toContain("from=");
  });
});

describe("GET /compute/me/jobs", () => {
  it("parses a page and its cursor", () => {
    const page = parseComputeJobs(jobsPage1.body);
    expect(page.jobs).toHaveLength(2);
    expect(page.next_after).toBe(jobsPage1.body.next_after);
    expect(page.jobs[0]).toMatchObject({ kind: "batch", cancel_requested: false });
  });

  it("parses the last page, whose cursor is null", () => {
    expect(parseComputeJobs(jobsEmpty.body)).toEqual({ jobs: [], next_after: null });
    expect(parseComputeJobs(jobsPage2.body).jobs).toHaveLength(2);
  });

  it("parses one job in each of the ten states and keeps cancel_requested", () => {
    const page = parseComputeJobs(jobsAll.body);
    const states = new Set(page.jobs.map((j) => j.state));
    for (const s of [
      "created",
      "uploading",
      "submitted",
      "queued",
      "running",
      "archiving",
      "finished",
      "failed",
      "cancelled",
      "unreported",
    ]) {
      expect(states.has(s), s).toBe(true);
    }
    expect(page.jobs.some((j) => j.cancel_requested)).toBe(true);
  });

  it("copies only the keys the page reads", () => {
    const page = parseComputeJobs(jobsPage1.body);
    expect(Object.keys(page.jobs[0]).sort()).toEqual(
      [
        "id",
        "kind",
        "source",
        "state",
        "app_id",
        "app_version",
        "partition",
        "pool",
        "created_at",
        "started_at",
        "ended_at",
        "charged_milli",
        "failure_code",
        "cancel_requested",
      ].sort(),
    );
  });

  it("treats an empty jobs list as different from a rejected body", () => {
    expect(parseComputeJobs(jobsEmpty.body).jobs).toEqual([]);
    for (const bad of [
      { jobs: "none", next_after: null },
      { next_after: null },
      { jobs: [] }, // next_after absent: not 'last page'
      { jobs: [{ ...jobsPage1.body.jobs[0], charged_milli: 1.5 }], next_after: null },
      { jobs: [{ ...jobsPage1.body.jobs[0], cancel_requested: "no" }], next_after: null },
      { jobs: [{ ...jobsPage1.body.jobs[0], id: 7 }], next_after: null },
      { jobs: [{ ...jobsPage1.body.jobs[0], started_at: undefined }], next_after: null },
    ]) {
      expect(() => parseComputeJobs(bad)).toThrow(ComputeApiError);
    }
  });

  it("builds the URL, and an after cursor containing | round-trips exactly", async () => {
    const cursor = jobsPage1.body.next_after as string;
    expect(cursor).toContain("|");
    const { fn, seen } = answering(json(jobsPage2.body));
    await listComputeJobs({ after: cursor }, { fetch: fn });
    const url = new URL(seen[0].url, "http://x.test");
    expect(url.pathname).toBe("/api/v1/compute/me/jobs");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("after")).toBe(cursor);
    expect(seen[0].url).toContain("%7C");
  });

  it("refuses a limit the route would refuse, before sending", () => {
    for (const limit of [0, 101, 1.5, -1]) {
      expect(() => listComputeJobs({ limit })).toThrow(RangeError);
    }
  });
});

describe("where the call goes", () => {
  it("uses the proxy in the browser and the API directly with a cookie", () => {
    expect(computeUrl("/me", new URLSearchParams())).toBe("/api/v1/compute/me");
    expect(computeUrl("/me", new URLSearchParams(), "nemar_session=abc")).toMatch(
      /^https?:\/\/.+\/compute\/me$/,
    );
  });

  it("sends the visitor's cookie on the SSR path and asks for JSON", async () => {
    const { fn, seen } = answering(json(meActive.body));
    await getComputeMe({ fetch: fn, cookieHeader: "nemar_session=abc" });
    expect((seen[0].init.headers as Record<string, string>).Cookie).toBe("nemar_session=abc");
    expect((seen[0].init.headers as Record<string, string>).Accept).toBe("application/json");
    expect(seen[0].init.method).toBe("GET");
  });
});

describe("errors", () => {
  it("maps no session to `session`", async () => {
    const { fn } = answering(json(errors.no_credential.body, 401));
    const err = await failure(getComputeMe({ fetch: fn }));
    expect(err).toMatchObject({ kind: "session", status: 401 });
  });

  it("maps an unapproved account to `account` with the backend's message", async () => {
    const { fn } = answering(json(errors.account_not_approved.body, 403));
    const err = await failure(getComputeMe({ fetch: fn }));
    expect(err.kind).toBe("account");
    expect(err.sentence).toBe(errors.account_not_approved.body.message);
  });

  it.each([
    ["invalid_cursor", 400],
    ["invalid_limit", 400],
    ["invalid_state", 400],
    ["invalid_group", 400],
    ["invalid_range", 400],
  ] as const)("reads %s from `code` and the sentence from `error`", async (code, status) => {
    const body = errors[code].body;
    const { fn } = answering(json(body, status));
    const err = await failure(getComputeMe({ fetch: fn }));
    expect(err.kind).toBe("rejected");
    expect(err.code).toBe(code);
    expect(err.sentence).toBe(body.error);
  });

  it("maps a 404 and a 5xx to `unavailable`", async () => {
    expect(
      (await failure(getComputeMe({ fetch: answering(json({ error: "not_found" }, 404)).fn })))
        .kind,
    ).toBe("unavailable");
    expect(
      (await failure(getComputeMe({ fetch: answering(json({ error: "boom" }, 500)).fn }))).kind,
    ).toBe("unavailable");
  });

  it("maps policy_unavailable (503) to `unavailable` and keeps the code", async () => {
    const body = { error: "The policy could not be read.", code: "policy_unavailable" };
    const err = await failure(getComputeMe({ fetch: answering(json(body, 503)).fn }));
    expect(err).toMatchObject({ kind: "unavailable", code: "policy_unavailable", status: 503 });
  });

  it("takes a proxy transport word as a code, not as a sentence to show", async () => {
    const err = await failure(
      getComputeMe({ fetch: answering(json({ error: "upstream_unreachable" }, 502)).fn }),
    );
    expect(err.kind).toBe("unavailable");
    expect(err.code).toBe("upstream_unreachable");
    expect(err.sentence).toBeUndefined();
  });

  it("survives a 502 with no JSON body", async () => {
    const res = new Response("<html>Bad gateway</html>", { status: 502 });
    const err = await failure(getComputeMe({ fetch: answering(res).fn }));
    expect(err).toMatchObject({ kind: "unavailable", status: 502 });
    expect(err.sentence).toBeUndefined();
  });

  it("maps a 200 that is not JSON to `shape`", async () => {
    const res = new Response("not json", { status: 200 });
    expect((await failure(getComputeMe({ fetch: answering(res).fn }))).kind).toBe("shape");
  });

  it("maps a 200 with a wrong body to `shape`", async () => {
    const err = await failure(getComputeMe({ fetch: answering(json({ pools: [] })).fn }));
    expect(err.kind).toBe("shape");
  });

  it("maps a refused connection to `network` and a missed deadline to `timeout`", async () => {
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect((await failure(getComputeMe({ fetch: refused }))).kind).toBe("network");
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    expect((await failure(getComputeMe({ fetch: slow, timeoutMs: 5 }))).kind).toBe("timeout");
  });

  it("lets a caller's own abort through untouched", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = ((_url: string, init: RequestInit) =>
      Promise.reject(init.signal?.reason)) as unknown as typeof fetch;
    await expect(
      getComputeMe({ fetch: aborted, signal: controller.signal }),
    ).rejects.not.toBeInstanceOf(ComputeApiError);
  });
});
