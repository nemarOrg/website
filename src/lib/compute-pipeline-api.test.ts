/**
 * The admin Pipelines client against fixtures captured from the REAL nemar-cli routes. Recapture:
 *
 *   NEMAR_CLI_DIR=<nemar-cli checkout of epic #2324> \
 *     bun scripts/capture-compute-pipeline-fixtures.mjs
 *
 * Nothing in the fixtures is hand-written; a case that needs a body the backend cannot be made to
 * produce (an extra key, a missing key, a broken cell) builds it inline from a fixture and says so.
 */

import { describe, expect, it } from "vitest";
import coverage from "../../test/fixtures/compute/admin-pipeline-coverage.json";
import grid from "../../test/fixtures/compute/admin-pipeline-grid.json";
import runs from "../../test/fixtures/compute/admin-pipeline-run.json";
import { ACCOUNT_COPY } from "./account-copy";
import { ComputeAdminApiError, computeAdminErrorText } from "./compute-admin-api";
import {
  getPipelineCoverage,
  getPipelineGrid,
  getPipelineRun,
  isNotAvailable,
  parsePipelineCell,
  pipelineGridSearch,
} from "./compute-pipeline-api";

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

/** A fetch that records each call and answers with one captured case. */
function replay(c: { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return json(c.body, c.status);
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("every captured answer parses", () => {
  it("reads every grid page the route served", async () => {
    for (const name of [
      "all",
      "page_one",
      "page_two",
      "status_failed",
      "runner",
      "empty_filter",
    ] as const) {
      const { fetchImpl, seen } = replay(grid[name]);
      const page = await getPipelineGrid({ recipe: "nemar-floor" }, { fetch: fetchImpl });
      expect(page.rows.length, name).toBe(grid[name].body.rows.length);
      expect(seen[0].url).toContain("/admin/compute/pipeline/grid?recipe=nemar-floor");
      expect(seen[0].init.method).toBe("GET");
    }
  });

  it("keeps every row, cell and facet of the full grid", async () => {
    const { fetchImpl } = replay(grid.all);
    const page = await getPipelineGrid({ recipe: "nemar-floor" }, { fetch: fetchImpl });
    expect(page.columns).toEqual(["import", "preprocess", "quality", "stored"]);
    expect(page.facets.runners).toEqual([{ id: "rnr_abababababababababababab", name: "ws_b" }]);
    const finished = page.rows.find((r) => r.dataset_id === "nm099105");
    expect(finished?.status).toBe("finished");
    expect(finished?.cells.import?.mark).toBe("failed");
    expect(finished?.cells.import?.counts).toEqual({ passed: 3, failed: 1, skipped: 0, total: 4 });
    expect(page.rows.find((r) => r.dataset_id === "nm099101")?.run).toBeNull();
    expect(page.matched.total).toBe(page.rows.length);
  });

  it("reads both coverage answers and a run in every captured shape", async () => {
    for (const c of [coverage.default, coverage.days_7]) {
      const { fetchImpl } = replay(c);
      const cov = await getPipelineCoverage(undefined, { fetch: fetchImpl });
      expect(cov.recipes.length).toBe(c.body.recipes.length);
      expect(cov.recipes[0].trend.length).toBe(cov.days);
    }
    for (const name of ["reconciled", "live", "unreadable", "unlisted"] as const) {
      const { fetchImpl, seen } = replay(runs[name]);
      const detail = await getPipelineRun(runs[name].body.run.stamp_id, { fetch: fetchImpl });
      expect(detail.checkpoints.length, name).toBe(runs[name].body.checkpoints.length);
      expect(seen[0].url).toMatch(/\/admin\/compute\/pipeline\/runs\/\d+$/);
    }
  });
});

describe("an open contract", () => {
  it("tolerates a key a newer Worker adds, at every level", async () => {
    // Built inline: the captured page plus keys the backend does not send at this commit.
    const body = clone(grid.all.body) as Record<string, unknown> & {
      rows: Record<string, unknown>[];
    };
    body.added = { anything: true };
    body.rows[0].added = 1;
    const { fetchImpl } = replay({ status: 200, body });
    const page = await getPipelineGrid({ recipe: "nemar-floor" }, { fetch: fetchImpl });
    expect(page.rows.length).toBe(grid.all.body.rows.length);
  });

  it("fails the whole answer when a required key is missing, never an empty list", async () => {
    const body = clone(grid.all.body) as Record<string, unknown>;
    body.rows = undefined;
    const { fetchImpl } = replay({ status: 200, body });
    const err = await getPipelineGrid({ recipe: "nemar-floor" }, { fetch: fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ComputeAdminApiError);
    expect(computeAdminErrorText(err)).toBe(ACCOUNT_COPY["compute_admin.error.malformed"]);
  });

  it("reads an unreadable cell as null and keeps the rest of the row", async () => {
    const body = clone(grid.all.body) as { rows: { cells: Record<string, unknown> }[] };
    body.rows[0].cells.import = { mark: 7 };
    const { fetchImpl } = replay({ status: 200, body });
    const page = await getPipelineGrid({ recipe: "nemar-floor" }, { fetch: fetchImpl });
    expect(page.rows[0].cells.import).toBeNull();
    expect(page.rows[0].cells.preprocess?.mark).toBe("not_started");
    expect(parsePipelineCell("x")).toBeNull();
  });
});

describe("the query", () => {
  it("sends only the keys the query names, and never a sync", () => {
    const all = pipelineGridSearch({
      recipe: "nemar-floor",
      recipe_version: "1.0.0-b1",
      executor: "runner",
      runner: "rnr_abababababababababababab",
      status: "failed",
      dataset: "nm099101",
      after: "nm099100",
      limit: 2,
    });
    expect([...all.keys()]).toEqual([
      "recipe",
      "recipe_version",
      "executor",
      "runner",
      "status",
      "dataset",
      "after",
      "limit",
    ]);
    // A caller that smuggles a sync key in through a cast still sends none.
    const smuggled = pipelineGridSearch({
      recipe: "nemar-floor",
      sync: "1",
    } as unknown as Parameters<typeof pipelineGridSearch>[0]);
    expect(smuggled.has("sync")).toBe(false);
    expect(pipelineGridSearch({ recipe: "nemar-floor", status: "" }).has("status")).toBe(false);
  });
});

describe("refusals and failures", () => {
  it("shows the backend's sentence for a refusal", async () => {
    for (const c of [grid.invalid_query, grid.recipe_unknown, runs.stamp_not_found]) {
      const { fetchImpl } = replay(c);
      const err = await getPipelineGrid({ recipe: "nemar-floor" }, { fetch: fetchImpl }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ComputeAdminApiError);
      expect((err as ComputeAdminApiError).code).toBe(c.body.code);
      expect(computeAdminErrorText(err)).toBe(c.body.error);
    }
  });

  it("calls a 404 with no code not available, and a timeout a timeout", async () => {
    // Built inline: an API that predates the pipeline routes answers the router's own 404.
    const { fetchImpl } = replay({ status: 404, body: { error: "Not Found" } });
    const err = await getPipelineCoverage(undefined, { fetch: fetchImpl }).catch((e: unknown) => e);
    expect(computeAdminErrorText(err)).toMatch(/not available/i);
    const timeout = new DOMException("timed out", "TimeoutError");
    expect(computeAdminErrorText(timeout)).toBe(ACCOUNT_COPY["compute_admin.error.timeout"]);
  });
});

describe("required keys that may be null", () => {
  it("fails the answer when a nullable key is absent, rather than reading it as null", async () => {
    // Built inline: the captured page without `next_after`, and a run without `outcome`.
    const page = clone(grid.all.body) as Record<string, unknown>;
    delete page.next_after;
    const err = await getPipelineGrid(
      { recipe: "nemar-floor" },
      { fetch: replay({ status: 200, body: page }).fetchImpl },
    ).catch((e: unknown) => e);
    expect(computeAdminErrorText(err)).toBe(ACCOUNT_COPY["compute_admin.error.malformed"]);
    const detail = clone(runs.reconciled.body) as { run: Record<string, unknown> };
    delete detail.run.outcome;
    const err2 = await getPipelineRun(1, {
      fetch: replay({ status: 200, body: detail }).fetchImpl,
    }).catch((e: unknown) => e);
    expect(computeAdminErrorText(err2)).toBe(ACCOUNT_COPY["compute_admin.error.malformed"]);
  });

  it("keeps a column whose name is an Object method as a plain column", async () => {
    // Built inline: a column named `constructor`.
    const body = clone(grid.all.body) as { rows: { cells: Record<string, unknown> }[] };
    body.rows[0].cells.constructor = body.rows[0].cells.import;
    const page = await getPipelineGrid(
      { recipe: "nemar-floor" },
      { fetch: replay({ status: 200, body }).fetchImpl },
    );
    expect(page.rows[0].cells.constructor?.mark).toBe("not_started");
    expect(Object.hasOwn(page.rows[1].cells, "constructor")).toBe(false);
  });
});

describe("what the pages rely on", () => {
  it("calls only the router's code-less 404 not available", async () => {
    // Built inline: the router's own answer to an unknown route (nemar-cli's notFound body).
    const notFound = await getPipelineCoverage(undefined, {
      fetch: replay({
        status: 404,
        body: {
          error: "Not Found",
          message: "Route GET /admin/compute/pipeline/coverage not found",
        },
      }).fetchImpl,
    }).catch((e: unknown) => e);
    expect(isNotAvailable(notFound)).toBe(true);
    for (const c of [runs.stamp_not_found, grid.recipe_unknown]) {
      const err = await getPipelineRun(1, { fetch: replay(c).fetchImpl }).catch((e: unknown) => e);
      expect(isNotAvailable(err), c.body.code).toBe(false);
    }
  });

  it("sends days only when asked", async () => {
    const seven = replay(coverage.days_7);
    await getPipelineCoverage(7, { fetch: seven.fetchImpl });
    expect(seven.seen[0].url).toMatch(/\/pipeline\/coverage\?days=7$/);
    const plain = replay(coverage.default);
    await getPipelineCoverage(undefined, { fetch: plain.fetchImpl });
    expect(plain.seen[0].url).toMatch(/\/pipeline\/coverage$/);
  });

  it("gives up at its deadline and says so", async () => {
    const waiting = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const err = await getPipelineCoverage(undefined, { fetch: waiting, timeoutMs: 1 }).catch(
      (e: unknown) => e,
    );
    expect(computeAdminErrorText(err)).toBe(ACCOUNT_COPY["compute_admin.error.timeout"]);
  });
});
