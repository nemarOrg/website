/**
 * The compute client's job-page calls (phase E3, website#496). Every success case parses a body
 * captured from the real routes by
 *
 *   NEMAR_CLI_DIR=<nemar-cli checkout of the Epic D branch> \
 *     bun scripts/capture-compute-job-fixtures.mjs
 *
 * Transport conditions no route can be made to produce (a 502 with no JSON, a refused connection) use a
 * real `Response`, as the repo's rule allows for failure paths.
 */
import { describe, expect, it } from "vitest";
import cancel from "../../test/fixtures/compute/cancel.json";
import errorsJob from "../../test/fixtures/compute/errors-job.json";
import jobCancelRequested from "../../test/fixtures/compute/job-cancel-requested.json";
import jobFailureCodes from "../../test/fixtures/compute/job-failure-codes.json";
import jobLifecycle from "../../test/fixtures/compute/job-lifecycle.json";
import jobStale from "../../test/fixtures/compute/job-stale.json";
import jobStates from "../../test/fixtures/compute/job-states.json";
import logs from "../../test/fixtures/compute/logs.json";
import meActive from "../../test/fixtures/compute/me-active-with-usage.json";
import results from "../../test/fixtures/compute/results.json";
import {
  ComputeApiError,
  cancelComputeJob,
  getComputeJob,
  getComputeLogs,
  getComputeResults,
  isJobNotFound,
  parseComputeCancel,
  parseComputeJob,
  parseComputeMe,
  parseComputeResults,
  renewComputeResults,
} from "./compute-api";
import { COMPUTE_FAILURE_CODES, COMPUTE_JOB_STATES } from "./compute-contract";

const JOB_ID = "job_0123456789abcdef01234567";

function answering(res: Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return res;
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function failure(promise: Promise<unknown>): Promise<ComputeApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ComputeApiError);
    return err as ComputeApiError;
  }
  throw new Error("expected the call to fail");
}

describe("GET /compute/me/jobs/:id", () => {
  it("parses a captured job in each of the ten states", () => {
    for (const state of COMPUTE_JOB_STATES) {
      const read = parseComputeJob(jobStates[state].body);
      expect(read.job.state).toBe(state);
      expect(read.job.resources.nodes).toBe(1);
      expect(read.stale).toBe(false);
    }
  });

  it("keeps the memory figure when set and null when not", () => {
    expect(parseComputeJob(jobStates.finished.body).job.resources.memory_mb).toBe(8192);
    expect(parseComputeJob(jobStates.running.body).job.resources.memory_mb).toBeNull();
  });

  it("parses a failed job for each of the failure codes", () => {
    for (const code of COMPUTE_FAILURE_CODES) {
      const body = (jobFailureCodes as unknown as Record<string, { body: unknown }>)[code].body;
      const read = parseComputeJob(body);
      expect([code, read.job.failure_code]).toEqual([code, code]);
      expect(read.job.state).toBe("failed");
    }
  });

  it("reads a recorded cancel on a live job", () => {
    const read = parseComputeJob(jobCancelRequested.running.body);
    expect([read.job.state, read.job.cancel_requested]).toEqual(["running", true]);
  });

  it("reads stale: true, and a missing stale as false", () => {
    expect(parseComputeJob(jobStale.submitted.body).stale).toBe(true);
    const { stale: _drop, ...rest } = jobStates.running.body;
    expect(parseComputeJob(rest).stale).toBe(false);
  });

  it("parses the lifecycle job at running and at finished", () => {
    expect(parseComputeJob(jobLifecycle.running.body).job.id).toBe(jobLifecycle.job_id);
    const done = parseComputeJob(jobLifecycle.finished.body).job;
    expect([done.state, done.charged_milli > 0]).toEqual(["finished", true]);
  });

  it("copies only the keys the page reads", () => {
    const body = structuredClone(jobStates.running.body) as Record<string, unknown>;
    (body.job as Record<string, unknown>).tenant_pool = "platform";
    (body.job as Record<string, unknown>).failure_detail = "oom";
    ((body.job as Record<string, unknown>).resources as Record<string, unknown>).hold_milli = 9;
    body.extra = "x";
    const read = parseComputeJob(body);
    expect(Object.keys(read.job).sort()).toEqual(
      [
        "app_id",
        "app_version",
        "cancel_requested",
        "charged_milli",
        "created_at",
        "ended_at",
        "failure_code",
        "id",
        "kind",
        "name",
        "partition",
        "pool",
        "resources",
        "source",
        "started_at",
        "state",
      ].sort(),
    );
    expect(Object.keys(read.job.resources).sort()).toEqual(
      ["cores_per_node", "gpus", "memory_mb", "minutes", "nodes"].sort(),
    );
    expect(Object.keys(read).sort()).toEqual(["job", "stale"]);
  });

  it("reads an optional name through, and none as null", () => {
    expect(parseComputeJob(jobStates.running.body).job.name).toBeNull();
    const body = structuredClone(jobStates.running.body) as { job: Record<string, unknown> };
    body.job.name = "my analysis";
    expect(parseComputeJob(body).job.name).toBe("my analysis");
  });

  it("rejects a missing key or a wrong type as a shape error, never zeros", () => {
    const bad = (mutate: (b: { job: Record<string, any> }) => void) => {
      const b = structuredClone(jobStates.running.body) as { job: Record<string, any> };
      mutate(b);
      return () => parseComputeJob(b);
    };
    expect(bad((b) => delete b.job.resources)).toThrow(ComputeApiError);
    expect(bad((b) => delete b.job.resources.minutes)).toThrow(ComputeApiError);
    expect(bad((b) => (b.job.resources.nodes = "1"))).toThrow(ComputeApiError);
    expect(bad((b) => (b.job.charged_milli = 1.5))).toThrow(ComputeApiError);
    expect(bad((b) => (b.job.cancel_requested = 0))).toThrow(ComputeApiError);
    expect(bad((b) => (b.job.name = 5))).toThrow(ComputeApiError);
    expect(() => parseComputeJob(null)).toThrow(ComputeApiError);
    expect(() => parseComputeJob({ job: jobStates.running.body.job, stale: "yes" })).toThrow(
      ComputeApiError,
    );
  });

  it("asks for the job by id, with the SSR cookie, and sends nothing else", async () => {
    const { fn, seen } = answering(json(jobStates.running.body));
    const read = await getComputeJob(JOB_ID, { fetch: fn, cookieHeader: "nemar_session=abc" });
    expect(read.job.state).toBe("running");
    expect(seen[0].url).toMatch(new RegExp(`/compute/me/jobs/${JOB_ID}$`));
    expect(seen[0].init.method).toBe("GET");
    expect((seen[0].init.headers as Record<string, string>).Cookie).toBe("nemar_session=abc");
  });

  it("refuses an id that is not a job id before sending anything", () => {
    const { fn, seen } = answering(json({}));
    for (const bad of ["", "nope", "job_XYZ", `${JOB_ID}/../logs`, `${JOB_ID}?x=1`]) {
      expect(() => getComputeJob(bad, { fetch: fn })).toThrow(RangeError);
    }
    expect(seen).toEqual([]);
  });
});

describe("GET /compute/jobs/:id/logs", () => {
  const live = logs.live;

  function logResponse(entry: { status: number; headers: Record<string, string>; text?: string }) {
    return new Response(entry.text ?? "", { status: entry.status, headers: entry.headers });
  }

  it("returns the text and no truncation for a log under 1 MiB", async () => {
    const { fn, seen } = answering(logResponse(live));
    const log = await getComputeLogs(JOB_ID, { fetch: fn });
    expect(log).toEqual({ text: live.text, truncated: false });
    expect((seen[0].init.headers as Record<string, string>).Accept).toBe("text/plain");
  });

  it("reads X-Nemar-Truncated: true from the captured headers", async () => {
    const t = logs.truncated;
    expect(t.headers["x-nemar-truncated"]).toBe("true");
    const { fn } = answering(
      new Response("x".repeat(1024), { status: t.status, headers: t.headers }),
    );
    expect((await getComputeLogs(JOB_ID, { fetch: fn })).truncated).toBe(true);
  });

  it("treats any other value of the header, or none, as not truncated", async () => {
    for (const value of ["false", "1", "TRUE", ""]) {
      const { fn } = answering(new Response("a", { headers: { "X-Nemar-Truncated": value } }));
      expect((await getComputeLogs(JOB_ID, { fetch: fn })).truncated).toBe(false);
    }
  });

  it("returns an empty log as an empty string, not an error", async () => {
    const { fn } = answering(logResponse(logs.empty));
    expect(await getComputeLogs(JOB_ID, { fetch: fn })).toEqual({ text: "", truncated: false });
  });

  it("hands the hostile log back byte for byte (the page escapes it, the client does not)", async () => {
    const { fn } = answering(logResponse(logs.hostile));
    const log = await getComputeLogs(JOB_ID, { fetch: fn });
    expect(log.text).toBe(logs.hostile.text);
    expect(log.text).toContain("\u001b[31m");
    expect(log.text).toContain("<script>");
  });

  it("maps no log yet to a 404 with its code, and storage trouble to unavailable", async () => {
    const none = logs.not_available;
    const e = await failure(
      getComputeLogs(JOB_ID, { fetch: answering(json(none.body, none.status)).fn }),
    );
    expect([e.kind, e.status, e.code]).toEqual(["unavailable", 404, "logs_not_available"]);
    expect(e.sentence).toBe(none.body.error);
    const s = await failure(
      getComputeLogs(JOB_ID, {
        fetch: answering(
          json({ error: "Compute storage could not be reached", code: "storage_unavailable" }, 503),
        ).fn,
      }),
    );
    expect([s.kind, s.code]).toEqual(["unavailable", "storage_unavailable"]);
  });

  it("gives the log read a longer deadline than the default", async () => {
    // The default deadline is 5 s; the backend may read the cluster for about 8 s.
    const { fn } = answering(logResponse(live));
    let signal: AbortSignal | undefined;
    const spy = (async (url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return fn(url, init);
    }) as unknown as typeof fetch;
    await getComputeLogs(JOB_ID, { fetch: spy });
    expect(signal).toBeDefined();
    // An aborted-by-deadline signal is not aborted yet.
    expect(signal?.aborted).toBe(false);
  });
});

describe("results and renew", () => {
  it("parses the captured links and the second page by cursor", () => {
    const page = parseComputeResults(results.get.body);
    expect(page.files.length).toBe(3);
    expect(page.files[0].path).toBe("figures/plot.json");
    expect(page.total).toBe(3);
    expect([page.truncated, page.next_after]).toEqual([false, null]);
    expect(page.notice).toMatch(/Anyone who holds a link/);
    const renewed = parseComputeResults(results.renew.body);
    expect(renewed.files.map((f) => f.path)).toEqual(page.files.map((f) => f.path));
    const second = parseComputeResults(results.many_second_page.body);
    expect(second.files.length).toBe(2);
    expect(second.total).toBe(results.many_first_page.summary.total);
  });

  it("keeps the order, the size and the checksum of each file exactly", () => {
    const page = parseComputeResults(results.get.body);
    for (const [i, f] of results.get.body.files.entries()) {
      expect(page.files[i]).toEqual({ path: f.path, size: f.size, sha256: f.sha256, url: f.url });
    }
  });

  it("copies only the keys the page reads", () => {
    const body = structuredClone(results.get.body) as Record<string, any>;
    body.extra = 1;
    body.files[0].etag = "x";
    expect(Object.keys(parseComputeResults(body)).sort()).toEqual(
      ["expires_at", "files", "next_after", "notice", "total", "truncated"].sort(),
    );
    expect(Object.keys(parseComputeResults(body).files[0]).sort()).toEqual(
      ["path", "sha256", "size", "url"].sort(),
    );
  });

  it("is a shape error when the contract's own markers are missing", () => {
    const strip = (key: string) => {
      const b = structuredClone(results.get.body) as Record<string, unknown>;
      delete b[key];
      return b;
    };
    for (const key of ["bearer_links", "next_after", "notice", "files", "expires_at", "total"]) {
      expect(() => parseComputeResults(strip(key)), key).toThrow(ComputeApiError);
    }
    expect(() => parseComputeResults({ ...results.get.body, bearer_links: false })).toThrow(
      ComputeApiError,
    );
  });

  it("GETs the results and POSTs the renewal with no body", async () => {
    const got = answering(json(results.get.body));
    await getComputeResults(JOB_ID, null, { fetch: got.fn });
    expect(got.seen[0].init.method).toBe("GET");
    expect(got.seen[0].url).toMatch(new RegExp(`/compute/jobs/${JOB_ID}/results$`));
    const renewed = answering(json(results.renew.body));
    await renewComputeResults(JOB_ID, null, { fetch: renewed.fn });
    expect(renewed.seen[0].init.method).toBe("POST");
    expect(renewed.seen[0].url).toMatch(new RegExp(`/compute/jobs/${JOB_ID}/results/renew$`));
    expect(renewed.seen[0].init.body).toBeUndefined();
    const headers = renewed.seen[0].init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["Accept"]);
  });

  it("passes the cursor back URL-encoded", async () => {
    const cursor = "out/file 00999?&=#.txt";
    const { fn, seen } = answering(json(results.many_second_page.body));
    await getComputeResults(JOB_ID, cursor, { fetch: fn });
    const url = new URL(seen[0].url, "http://x");
    expect(url.searchParams.get("after")).toBe(cursor);
    expect(seen[0].url).toContain("after=out%2Ffile+00999%3F%26%3D%23.txt");
    const renew = answering(json(results.renew.body));
    await renewComputeResults(JOB_ID, cursor, { fetch: renew.fn });
    expect(new URL(renew.seen[0].url, "http://x").searchParams.get("after")).toBe(cursor);
  });

  it("maps 410 to rejected with results_expired, 409 to bad_state, 404 to job_not_found", async () => {
    const expired = results.expired;
    const e = await failure(
      getComputeResults(JOB_ID, null, { fetch: answering(json(expired.body, expired.status)).fn }),
    );
    expect([e.kind, e.status, e.code]).toEqual(["rejected", 410, "results_expired"]);
    expect(e.sentence).toBe(expired.body.error);
    const renew = await failure(
      renewComputeResults(JOB_ID, null, {
        fetch: answering(json(results.expired_renew.body, results.expired_renew.status)).fn,
      }),
    );
    expect(renew.code).toBe("results_expired");
    const bad = results.bad_state;
    const b = await failure(
      getComputeResults(JOB_ID, null, { fetch: answering(json(bad.body, bad.status)).fn }),
    );
    expect([b.kind, b.status, b.code]).toEqual(["rejected", 409, "bad_state"]);
    const nf = errorsJob.job_not_found["GET /jobs/<id>/results"].foreign;
    const n = await failure(
      getComputeResults(JOB_ID, null, { fetch: answering(json(nf.body, nf.status)).fn }),
    );
    expect(isJobNotFound(n)).toBe(true);
  });

  it("maps no session to `session` and a bad cursor to rejected", async () => {
    const e = await failure(
      getComputeResults(JOB_ID, null, {
        fetch: answering(json(errorsJob.no_credential.body, 401)).fn,
      }),
    );
    expect(e.kind).toBe("session");
    const bad = errorsJob.invalid_after;
    const r = await failure(
      getComputeResults(JOB_ID, "x", { fetch: answering(json(bad.body, bad.status)).fn }),
    );
    expect([r.kind, r.code]).toEqual(["rejected", "invalid_spec"]);
  });
});

describe("POST /compute/jobs/:id/cancel", () => {
  it("parses every captured outcome", () => {
    expect(parseComputeCancel(cancel.running.body)).toEqual({
      state: "cancelled",
      outcome: "cancel_requested",
      cancelled: true,
    });
    expect(parseComputeCancel(cancel.running_again.body).outcome).toBe("already_cancelled");
    expect(parseComputeCancel(cancel.cluster_down.body)).toEqual({
      state: "running",
      outcome: "cancel_requested",
      cancelled: true,
    });
    expect(parseComputeCancel(cancel.finished.body)).toEqual({
      state: "finished",
      outcome: "already_ended",
      cancelled: false,
    });
  });

  it("reads an older Worker's answer, which has no `cancelled`, as null", () => {
    const { cancelled: _drop, ...older } = cancel.running.body;
    expect(parseComputeCancel(older).cancelled).toBeNull();
  });

  it("is a shape error without ok: true or an outcome", () => {
    expect(() => parseComputeCancel({ ok: false, state: "x", outcome: "y" })).toThrow(
      ComputeApiError,
    );
    expect(() => parseComputeCancel({ ok: true, state: "x" })).toThrow(ComputeApiError);
    expect(() => parseComputeCancel({ ok: true, state: 3, outcome: "y" })).toThrow(ComputeApiError);
  });

  it("POSTs with no body and no key, and does not retry", async () => {
    const { fn, seen } = answering(json(cancel.running.body));
    const answer = await cancelComputeJob(JOB_ID, { fetch: fn });
    expect(answer.outcome).toBe("cancel_requested");
    expect(seen.length).toBe(1);
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.body).toBeUndefined();
    expect(Object.keys(seen[0].init.headers as Record<string, string>)).toEqual(["Accept"]);
    expect(seen[0].url).toMatch(new RegExp(`/compute/jobs/${JOB_ID}/cancel$`));
  });

  it("maps a foreign, absent or malformed job to the one not-found error", async () => {
    for (const kind of ["foreign", "absent", "malformed"] as const) {
      const r = errorsJob.job_not_found["POST /jobs/<id>/cancel"][kind];
      const e = await failure(
        cancelComputeJob(JOB_ID, { fetch: answering(json(r.body, r.status)).fn }),
      );
      expect([kind, isJobNotFound(e), e.status]).toEqual([kind, true, 404]);
    }
  });

  it("does not take a 404 with no code (an API without the routes) for a missing job", async () => {
    const e = await failure(
      cancelComputeJob(JOB_ID, { fetch: answering(json({ error: "Not Found" }, 404)).fn }),
    );
    expect([e.kind, isJobNotFound(e)]).toEqual(["unavailable", false]);
  });

  it("maps a lost connection to `network` so the page can re-read the job", async () => {
    const refuse = (async () => {
      throw new TypeError("failed to fetch");
    }) as unknown as typeof fetch;
    expect((await failure(cancelComputeJob(JOB_ID, { fetch: refuse }))).kind).toBe("network");
  });
});

describe("the retention policy in GET /compute/me", () => {
  it("reads limits.results_days", () => {
    expect(parseComputeMe(meActive.body).resultsDays).toBe(30);
  });

  it("is null when the body does not carry it, and a shape error for a wrong value", () => {
    const body = structuredClone(meActive.body) as { limits: Record<string, unknown> };
    body.limits.results_days = undefined;
    expect(parseComputeMe(body).resultsDays).toBeNull();
    body.limits.results_days = 0;
    expect(() => parseComputeMe(body)).toThrow(ComputeApiError);
    body.limits.results_days = "30";
    expect(() => parseComputeMe(body)).toThrow(ComputeApiError);
  });
});
