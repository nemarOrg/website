/**
 * The admin Pipelines tab's view models, over the fixtures captured from the REAL nemar-cli routes
 * (`scripts/capture-compute-pipeline-fixtures.mjs`). A word the backend cannot be made to send at
 * this commit (an unknown mark or status) is built inline and says so.
 */

import { describe, expect, it } from "vitest";
import coverageFixture from "../../test/fixtures/compute/admin-pipeline-coverage.json";
import gridFixture from "../../test/fixtures/compute/admin-pipeline-grid.json";
import runFixture from "../../test/fixtures/compute/admin-pipeline-run.json";
import { parseCoverage, parseGridPage, parseRunDetail } from "./compute-pipeline-api";
import {
  COMPUTE_PIPELINE_CELL_MARKS,
  COMPUTE_PIPELINE_GRID_STATUSES,
} from "./compute-pipeline-contract";
import {
  cellHref,
  cellView,
  checkpointAnchor,
  d1Time,
  executorText,
  parseDaysParam,
  parseGridQuery,
  parseRecipeParam,
  parseStampParam,
  pipelineCoverageCards,
  pipelinePager,
  statusCounts,
  statusPill,
  summaryLine,
  trendSums,
} from "./compute-pipeline-view";

const grid = parseGridPage(gridFixture.all.body);
const row = (id: string) => {
  const r = grid.rows.find((x) => x.dataset_id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};

describe("words", () => {
  it("gives every status the grid serves its own tone and the CLI's word", () => {
    const tones = Object.fromEntries(
      COMPUTE_PIPELINE_GRID_STATUSES.map((w) => [w, statusPill(w).tone]),
    );
    expect(tones).toEqual({
      not_started: "neutral",
      waiting: "neutral",
      running: "info",
      stalled: "warning",
      finished: "success",
      failed: "danger",
    });
    expect(statusPill("not_started").label).toBe("not started");
    for (const r of grid.rows) expect(statusPill(r.status).known).toBe(true);
  });

  it("draws every mark the grid serves with the CLI's code", () => {
    const seen = new Map<string, string>();
    for (const r of grid.rows) {
      for (const c of Object.values(r.cells)) if (c) seen.set(c.mark, cellView(c).code);
    }
    expect([...seen.keys()].sort()).toEqual([...COMPUTE_PIPELINE_CELL_MARKS].sort());
    expect(Object.fromEntries(seen)).toEqual({
      not_started: "-",
      waiting: "W",
      running: "R",
      stalled: "S",
      failed: "F1",
      skipped: "x",
      pending: "P",
      passed: "",
      no_counts: "?",
    });
  });

  it("says a cell in words for a screen reader", () => {
    const finished = row("nm099105");
    expect(cellView(finished.cells.import ?? null).spoken).toBe("3 of 4 passed, 1 failed");
    expect(cellView(row("nm099106").cells.import ?? null).spoken).toBe("2 of 2 passed");
    expect(cellView(null)).toMatchObject({ code: "?", spoken: "unreadable", known: false });
    // As the CLI: a passed cell with no counts prints a dash, never nothing.
    const bare = { mark: "passed", counts: null, reconciled: true, disagreement: false, listed: 0 };
    expect(cellView(bare).code).toBe("-");
  });

  it("draws an unknown word neutral and escaped, never as a known one", () => {
    // Built inline: no mark or status the backend sends at this commit is unknown.
    const odd = cellView({
      mark: "evil‮mark",
      counts: { passed: 1, failed: 0, skipped: 0, total: 2 },
      reconciled: true,
      disagreement: false,
      listed: 0,
    });
    expect(odd.known).toBe(false);
    expect(odd.tone).toBe("neutral");
    expect(odd.code).not.toContain("‮");
    expect(odd.counts).toBe("1/2");
    const pill = statusPill("sleeping");
    expect([pill.known, pill.tone, pill.label]).toEqual([false, "neutral", "sleeping"]);
  });

  it("prints a D1 time as served, with its zone, and never parses it", () => {
    expect(d1Time("2026-11-20 09:30:00")).toBe("2026-11-20 09:30:00 UTC");
    expect(d1Time(null)).toBe("none");
  });

  it("names the executor by runner name, then executor, then a dash", () => {
    expect(executorText(row("nm099108"))).toBe("ws_b");
    expect(executorText(row("nm099105"))).toBe("tapis");
    expect(executorText(row("nm099101"))).toBe("-");
  });
});

describe("links", () => {
  it("anchors only standard checkpoints", () => {
    expect(checkpointAnchor("import")).toBe("cp-import");
    expect(checkpointAnchor("stored")).toBe("cp-stored");
    expect(checkpointAnchor('x"onload')).toBeNull();
  });

  it("links a cell to its run only when it has failures to show", () => {
    const finished = row("nm099105");
    const stamp = finished.run?.stamp_id;
    expect(cellHref(finished, "import")).toBe(`/admin/pipelines/runs/${stamp}#cp-import`);
    expect(cellHref(row("nm099106"), "import")).toBeNull();
    expect(cellHref(row("nm099101"), "import")).toBeNull();
    expect(cellHref(row("nm099105"), "constructor")).toBeNull();
  });

  it("pages forward and back to the first page, keeping the filters", () => {
    const one = parseGridPage(gridFixture.page_one.body);
    const q = parseGridQuery("nemar-floor", new URLSearchParams("limit=2&status=running")).query;
    const p = pipelinePager("nemar-floor", q, one.next_after);
    expect(p.next).toBe("/admin/pipelines/nemar-floor?status=running&limit=2&after=nm099102");
    expect(p.first).toBeNull();
    const two = parseGridQuery(
      "nemar-floor",
      new URLSearchParams("limit=2&status=running&after=nm099102"),
    ).query;
    expect(pipelinePager("nemar-floor", two, null)).toEqual({
      next: null,
      first: "/admin/pipelines/nemar-floor?status=running&limit=2",
    });
    // A cursor that is not a dataset id is the Worker's word: no link is built from it.
    expect(pipelinePager("nemar-floor", q, '"><script>').next).toBeNull();
  });
});

describe("queries", () => {
  it("keeps a valid filter and names every one it drops", () => {
    const ok = parseGridQuery(
      "nemar-floor",
      new URLSearchParams(
        "status=failed&recipe_version=1.0.0-b1&executor=runner&runner=rnr_abababababababababababab&dataset=nm099101&after=nm099100&limit=50",
      ),
    );
    expect(ok.ignored).toEqual([]);
    expect(ok.query).toMatchObject({ status: "failed", limit: 50, executor: "runner" });
    const bad = parseGridQuery(
      "nemar-floor",
      new URLSearchParams(
        "status=sleeping&recipe_version=a/b&executor=moon&runner=rnr_x&dataset=EVIL&after=<x>&limit=501",
      ),
    );
    expect(bad.ignored).toEqual([
      "status",
      "recipe_version",
      "executor",
      "runner",
      "dataset",
      "after",
      "limit",
    ]);
    expect(Object.values(bad.query).filter((v) => v !== undefined)).toEqual(["nemar-floor"]);
  });

  it("drops a runner asked for with the Tapis executor, and says why", () => {
    const r = parseGridQuery(
      "nemar-floor",
      new URLSearchParams("executor=tapis&runner=rnr_abababababababababababab"),
    );
    expect([r.query.runner, r.query.executor, r.runnerWithTapis]).toEqual([
      undefined,
      "tapis",
      true,
    ]);
    expect(r.ignored).toEqual(["runner"]);
  });

  it("reads a stamp id, a recipe and a day count, or nothing", () => {
    expect(parseStampParam("0")).toBeNull();
    expect(parseStampParam("1")).toBe(1);
    expect(parseStampParam("1234567890123456")).toBe(1234567890123456);
    expect(parseStampParam("12345678901234567")).toBeNull();
    expect(parseStampParam("9007199254740993")).toBeNull();
    expect(parseStampParam("abc")).toBeNull();
    expect(parseRecipeParam("nemar-floor")).toBe("nemar-floor");
    expect(parseRecipeParam("../x")).toBeNull();
    expect([parseDaysParam("7"), parseDaysParam("0"), parseDaysParam("91")]).toEqual([
      7,
      undefined,
      undefined,
    ]);
  });
});

describe("cards", () => {
  const cov = parseCoverage(coverageFixture.default.body);

  it("hides placeholder recipes on the overview and keeps them on the landing page", () => {
    expect(pipelineCoverageCards(cov, { placeholders: false }).map((c) => c.key)).toEqual([
      "pipeline.nemar-floor",
    ]);
    const all = pipelineCoverageCards(cov, { placeholders: true });
    expect(all.map((c) => [c.key, c.placeholder])).toEqual([
      ["pipeline.nemar-floor", false],
      ["pipeline.nemar-ica", true],
    ]);
  });

  it("states coverage, the failed runs over the trend, and links the grid", () => {
    const [floor] = pipelineCoverageCards(cov, { placeholders: false });
    expect(floor.value).toBe("33.3%");
    expect(floor.href).toBe("/admin/pipelines/nemar-floor");
    expect(floor.context).toContain("1 failed of 2 ended in 30 days");
    expect(floor.spark?.cadence).toBe("daily");
    expect(trendSums(cov.recipes[0].trend)).toEqual({ failed: 1, ended: 2 });
  });

  it("says no eligible datasets instead of a zero percent", () => {
    // Built inline: a recipe with no eligible datasets.
    const empty = { ...cov, recipes: [{ ...cov.recipes[0], eligible: 0, covered: 0 }] };
    const [c] = pipelineCoverageCards(empty, { placeholders: true });
    expect([c.value, c.muted]).toEqual(["No eligible datasets", true]);
  });

  it("prints the summary line as the CLI does, and counts statuses in grid order", () => {
    expect(summaryLine(grid.summary)).toBe(
      "nemar-floor 1.0.0-b1: covered 2 of 8 eligible (25%), complete 1, at any recipe version 2",
    );
    expect(statusCounts(grid.summary.by_status).map((s) => s.word)).toEqual([
      ...COMPUTE_PIPELINE_GRID_STATUSES,
    ]);
    // Built inline: a status word this build does not know is counted but never a link.
    const odd = statusCounts({ ...grid.summary.by_status, sleeping: 2 });
    expect(odd.at(-1)).toEqual({ word: "sleeping", count: 2, known: false });
    expect(odd.slice(0, -1).every((s) => s.known)).toBe(true);
  });
});

describe("the run", () => {
  it("reads what each captured run says it leaves out", () => {
    const many = parseRunDetail(runFixture.unlisted.body);
    const imp = many.checkpoints.find((c) => c.checkpoint === "import");
    expect([imp?.listed, imp?.unlisted]).toEqual([10, 2]);
    const unreadable = parseRunDetail(runFixture.unreadable.body);
    expect(unreadable.checkpoints[0].failures_unreadable).toBe(true);
  });
});
