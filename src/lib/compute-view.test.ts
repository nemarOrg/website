/**
 * View models of the /compute page, on bodies captured from the real routes
 * (`bun scripts/capture-compute-read-fixtures.mjs` with NEMAR_CLI_DIR set; see the script header).
 * A few cases need a value no route can serve (a hostile app id, which the database refuses; a pool the
 * Worker has not announced). Those take a captured body and change the one field, parsed through the
 * same guard the page uses.
 */
import { describe, expect, it } from "vitest";
import jobsAll from "../../test/fixtures/compute/jobs-all-states.json";
import jobsPage1 from "../../test/fixtures/compute/jobs-page1.json";
import meActive from "../../test/fixtures/compute/me-active-with-usage.json";
import meFrozen from "../../test/fixtures/compute/me-frozen.json";
import meOverrun from "../../test/fixtures/compute/me-overrun.json";
import meStates from "../../test/fixtures/compute/me-states.json";
import meThin from "../../test/fixtures/compute/me-thin-queue.json";
import usageDay from "../../test/fixtures/compute/usage-day-partition.json";
import usageEmpty from "../../test/fixtures/compute/usage-empty.json";
import { ACCOUNT_COPY } from "./account-copy";
import {
  ComputeApiError,
  parseComputeJobs,
  parseComputeMe,
  parseComputeUsage,
} from "./compute-api";
import { COMPUTE_QUEUE_MIN_SAMPLES } from "./compute-contract";
import {
  accessView,
  balancesView,
  jobRowView,
  jobsView,
  noticeFor,
  panelsFor,
  queueView,
  usageView,
} from "./compute-view";

const me = (body: unknown) => parseComputeMe(body);

describe("panelsFor", () => {
  it("shows all five panels for an active account and reads the ledger", () => {
    expect(panelsFor("active")).toEqual({
      access: true,
      balances: true,
      usage: true,
      jobs: true,
      queue: true,
      readLedger: true,
    });
  });

  it("keeps history and balance read-only for a suspended or ended account, with no queue", () => {
    for (const state of ["suspended", "revoked"]) {
      expect(panelsFor(state), state).toEqual({
        access: true,
        balances: true,
        usage: true,
        jobs: true,
        queue: false,
        readLedger: true,
      });
    }
  });

  it("shows the Access panel alone, and reads nothing, for every other state", () => {
    for (const state of ["none", "requested", "denied", "paused", "constructor", "", null]) {
      const plan = panelsFor(state);
      expect(plan, String(state)).toEqual({
        access: true,
        balances: false,
        usage: false,
        jobs: false,
        queue: false,
        readLedger: false,
      });
    }
  });

  it("reads nothing for an unverified account whatever state it carries", () => {
    expect(panelsFor("active", { unverified: true }).readLedger).toBe(false);
    expect(panelsFor("active", { unverified: true }).balances).toBe(false);
  });
});

describe("noticeFor", () => {
  it("names the panel, says the figures are missing, and gives the reason class", () => {
    const n = noticeFor("Usage", new ComputeApiError("timeout", 0));
    expect(n.title).toBe("Could not load usage");
    expect(n.missing).toBe("The figures are missing, not zero.");
    expect(n.reason).toBe("The server did not answer in time.");
    expect(n.sentence).toBeNull();
  });

  it("carries the backend's sentence as escaped text, but not a shape error's own", () => {
    const rejected = noticeFor(
      "Jobs",
      new ComputeApiError(
        "rejected",
        400,
        "invalid_cursor",
        "after is not a cursor this route gave.‮",
      ),
    );
    expect(rejected.sentence).toBe("after is not a cursor this route gave.\\u202e");
    const shaped = noticeFor("Jobs", new ComputeApiError("shape", 200, undefined, "ours"));
    expect(shaped.sentence).toBeNull();
  });

  it("treats a builder's RangeError as an unexpected response, not a crash", () => {
    expect(noticeFor("Balances", new RangeError("x")).reason).toBe(
      "The server's answer was not in the expected form.",
    );
  });
});

describe("accessView", () => {
  it("none with requests closed says the terms are unpublished and offers no link", () => {
    const view = accessView("none", me(meStates.none.body));
    expect(view.badge.label).toBe("Not requested");
    expect(view.paragraphs).toEqual([ACCOUNT_COPY["compute_access.terms_unpublished.body"]]);
    expect(view.link).toBeNull();
  });

  it("none with requests open links the request card in Settings", () => {
    const view = accessView("none", me(meStates.none_requests_open.body));
    expect(view.link).toEqual({
      href: "/settings#compute-access",
      label: ACCOUNT_COPY["compute_access.request.cta"],
    });
    expect(view.paragraphs).toEqual([]);
  });

  it("falls back to terms_published when the API sends no requests_open", () => {
    const body = structuredClone(meStates.none.body) as { access: Record<string, unknown> };
    body.access.requests_open = undefined;
    body.access.terms_published = true;
    expect(accessView("none", me(body)).link).not.toBeNull();
    body.access.terms_published = false;
    expect(accessView("none", me(body)).link).toBeNull();
  });

  it("none says only the state when the account read failed", () => {
    const view = accessView("none", null);
    expect(view.paragraphs).toEqual([]);
    expect(view.link).toBeNull();
  });

  it("requested prints the dated lede and the body", () => {
    const view = accessView("requested", me(meStates.requested.body));
    expect(view.paragraphs).toEqual([
      "An admin is reviewing your request from Oct 20, 2026.",
      ACCOUNT_COPY["compute_access.requested.body"],
    ]);
  });

  it("requested falls back to the undated lede", () => {
    expect(accessView("requested", null).paragraphs[0]).toBe(
      ACCOUNT_COPY["compute_access.requested.lede"],
    );
  });

  it("suspended, denied and revoked use their own sentences", () => {
    expect(accessView("suspended", me(meStates.suspended.body)).paragraphs).toEqual([
      ACCOUNT_COPY["compute_access.suspended.body"],
    ]);
    for (const state of ["denied", "revoked"] as const) {
      expect(accessView(state, me(meStates[state].body)).paragraphs).toEqual([
        ACCOUNT_COPY["compute_access.closed.body"],
      ]);
    }
    expect(accessView("revoked", null).badge.label).toBe("Ended");
  });

  it("shows the frozen sentence only for an active account whose pool is frozen", () => {
    const frozen = me(meFrozen.body);
    expect(frozen.frozen).toBe(true);
    expect(accessView("active", frozen, { frozen: frozen.frozen }).paragraphs).toEqual([
      ACCOUNT_COPY["compute_page.frozen.body"],
    ]);
    expect(accessView("active", me(meActive.body), { frozen: false }).paragraphs).toEqual([]);
    // The CLI's rule, not the issue's: every other state already has its own sentence.
    for (const state of ["suspended", "revoked", "denied", "requested", "none"]) {
      expect(accessView(state, frozen, { frozen: true }).frozen, state).toBe(false);
    }
  });

  it("gives an active account the date it began", () => {
    expect(accessView("active", me(meActive.body)).grantedSince).toBe("Oct 24, 2026");
  });

  it("prints a state outside the six as inert raw text in a neutral badge, and decides nothing", () => {
    const view = accessView("paused‮", null);
    expect(view.known).toBe(false);
    expect(view.badge).toMatchObject({ label: "paused\\u202e", tone: "neutral" });
    expect(view.paragraphs).toEqual([]);
    expect(view.link).toBeNull();
    expect(accessView("constructor", null).known).toBe(false);
  });
});

describe("balancesView", () => {
  it("prints the CLI's digits for the active fixture, CPU then GPU", () => {
    const view = balancesView(me(meActive.body));
    expect(view.pools.map((p) => p.name)).toEqual(["CPU", "GPU"]);
    expect(view.pools[0].rows.map((r) => [r.label, r.text])).toEqual([
      ["Granted", "100.000"],
      ["Held", "20.000"],
      ["Charged", "40.200"],
      ["Available", "39.800"],
    ]);
    expect(view.pools[1].rows.map((r) => r.text)).toEqual(["40.000", "0.000", "15.250", "24.750"]);
    expect(view.pools[0].barPercent).toBeCloseTo(39.8, 3);
  });

  it("prints a negative available as negative, flagged, with an empty bar", () => {
    const view = balancesView(me(meOverrun.body));
    const cpu = view.pools[0];
    expect(cpu.rows.find((r) => r.key === "available")).toMatchObject({
      text: "-2.500",
      negative: true,
    });
    expect(cpu.negativeAvailable).toBe(true);
    expect(cpu.barPercent).toBe(0);
    expect(view.anyNegative).toBe(true);
  });

  it("says nothing was granted, with no bar, rather than a bar of NaN", () => {
    const view = balancesView(me(meStates.active.body));
    expect(view.pools.every((p) => p.nothingGranted && p.barPercent === null)).toBe(true);
    expect(view.pools[0].rows.map((r) => r.text)).toEqual(["0.000", "0.000", "0.000", "0.000"]);
  });

  it("carries the units and available notes from the shared copy", () => {
    expect(balancesView(me(meActive.body)).notes).toEqual([
      ACCOUNT_COPY["compute_page.units_note"],
      ACCOUNT_COPY["compute_page.available_note"],
    ]);
  });

  it("never renders a pool the Worker adds, a shared allocation or a platform figure", () => {
    const body = {
      ...meActive.body,
      pools: {
        ...meActive.body.pools,
        tenant: {
          granted_milli: 777_000,
          held_milli: 0,
          charged_milli: 0,
          available_milli: 777_000,
        },
      },
      platform_remaining_milli: 123_456,
      shared_allocation: { granted_milli: 888_000 },
    };
    const view = balancesView(me(body));
    expect(view.pools).toHaveLength(2);
    const text = JSON.stringify(view);
    for (const leaked of ["777", "123.456", "888", "tenant", "platform", "shared"]) {
      expect(text, leaked).not.toContain(leaked);
    }
    expect(view.pools.map((p) => p.pool)).toEqual(["cpu", "gpu"]);
  });
});

describe("queueView", () => {
  it("prints durations for a partition with figures, and 0s for a real zero", () => {
    const view = queueView(me(meActive.body));
    const shared = view.rows.find((r) => r.partition === "shared");
    expect(shared).toMatchObject({
      median: "40s",
      p90: "1h 1m",
      counted: "7 in 7 days",
      thin: false,
    });
    const gpuShared = view.rows.find((r) => r.partition === "gpu-shared");
    expect(gpuShared).toMatchObject({ median: "0s", p90: "0s", thin: false });
  });

  it("reads 'Not enough data' with the count and the minimum when a figure is null", () => {
    const view = queueView(me(meThin.body));
    const compute = view.rows.find((r) => r.partition === "compute");
    expect(COMPUTE_QUEUE_MIN_SAMPLES).toBe(5);
    expect(compute).toMatchObject({
      median: "Not enough data",
      p90: "Not enough data",
      counted: "3 of 5 in 7 days",
      thin: true,
    });
    for (const row of view.rows) {
      for (const cell of [row.median, row.p90, row.counted]) {
        expect(cell).not.toBe("-");
        expect(cell).not.toBe("");
        expect(cell).not.toBe("0");
      }
    }
  });

  it("a partition nobody has waited on yet shows a count of 0 of 5, not a dash", () => {
    const view = queueView(me(meThin.body));
    expect(view.rows.find((r) => r.partition === "debug")?.counted).toBe("0 of 5 in 7 days");
  });

  it("says no partitions are offered for an empty queue", () => {
    const body = { ...meActive.body, queue: [] };
    const view = queueView(me(body));
    expect(view.empty).toBe(true);
    expect(view.emptyText).toBe("No partitions are offered right now.");
  });

  it("ends with the shared note, and never promises a wait", () => {
    const view = queueView(me(meActive.body));
    expect(view.note).toBe(ACCOUNT_COPY["compute_page.queue_note"]);
    expect(JSON.stringify(view)).not.toMatch(/estimated wait|your wait/i);
  });
});

describe("jobRowView", () => {
  const jobs = parseComputeJobs(jobsAll.body).jobs;
  const first = parseComputeJobs(jobsPage1.body).jobs[0];

  it("links a well-formed id and times it in UTC", () => {
    const row = jobRowView(first);
    expect(row.href).toBe(`/compute/jobs/${first.id}`);
    expect(row.createdIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(row.createdText).toMatch(/ UTC$/);
    expect(row.frontDoor).toBe("Command line");
  });

  it("prints a true zero for a finished job and 'Not charged yet' for a live one", () => {
    const base = jobs.find((j) => j.state === "running") as (typeof jobs)[number];
    expect(jobRowView({ ...base, charged_milli: 0 })).toMatchObject({
      charged: "Not charged yet",
      chargeKind: "live",
    });
    const finished = jobs.find((j) => j.state === "finished") as (typeof jobs)[number];
    expect(jobRowView({ ...finished, charged_milli: 0 })).toMatchObject({
      charged: "0.000",
      chargeKind: "terminal",
    });
    expect(jobRowView(finished).charged).toBe("2.500");
    const failed = jobs.find((j) => j.state === "failed") as (typeof jobs)[number];
    expect(jobRowView(failed).charged).toBe("0.000");
  });

  it("does not claim zero or 'not yet' for a state it does not know", () => {
    const row = jobRowView({ ...first, state: "paused", charged_milli: 0 });
    expect(row.chargeKind).toBe("unknown");
    expect(row.charged).toBe("Not known");
    expect(row.state).toMatchObject({ known: false, label: "paused", tone: "neutral" });
    expect(jobRowView({ ...first, state: "paused", charged_milli: 1500 }).charged).toBe("1.500");
  });

  it("marks a cancel request on a live job only", () => {
    const running = jobs.find((j) => j.cancel_requested) as (typeof jobs)[number];
    expect(jobRowView(running).cancelRequested).toBe(true);
    expect(jobRowView({ ...running, state: "finished" }).cancelRequested).toBe(false);
  });

  it("renders no link for an id that fails the pattern, rather than a guessed one", () => {
    for (const id of ["job_xyz", "../admin", `job_${"G".repeat(24)}`, "javascript:alert(1)", ""]) {
      expect(jobRowView({ ...first, id }).href, id).toBeNull();
    }
  });

  it("keeps hostile text inert: it is escaped, never interpreted", () => {
    const row = jobRowView({
      ...first,
      app_id: '<img src=x onerror="alert(1)">‮evil\u0007',
      app_version: "<b>1.0</b>",
      partition: "<script>",
      source: "<i>x</i>",
    });
    expect(row.app).toBe('<img src=x onerror="alert(1)">\\u202eevil\\x07');
    expect(row.app).not.toContain("‮");
    expect(row.appVersion).toBe("<b>1.0</b>");
    expect(row.frontDoor).toBe("<i>x</i>");
    // The strings are returned as strings; whether they are text is the renderers' contract
    // (test/compute-dashboard-ui.test.ts forbids every markup-writing API in the Compute files).
    expect(typeof row.app).toBe("string");
  });
});

describe("jobsView", () => {
  it("builds the no-JavaScript link with the cursor URL-encoded, and none on the last page", () => {
    const page = parseComputeJobs(jobsPage1.body);
    const view = jobsView(page);
    expect(page.next_after).toContain("|");
    expect(view.loadMoreHref).toBe(
      `/compute?after=${encodeURIComponent(page.next_after as string)}#jobs`,
    );
    expect(view.loadMoreHref).toContain("%7C");
    expect(jobsView({ jobs: page.jobs, next_after: null }).loadMoreHref).toBeNull();
  });

  it("distinguishes 'no jobs yet' from a failure", () => {
    const view = jobsView({ jobs: [], next_after: null });
    expect(view.empty).toBe(true);
    expect(view.rows).toEqual([]);
  });

  it("shows the unreported note once, only when a row is unreported", () => {
    expect(jobsView(parseComputeJobs(jobsAll.body)).showUnreportedNote).toBe(true);
    expect(jobsView(parseComputeJobs(jobsPage1.body)).showUnreportedNote).toBe(false);
    expect(jobsView(parseComputeJobs(jobsAll.body)).unreportedNote).toBe(
      ACCOUNT_COPY["compute_page.unreported_note"],
    );
  });
});

describe("usageView", () => {
  const active = me(meActive.body);
  const view = usageView(active, parseComputeUsage(usageDay.body));

  it("draws a chart per pool, never one chart that adds two currencies", () => {
    expect(view.pools.map((p) => p.name)).toEqual(["CPU", "GPU"]);
    expect(view.pools[0].chart.totalMilli).toBe(39_500);
    expect(view.pools[1].chart.totalMilli).toBe(14_500);
  });

  it("sets a correction that names no job aside instead of guessing its pool", () => {
    expect(view.aside).toMatchObject({
      label: "Adjustments and other partitions",
      totalText: "1.750 SU",
    });
    expect(view.aside?.rows).toEqual([{ day: "2026-10-30", partition: "No job", amount: "1.750" }]);
    for (const pool of view.pools) expect(pool.chart.totalMilli).not.toBe(41_250);
  });

  it("sets aside a partition that is no longer offered", () => {
    const usage = parseComputeUsage({
      ...usageDay.body,
      rows: [{ day: "2026-10-12", partition: "retired", charged_milli: 900, jobs: 1 }],
    });
    const v = usageView(active, usage);
    expect(v.aside?.rows[0]).toMatchObject({ partition: "retired", amount: "0.900" });
  });

  it("gives every bar a title, a legend total, and a table with exact amounts", () => {
    const cpu = view.pools[0];
    expect(cpu.barTitles).toHaveLength(30);
    expect(cpu.barTitles.find((t) => t.startsWith("Oct 12"))).toBe(
      "Oct 12: shared 4.000 SU, compute 12.500 SU, total 16.500 SU",
    );
    expect(cpu.legend.map((l) => l.name)).toEqual(["shared", "compute", "debug"]);
    expect(cpu.legend[2].totalText).toBe("0.200 SU");
    expect(cpu.table.headers).toEqual(["Day", "shared", "compute", "debug", "Total"]);
    expect(cpu.table.rows[0]).toEqual({
      label: "Oct 12",
      cells: ["4.000", "12.500", "0.000"],
      total: "16.500",
    });
    expect(cpu.negativeNote).not.toBeNull();
    expect(view.pools[1].negativeNote).toBeNull();
  });

  it("summarizes the chart in words: total, days with charges, busiest day", () => {
    expect(view.pools[0].summary).toBe(
      "CPU usage, 30 days, 39.500 SU charged on 5 days, busiest Oct 12 (16.500 SU).",
    );
  });

  it("for a fresh grant keeps the axis and says there are no charges", () => {
    const fresh = usageView(
      parseComputeMe({
        ...meActive.body,
        pools: {
          cpu: { granted_milli: 25_000, held_milli: 0, charged_milli: 0, available_milli: 25_000 },
          gpu: { granted_milli: 0, held_milli: 0, charged_milli: 0, available_milli: 0 },
        },
      }),
      parseComputeUsage(usageEmpty.body),
    );
    // The CPU pool was granted, so it is drawn (empty); the GPU pool has nothing ever, so it is not.
    expect(fresh.pools.map((p) => p.pool)).toEqual(["cpu"]);
    expect(fresh.pools[0].chart.empty).toBe(true);
    expect(fresh.pools[0].summary).toBe("CPU usage, 30 days, no charges.");
    expect(fresh.anyRows).toBe(false);
    expect(fresh.aside).toBeNull();
  });
});
