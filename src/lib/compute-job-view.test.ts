/**
 * The job page's pure view models (phase E3, website#496). Job records are the real ones captured from
 * the backend (`scripts/capture-compute-job-fixtures.mjs`); the clock is always an argument.
 */
import { describe, expect, it } from "vitest";
import cancelFx from "../../test/fixtures/compute/cancel.json";
import jobCancelRequested from "../../test/fixtures/compute/job-cancel-requested.json";
import jobFailureCodes from "../../test/fixtures/compute/job-failure-codes.json";
import jobStale from "../../test/fixtures/compute/job-stale.json";
import jobStates from "../../test/fixtures/compute/job-states.json";
import {
  ComputeApiError,
  type ComputeJobRead,
  parseComputeCancel,
  parseComputeJob,
} from "./compute-api";
import { COMPUTE_JOB_STATES } from "./compute-contract";
import {
  POLL_BASE_MS,
  POLL_ERROR_LIMIT,
  POLL_HARD_STOP_MS,
  POLL_MAX_MS,
  type PollEvent,
  type PollState,
  RESULTS_EXPIRING_DAYS,
  RESULT_ROWS_STEP,
  canCancel,
  cancelOutcome,
  initialPoll,
  isLive,
  isLoopbackHost,
  isTerminal,
  jobDetailView,
  linksExpired,
  linksOutliveFiles,
  logFailure,
  nextPoll,
  resultRow,
  resultsFailure,
  resultsPaging,
  resultsPanelView,
  resultsWindow,
  safeResultHref,
  timeline,
} from "./compute-job-view";
import { chargeText } from "./compute-view";

const DAY = 86_400_000;
const read = (state: string): ComputeJobRead =>
  parseComputeJob((jobStates as unknown as Record<string, { body: unknown }>)[state].body);
const statuses = (t: ReturnType<typeof timeline>) =>
  Object.fromEntries(t.steps.map((s) => [s.key, s.status]));

describe("isTerminal, isLive, canCancel", () => {
  it("sort the ten states into live and terminal, and an unknown state into neither", () => {
    const terminal = COMPUTE_JOB_STATES.filter(isTerminal);
    expect(terminal).toEqual(["finished", "failed", "cancelled"]);
    expect(COMPUTE_JOB_STATES.filter(isLive)).toEqual([
      "created",
      "uploading",
      "submitted",
      "queued",
      "running",
      "archiving",
      "unreported",
    ]);
    expect([isTerminal("weird"), isLive("weird")]).toEqual([false, false]);
  });

  it("offers cancel for every live state with no cancel recorded and for nothing else", () => {
    for (const state of COMPUTE_JOB_STATES) {
      expect([state, canCancel({ state, cancel_requested: false })]).toEqual([
        state,
        isLive(state),
      ]);
      expect([state, canCancel({ state, cancel_requested: true })]).toEqual([state, false]);
    }
    expect(canCancel({ state: "weird", cancel_requested: false })).toBe(false);
  });

  it("hides cancel on the captured job whose cancel is recorded", () => {
    const view = jobDetailView(parseComputeJob(jobCancelRequested.running.body));
    expect([view.canCancel, view.cancelRequested]).toEqual([false, true]);
  });
});

describe("timeline", () => {
  it("marks earlier steps passed and the current one current, for each live state", () => {
    const order = ["created", "submitted", "queued", "running", "archiving"];
    for (const [state, at] of [
      ["created", 0],
      ["uploading", 0],
      ["submitted", 1],
      ["queued", 2],
      ["running", 3],
      ["archiving", 4],
    ] as const) {
      const s = statuses(timeline(read(state).job));
      for (const [i, key] of order.entries()) {
        expect([state, key, s[key]]).toEqual([
          state,
          key,
          i < at ? "passed" : i === at ? "current" : "pending",
        ]);
      }
      expect(s.terminal).toBe("pending");
    }
  });

  it("calls the first step Uploading while a bundle is uploading", () => {
    expect(timeline(read("uploading").job).steps[0].label).toBe("Uploading");
    expect(timeline(read("created").job).steps[0].label).toBe("Created");
  });

  it("passes every step for a finished job and ends on Finished with its end time", () => {
    const t = timeline(read("finished").job);
    expect(Object.values(statuses(t)).slice(0, 5)).toEqual(Array(5).fill("passed"));
    const last = t.steps.at(-1);
    expect([last?.label, last?.status, last?.time?.text]).toEqual([
      "Finished",
      "current",
      "2026-11-05 09:50 UTC",
    ]);
  });

  it("shows only the three times the record carries", () => {
    const t = timeline(read("finished").job);
    const times = Object.fromEntries(t.steps.map((s) => [s.key, s.time?.text ?? null]));
    expect(times).toEqual({
      created: "2026-11-05 09:00 UTC",
      submitted: null,
      queued: null,
      running: "2026-11-05 09:10 UTC",
      archiving: null,
      terminal: "2026-11-05 09:50 UTC",
    });
    expect(t.steps.find((s) => s.key === "running")?.time?.label).toBe("Started");
  });

  it("never claims Archiving for a failed or canceled job and passes Running only if it started", () => {
    const failed = statuses(timeline(read("failed").job));
    expect(failed).toMatchObject({
      created: "passed",
      submitted: "passed",
      queued: "passed",
      running: "passed",
      archiving: "unknown",
      terminal: "current",
    });
    const cancelledNeverStarted = statuses(timeline(read("cancelled").job));
    expect(cancelledNeverStarted).toMatchObject({
      created: "passed",
      submitted: "unknown",
      queued: "unknown",
      running: "unknown",
      archiving: "unknown",
      terminal: "current",
    });
    const cancelledAfterStart = statuses(
      timeline({ ...read("cancelled").job, started_at: "2026-11-05 09:10:00" }),
    );
    expect(cancelledAfterStart.running).toBe("passed");
    expect(cancelledAfterStart.archiving).toBe("unknown");
  });

  it("puts unreported on no step: through Running if it started, else only Created", () => {
    const t = timeline(read("unreported").job);
    expect(t.unreported).toBe(true);
    expect(statuses(t)).toMatchObject({
      created: "passed",
      submitted: "unknown",
      terminal: "unknown",
    });
    const started = statuses(
      timeline({ ...read("unreported").job, started_at: "2026-11-05 09:10:00" }),
    );
    expect(started).toMatchObject({ created: "passed", running: "passed", archiving: "unknown" });
    expect(Object.values(started)).not.toContain("current");
  });

  it("shows an unknown state as its escaped word and draws no line", () => {
    const t = timeline({ ...read("running").job, state: "pa‮us\u0000ed" });
    expect(t.steps).toEqual([]);
    expect(t.unknownState).toBe("pa\\u202eus\\x00ed");
  });

  it("gives every step a word as well as an icon", () => {
    for (const state of COMPUTE_JOB_STATES) {
      for (const step of timeline(read(state).job).steps) {
        expect(step.statusWord.length, `${state} ${step.key}`).toBeGreaterThan(0);
        expect(step.icon.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("jobDetailView", () => {
  it("lists resources in order with real figures", () => {
    const v = jobDetailView(read("finished"));
    expect(v.rows.map((r) => [r.key, r.value])).toEqual([
      ["partition", "shared (CPU)"],
      ["nodes", "1"],
      ["cores", "4"],
      ["memory", "8,192 MB"],
      ["runtime", "up to 1h 0m"],
      ["created", "2026-11-05 09:00 UTC"],
      ["started", "2026-11-05 09:10 UTC"],
      ["ended", "2026-11-05 09:50 UTC"],
    ]);
    expect(v.rows.find((r) => r.key === "created")?.time?.iso).toBe("2026-11-05T09:00:00Z");
  });

  it("omits GPUs at zero, memory when null, and times that are not there", () => {
    const keys = jobDetailView(read("queued")).rows.map((r) => r.key);
    expect(keys).not.toContain("gpus");
    expect(keys).not.toContain("memory");
    expect(keys).not.toContain("started");
    expect(keys).not.toContain("ended");
    const gpu = read("running");
    const withGpu = jobDetailView({
      ...gpu,
      job: { ...gpu.job, pool: "gpu", resources: { ...gpu.job.resources, gpus: 2 } },
    });
    expect(withGpu.rows.find((r) => r.key === "gpus")?.value).toBe("2");
    expect(withGpu.rows[0].value).toBe("shared (GPU)");
  });

  it("charges with three decimals for a settled job and says not charged yet for a live one", () => {
    expect(jobDetailView(read("finished")).charge).toEqual({ text: "2.500", kind: "terminal" });
    expect(jobDetailView(read("cancelled")).charge).toEqual({ text: "0.000", kind: "terminal" });
    expect(jobDetailView(read("running")).charge).toEqual({
      text: "Not charged yet",
      kind: "live",
    });
    const odd = read("running");
    expect(chargeText({ state: "weird", charged_milli: 0 })).toEqual({
      text: "Not known",
      kind: "unknown",
    });
    expect(chargeText({ state: "weird", charged_milli: 1500 }).text).toBe("1.500");
    expect(jobDetailView({ ...odd, job: { ...odd.job, charged_milli: 1500 } }).charge.text).toBe(
      "1.500",
    );
  });

  it("carries the failure sentence for each captured failure code, and none without one", () => {
    for (const [code, entry] of Object.entries(jobFailureCodes)) {
      if (code === "_provenance") continue;
      const v = jobDetailView(parseComputeJob((entry as { body: unknown }).body));
      expect(v.failure?.code, code).toBe(code);
      expect(v.failure?.known, code).toBe(true);
    }
    expect(jobDetailView(read("finished")).failure).toBeNull();
  });

  it("carries the shared unreported note only for that state, and the units note always", () => {
    expect(jobDetailView(read("unreported")).unreportedNote).toMatch(/not heard from the cluster/);
    expect(jobDetailView(read("running")).unreportedNote).toBeNull();
    expect(jobDetailView(read("running")).unitsNote).toBe("Amounts are service units (SU).");
  });

  it("carries stale from the read", () => {
    expect(jobDetailView(parseComputeJob(jobStale.submitted.body)).stale).toBe(true);
    expect(jobDetailView(read("running")).stale).toBe(false);
  });

  it("escapes every backend string it prints", () => {
    const r = read("running");
    const v = jobDetailView({
      ...r,
      job: {
        ...r.job,
        id: "job_‮",
        app_id: "a\u0000b",
        partition: "p​q",
        name: "n‮x",
        source: "wild\u0007",
      },
    });
    expect([v.id, v.app, v.title, v.frontDoor]).toEqual([
      "job_\\u202e",
      "a\\x00b",
      "n\\u202ex",
      "wild\\x07",
    ]);
    expect(v.rows[0].value).toContain("p\\u200bq");
  });
});

describe("resultsWindow", () => {
  const ended = "2026-11-05 09:50:00";
  const endedMs = Date.UTC(2026, 10, 5, 9, 50);
  const input = (nowMs: number, over: Record<string, unknown> = {}) => ({
    state: "finished",
    endedAt: ended,
    resultsDays: 30,
    nowMs,
    ...over,
  });

  it("is available well before, expiring in the last three days, and still available at the instant", () => {
    const until = endedMs + 30 * DAY;
    expect(resultsWindow(input(endedMs)).state).toBe("available");
    expect(resultsWindow(input(until - RESULTS_EXPIRING_DAYS * DAY - 1)).state).toBe("available");
    expect(resultsWindow(input(until - RESULTS_EXPIRING_DAYS * DAY)).state).toBe("expiring");
    expect(resultsWindow(input(until - 1)).state).toBe("expiring");
    // The backend's rule is a strict `now > ended + days`: the instant itself is not expired.
    expect(resultsWindow(input(until)).state).toBe("expiring");
    expect(resultsWindow(input(until + 1)).state).toBe("expired");
  });

  it("states the date and the days left", () => {
    const w = resultsWindow(input(endedMs));
    expect(w.untilText).toBe("2026-12-05 09:50 UTC");
    expect(w.untilIso).toBe("2026-12-05T09:50:00.000Z");
    expect(w.daysLeft).toBe(30);
    expect(resultsWindow(input(endedMs + 30 * DAY - 1)).daysLeft).toBe(1);
  });

  it("derives nothing without an end time or a policy value", () => {
    for (const over of [{ endedAt: null }, { resultsDays: null }, { endedAt: "garbage" }]) {
      const w = resultsWindow(input(endedMs, over));
      expect([w.state, w.untilMs, w.untilText]).toEqual(["available", null, null]);
    }
  });

  it("is not_ready until the job finishes and none for a job that cannot have results", () => {
    for (const state of [
      "created",
      "uploading",
      "submitted",
      "queued",
      "running",
      "archiving",
      "unreported",
      "weird",
    ]) {
      expect(resultsWindow(input(endedMs, { state })).state).toBe("not_ready");
    }
    for (const state of ["failed", "cancelled"]) {
      expect(resultsWindow(input(endedMs, { state })).state).toBe("none");
    }
  });

  it("keeps the button in every finished state, including derived expired (the 410 decides)", () => {
    expect(resultsPanelView(input(endedMs + 31 * DAY)).canGetLinks).toBe(true);
    expect(resultsPanelView(input(endedMs + 31 * DAY)).headline).toMatch(/may already be deleted/);
    expect(resultsPanelView(input(endedMs, { state: "running" })).canGetLinks).toBe(false);
    expect(resultsPanelView(input(endedMs, { state: "failed" })).canGetLinks).toBe(false);
  });

  it("shows the download-everything line only while the job has results to download", () => {
    expect(resultsPanelView(input(endedMs)).showCliLine).toBe(true);
    expect(resultsPanelView(input(endedMs + 29 * DAY)).showCliLine).toBe(true); // expiring
    expect(resultsPanelView(input(endedMs + 31 * DAY)).showCliLine).toBe(false); // expired
    for (const state of ["failed", "cancelled", "running", "queued"]) {
      expect(resultsPanelView(input(endedMs, { state })).showCliLine, state).toBe(false);
    }
    // No retention figure known: the results are still there.
    expect(resultsPanelView(input(endedMs, { resultsDays: null })).showCliLine).toBe(true);
  });

  it("words the retention line from the days and the date, or generally without them", () => {
    expect(resultsPanelView(input(endedMs)).headline).toBe(
      "Results are kept for 30 days after the job ends, until 2026-12-05 09:50 UTC.",
    );
    expect(resultsPanelView(input(endedMs, { resultsDays: null })).headline).toBe(
      "Results are kept for a limited time.",
    );
    expect(resultsPanelView(input(endedMs, { resultsDays: 4 })).headline).toContain("4 days after");
  });
});

describe("resultsFailure and logFailure", () => {
  const err = (kind: ComputeApiError["kind"], status: number, code?: string, sentence?: string) =>
    new ComputeApiError(kind, status, code, sentence);

  it("maps a 410 to the expired state with the days, and a 409 to no files", () => {
    const e = resultsFailure(
      err("rejected", 410, "results_expired", "The results of this job have expired."),
      30,
    );
    expect(e.kind).toBe("expired");
    expect(e.sentence).toContain("deleted after 30 days");
    expect(e.sentence).toContain("keeps the job's record");
    expect(resultsFailure(err("rejected", 410, "results_expired"), null).sentence).toContain(
      "deleted.",
    );
    expect(resultsFailure(err("rejected", 409, "bad_state"), 30).kind).toBe("not_ready");
    expect(resultsFailure(err("rejected", 409, "bad_state"), 30, "cli").sentence).toBe(
      "NEMAR has no result files for this job.",
    );
    // A partner job's files are the person's only once NEMAR has checked it, as for the log.
    expect(resultsFailure(err("rejected", 409, "bad_state"), 30, "partner").sentence).toMatch(
      /appear once NEMAR has checked the job/,
    );
  });

  it("maps a 404 job_not_found to not-found and a bare 404 to a message", () => {
    expect(resultsFailure(err("unavailable", 404, "job_not_found"), 30).kind).toBe("not_found");
    expect(logFailure(err("unavailable", 404, "job_not_found"), "cli").kind).toBe("not_found");
    expect(resultsFailure(err("unavailable", 404), 30).kind).toBe("message");
  });

  it("maps session and account and shows the backend sentence escaped", () => {
    expect(resultsFailure(err("session", 401), 30).kind).toBe("session");
    expect(resultsFailure(err("account", 403, undefined, "x"), 30).kind).toBe("account");
    const m = resultsFailure(err("unavailable", 503, "storage_unavailable", "bad‮"), 30);
    expect(m.sentence).toContain("bad\\u202e");
  });

  it("says no log yet, with the partner note for a partner job, and storage trouble plainly", () => {
    const none = err("unavailable", 404, "logs_not_available");
    expect(logFailure(none, "cli")).toEqual({ kind: "none", sentence: "No log yet." });
    expect(logFailure(none, "partner").sentence).toMatch(
      /partner job's log appears once NEMAR has checked/,
    );
    expect(logFailure(err("unavailable", 503, "storage_unavailable"), "cli").sentence).toBe(
      "The log could not be read just now. Try again.",
    );
    expect(logFailure(err("timeout", 0), "cli").kind).toBe("message");
    expect(logFailure(new Error("x"), "cli").kind).toBe("message");
  });
});

describe("result rows", () => {
  it("accepts https and loopback http, and nothing else", () => {
    expect(safeResultHref("https://store.example/x?sig=1")).toBe("https://store.example/x?sig=1");
    // Plain http on loopback only when the page itself is on a loopback host (the local backend).
    expect(safeResultHref("http://127.0.0.1:9000/a", true)).toBe("http://127.0.0.1:9000/a");
    expect(safeResultHref("http://localhost/a", true)).toBe("http://localhost/a");
    expect(safeResultHref("http://127.0.0.1:9000/a")).toBeNull();
    expect(safeResultHref("http://localhost/a", false)).toBeNull();
    // The flag never opens a non-loopback http link.
    expect(safeResultHref("http://evil.example/a", true)).toBeNull();
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("app.nemar.org")).toBe(false);
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>1</script>",
      "http://evil.example/a",
      "file:///etc/passwd",
      "//evil.example/a",
      "not a url",
      "",
      "vbscript:x",
      "blob:https://x/y",
    ]) {
      expect(safeResultHref(bad), bad).toBeNull();
    }
  });

  it("escapes the path and the checksum and formats the size", () => {
    const row = resultRow({
      path: "a‮/b\u0000.txt",
      size: 11,
      sha256: "ab".repeat(32),
      url: "javascript:1",
    });
    expect(row.path).toBe("a\\u202e/b\\x00.txt");
    expect(row.size).toBe("11 B");
    expect(row.shaShort).toBe("abababababab");
    expect(row.sha.length).toBe(64);
    expect(row.href).toBeNull();
  });

  it("offers 100 more rows from the held page, then the next page by cursor, then nothing", () => {
    const base = { total: 2500, nextAfter: "out/x" as string | null };
    expect(resultsPaging({ ...base, held: 1000, shown: 100, offset: 0 })).toEqual({
      showMore: RESULT_ROWS_STEP,
      nextPageRemaining: null,
    });
    expect(resultsPaging({ ...base, held: 1000, shown: 950, offset: 0 }).showMore).toBe(50);
    expect(resultsPaging({ ...base, held: 1000, shown: 1000, offset: 0 })).toEqual({
      showMore: 0,
      nextPageRemaining: 1500,
    });
    expect(
      resultsPaging({ ...base, held: 1000, shown: 1000, offset: 1000 }).nextPageRemaining,
    ).toBe(500);
    expect(resultsPaging({ total: 3, nextAfter: null, held: 3, shown: 3, offset: 0 })).toEqual({
      showMore: 0,
      nextPageRemaining: null,
    });
  });

  it("knows when links have expired, and treats an unreadable date as expired", () => {
    const at = "2026-11-14T15:35:07.000Z";
    const ms = Date.parse(at);
    expect(linksExpired(at, ms - 1)).toBe(false);
    expect(linksExpired(at, ms)).toBe(true);
    expect(linksExpired("garbage", ms)).toBe(true);
  });

  it("says when a link outlives the files", () => {
    const at = "2026-11-14T15:35:07.000Z";
    expect(linksOutliveFiles(at, Date.parse(at) - 1)).toBe(true);
    expect(linksOutliveFiles(at, Date.parse(at) + 1)).toBe(false);
    expect(linksOutliveFiles(at, null)).toBe(false);
  });
});

describe("cancelOutcome", () => {
  const fx = (k: keyof typeof cancelFx) =>
    cancelOutcome(parseComputeCancel((cancelFx[k] as { body: unknown }).body));

  it("words every captured answer", () => {
    expect(fx("running")).toMatchObject({ kind: "canceled", poll: false });
    expect(fx("running_again").kind).toBe("canceled");
    expect(fx("never_started").kind).toBe("canceled");
    expect(fx("cluster_down")).toMatchObject({ kind: "recorded", poll: true });
    expect(fx("cluster_down_again").kind).toBe("recorded");
    const ended = fx("finished");
    expect(ended.kind).toBe("ended");
    expect(ended.sentence).toBe("The job had already ended (finished); nothing was canceled.");
    expect(ended.poll).toBe(false);
  });

  it("words the rows the stand-in cannot make", () => {
    const live = { state: "running", outcome: "already_cancelled", cancelled: true };
    expect(cancelOutcome(live).kind).toBe("already_recorded");
    expect(cancelOutcome({ ...live, outcome: "cancel_requested" }).kind).toBe("recorded");
    // An older Worker has no `cancelled`: the outcome decides.
    expect(cancelOutcome({ ...live, outcome: "cancel_requested", cancelled: null }).kind).toBe(
      "recorded",
    );
    expect(cancelOutcome({ state: "failed", outcome: "already_ended", cancelled: null }).kind).toBe(
      "ended",
    );
    expect(
      cancelOutcome({ state: null, outcome: "already_ended", cancelled: false }).sentence,
    ).toContain("unknown");
    expect(
      cancelOutcome({ state: "running", outcome: "something_new", cancelled: true }).kind,
    ).toBe("unknown");
  });

  it("always asks for the job to be read again and promises no amount", () => {
    for (const k of ["running", "cluster_down", "finished"] as const) {
      expect(fx(k).refresh).toBe(true);
      expect(fx(k).sentence).not.toMatch(/refund|SU|charged/i);
    }
  });
});

describe("nextPoll", () => {
  const read = (state: string, changed = false): PollEvent => ({ kind: "read", state, changed });
  const drive = (events: PollEvent[], start = 0, random = 0.5) => {
    let state: PollState = initialPoll(start);
    const steps = [];
    for (const e of events) {
      const out = nextPoll(state, e, start + 1000, random);
      state = out.next;
      steps.push(out.step);
    }
    return { steps, state };
  };

  it("starts at 10 s and doubles to 60 s while nothing changes", () => {
    const { steps } = drive(Array(6).fill(read("running")));
    expect(steps.map((s) => (s as { delayMs: number }).delayMs)).toEqual([
      20_000, 40_000, 60_000, 60_000, 60_000, 60_000,
    ]);
    expect(initialPoll(0).delayMs).toBe(POLL_BASE_MS);
  });

  it("resets to 10 s on a change", () => {
    const { steps } = drive([
      read("running"),
      read("running"),
      read("archiving", true),
      read("archiving"),
    ]);
    expect(steps.map((s) => (s as { delayMs: number }).delayMs)).toEqual([
      20_000, 40_000, 10_000, 20_000,
    ]);
  });

  it("stops on a terminal state, whatever the schedule before it was", () => {
    for (const state of ["finished", "failed", "cancelled"]) {
      for (const changed of [true, false]) {
        const { steps } = drive([read("running"), read("running", true), read(state, changed)]);
        expect(steps[2], `${state} ${changed}`).toEqual({ action: "stop", reason: "terminal" });
      }
    }
  });

  it("stays stopped: no event restarts a stopped poller", () => {
    let state = nextPoll(initialPoll(0), read("finished", true), 5).next;
    for (const e of [
      read("running", true),
      { kind: "visible", sinceLastReadMs: 99_999 } as PollEvent,
      { kind: "error" } as PollEvent,
    ]) {
      const out = nextPoll(state, e, 10);
      expect(out.step).toEqual({ action: "stop", reason: "terminal" });
      state = out.next;
    }
  });

  it("stops on a state this build does not know", () => {
    expect(nextPoll(initialPoll(0), read("weird"), 5).step).toEqual({
      action: "stop",
      reason: "unknown_state",
    });
  });

  it("keeps polling an unreported job: it may resume", () => {
    expect(nextPoll(initialPoll(0), read("unreported"), 5).step.action).toBe("wait");
  });

  it("doubles on an error, and the fifth error in a row stops", () => {
    const { steps } = drive(Array(POLL_ERROR_LIMIT).fill({ kind: "error" } as PollEvent));
    expect(steps.slice(0, 4).map((s) => (s as { delayMs: number }).delayMs)).toEqual([
      20_000, 40_000, 60_000, 60_000,
    ]);
    expect(steps[4]).toEqual({ action: "stop", reason: "errors" });
  });

  it("counts only consecutive errors: a good read clears them", () => {
    const e = { kind: "error" } as PollEvent;
    const { steps } = drive([e, e, e, e, read("running", true), e, e, e, e]);
    expect(steps.every((s) => s.action === "wait")).toBe(true);
  });

  it("stops on a 401 and on a not-found", () => {
    expect(nextPoll(initialPoll(0), { kind: "error", fatal: "session" }, 5).step).toEqual({
      action: "stop",
      reason: "session",
    });
    expect(nextPoll(initialPoll(0), { kind: "error", fatal: "not_found" }, 5).step).toEqual({
      action: "stop",
      reason: "not_found",
    });
  });

  it("pauses when the tab is hidden, and refreshes at once on becoming visible after 5 s", () => {
    expect(nextPoll(initialPoll(0), { kind: "hidden" }, 5).step).toEqual({ action: "pause" });
    expect(nextPoll(initialPoll(0), { kind: "visible", sinceLastReadMs: 5_001 }, 5).step).toEqual({
      action: "refresh_now",
    });
    expect(
      nextPoll(initialPoll(0), { kind: "visible", sinceLastReadMs: 5_000 }, 5).step.action,
    ).toBe("wait");
  });

  it("restarts the schedule at 10 s after a pause", () => {
    let state = drive([read("running"), read("running"), read("running")]).state;
    expect(state.delayMs).toBe(60_000);
    state = nextPoll(state, { kind: "visible", sinceLastReadMs: 60_000 }, 5).next;
    expect(state.delayMs).toBe(POLL_BASE_MS);
  });

  it("stops two hours after load, at exactly the boundary and not before", () => {
    const s = initialPoll(1000);
    expect(nextPoll(s, read("running"), 1000 + POLL_HARD_STOP_MS - 1).step.action).toBe("wait");
    expect(nextPoll(s, read("running"), 1000 + POLL_HARD_STOP_MS).step).toEqual({
      action: "stop",
      reason: "hard_stop",
    });
    expect(
      nextPoll(s, { kind: "visible", sinceLastReadMs: 1e9 }, 1000 + POLL_HARD_STOP_MS).step.action,
    ).toBe("stop");
  });

  it("moves each delay by at most 15 percent", () => {
    for (const [random, expected] of [
      [0, 8_500],
      [0.5, 10_000],
      [0.999999, 11_500],
    ] as const) {
      const out = nextPoll(initialPoll(0), read("running", true), 5, random);
      expect((out.step as { delayMs: number }).delayMs).toBe(expected);
    }
    expect(POLL_MAX_MS).toBe(60_000);
  });
});
