/**
 * The scalp maps' drawing budget (nemar-cli ADR 0137, website ADR 0035, the live-views plan's C14):
 * once a view's data arrive, its first maps within 50 ms and the whole view within 100 ms at 128
 * sensors (300 ms at 256), on a mid-range laptop.
 *
 * Each view is the heaviest the pipeline declares for its size: independent-component maps, one map
 * per sensor (128 maps on 128 sensors, 256 on 256), on the vectors' caps, with the 8 maps on screen
 * asked for first. It is drawn through the whole path a page uses: the client, a structured-cloning
 * `MessageChannel`, the worker handler (geometry, maps, contour lines for the maps on screen) and
 * back. Every run starts with an empty cache (a new client); one run before the timed ones warms
 * the JIT, and the median of five is gated.
 *
 * The first view a page draws (website#592) is gated beside the median, at the same budgets, on
 * code the engine has not yet compiled (each such run imports the worker and the client afresh):
 * cold, where the layout arrives before the values and the geometry is prepared meanwhile, and
 * eager, where cached data are there when the panel mounts. The gate also checks that the cold
 * view's draw found the layout's geometry in the cache. A view whose data arrive in the middle of
 * the warm-up is measured and printed, not gated (the owner's ruling on #594).
 *
 * The gate is the budget itself, and it runs on CI's own runner in a step of its own
 * (`bun run test:quality-views-perf`), after the other tests, so nothing else competes for the
 * machine; the runner stands in for the mid-range laptop. Inside the parallel `bun run test` the
 * timings would measure the other test files, so there it is skipped unless
 * `QUALITY_VIEWS_PERF=gate`. A real module worker in a real browser is timed by
 * `e2e/quality-views-perf.spec.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { inThreadWorker } from "../src/lib/quality-views/worker";
import { SensorFieldClient } from "../src/lib/quality-views/worker-client";
import { nodeProcess, nodeWorkerThreads } from "./node";
import { loadFieldVectors, numbers } from "./quality-views-vectors";

const GATED = (await nodeProcess()).env.QUALITY_VIEWS_PERF === "gate";
const field = await loadFieldVectors();

/** The budgets, in milliseconds. */
const BUDGET = { firstMaps: 50, view128: 100, view256: 300 } as const;
const VISIBLE = [0, 1, 2, 3, 4, 5, 6, 7];

function view(name: string) {
  const vectorCase = field.cases.find((c) => c.name === name)!;
  const thetaDeg = numbers(vectorCase.sensors.theta_deg!);
  const radius = numbers(vectorCase.sensors.radius!);
  const base = numbers(vectorCase.sensors.value);
  const maps = Array.from({ length: thetaDeg.length }, (_, m) =>
    Float64Array.from(base, (v, s) => v * Math.cos(m + 1) + Math.sin(s * (m + 1))),
  );
  return { thetaDeg, radius, maps };
}

async function timeView(
  name: string,
  run: number,
): Promise<{ firstMaps: number; view: number; drawn: number }> {
  const { thetaDeg, radius, maps } = view(name);
  const client = new SensorFieldClient(inThreadWorker);
  let firstMaps = Number.NaN;
  const start = performance.now();
  const outcome = await client.draw(
    { layoutKey: `${name}-${run}`, thetaDeg, radius, maps },
    {
      first: VISIBLE,
      onBatch: () => {
        if (Number.isNaN(firstMaps)) firstMaps = performance.now() - start;
      },
    },
  );
  const elapsed = performance.now() - start;
  client.terminate();
  if (outcome.kind !== "done") throw new Error(`the view was not drawn: ${outcome.kind}`);
  return {
    firstMaps,
    view: elapsed,
    drawn: outcome.maps.filter((map) => map.kind === "map").length,
  };
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[values.length >> 1];

type Scenario = "cold" | "eager" | "mid-warm";

interface FirstView {
  readonly warmMs: number;
  readonly warmed: string;
  /** Throwaway maps the warm-up drew (none when a real draw cancelled it first). */
  readonly warmMaps: number;
  readonly firstMaps: number;
  readonly view: number;
  readonly drawn: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  /** The draw's own geometry and map times, from the worker's stats. */
  readonly geometryMs: number;
  readonly mapsMs: number;
}

/**
 * The first view a panel draws, on freshly imported code. The panel warms the worker when it
 * mounts, before it knows a layout (`warm()`), and then:
 *
 * - `cold`: the layout arrives first and its geometry is prepared, and the values arrive after
 *   the warm-up (they download meanwhile);
 * - `eager`: the layout and the values are already there when the panel mounts (cached data);
 * - `mid-warm`: the layout and the values arrive while the warm-up draws its first batch.
 *
 * The view is timed from the moment its values arrive.
 */
async function firstView(name: string, scenario: Scenario): Promise<FirstView> {
  vi.resetModules();
  const worker = await import("../src/lib/quality-views/worker");
  const { SensorFieldClient: Client } = await import("../src/lib/quality-views/worker-client");
  const { thetaDeg, radius, maps } = view(name);
  const client = new Client(worker.inThreadWorker);
  const layoutKey = `${name}-${scenario}`;
  let midway: () => void = () => {};
  const firstBatch = new Promise<void>((resolve) => {
    midway = resolve;
  });
  const warming = client.warm(undefined, { onBatch: () => midway() });
  if (scenario === "cold") {
    await client.prepare({ layoutKey, thetaDeg, radius });
    await warming;
  } else if (scenario === "mid-warm") {
    await firstBatch;
  }
  let firstMaps = Number.NaN;
  const start = performance.now();
  const outcome = await client.draw(
    { layoutKey, thetaDeg, radius, maps },
    {
      first: VISIBLE,
      onBatch: () => {
        if (Number.isNaN(firstMaps)) firstMaps = performance.now() - start;
      },
    },
  );
  const elapsed = performance.now() - start;
  const warmed = await warming;
  client.terminate();
  if (outcome.kind !== "done") throw new Error(`the view was not drawn: ${outcome.kind}`);
  return {
    warmMs: warmed.ms,
    warmed: warmed.draw.kind,
    warmMaps: warmed.draw.kind === "done" ? warmed.draw.maps.length : 0,
    firstMaps,
    view: elapsed,
    drawn: outcome.maps.filter((map) => map.kind === "map").length,
    cacheHits: outcome.stats.cacheHits,
    cacheMisses: outcome.stats.cacheMisses,
    geometryMs: outcome.stats.geometryMs,
    mapsMs: outcome.stats.mapsMs,
  };
}

const line = (name: string, scenario: Scenario, run: FirstView): string =>
  `[quality-views perf] ${name} ${scenario} first view: first maps ${run.firstMaps.toFixed(1)} ms, view ${run.view.toFixed(1)} ms (geometry ${run.geometryMs.toFixed(1)} ms, maps ${run.mapsMs.toFixed(1)} ms; warm-up ${run.warmed}, ${run.warmMs.toFixed(1)} ms)`;

/** Fresh first views gated by their median: each run imports the code afresh, so each is a first
 *  view, and one slow or fast run of a shared runner does not decide the gate. */
const FIRST_VIEW_RUNS = 3;

async function runs(make: () => Promise<FirstView>): Promise<FirstView[]> {
  const out: FirstView[] = [];
  for (let k = 0; k < FIRST_VIEW_RUNS; k++) out.push(await make());
  return out;
}

const medianOf = (list: readonly FirstView[], key: "firstMaps" | "view"): number =>
  median(list.map((run) => run[key]));

function report(name: string, scenario: Scenario, list: readonly FirstView[]): void {
  for (const run of list) console.info(line(name, scenario, run));
  console.info(
    `[quality-views perf] ${name} ${scenario} median of ${list.length}: first maps ${medianOf(list, "firstMaps").toFixed(1)} ms, view ${medianOf(list, "view").toFixed(1)} ms`,
  );
}

function gate(list: readonly FirstView[], label: string, viewBudget: number): void {
  expect(medianOf(list, "firstMaps"), `${label} first maps`).toBeLessThanOrEqual(BUDGET.firstMaps);
  expect(medianOf(list, "view"), `${label} view`).toBeLessThanOrEqual(viewBudget);
}

describe.skipIf(!GATED)("first views (QUALITY_VIEWS_PERF=gate)", () => {
  it.each([
    ["montage_128", BUDGET.view128],
    ["montage_256", BUDGET.view256],
  ] as const)(
    "%s: cold, eager and mid-warm first views",
    async (name, viewBudget) => {
      const cold = await runs(() => firstView(name, "cold"));
      const eager = await runs(() => firstView(name, "eager"));
      const midWarm = await runs(() => firstView(name, "mid-warm"));
      report(name, "cold", cold);
      report(name, "eager", eager);
      report(name, "mid-warm", midWarm);
      for (const run of [...cold, ...eager, ...midWarm]) {
        expect(run.drawn).toBe(view(name).maps.length);
      }
      // Cold: the warm-up ran to its end and the layout's geometry was built before the values.
      for (const run of cold) {
        expect(run.warmed).toBe("done");
        expect(run.warmMaps).toBe(16);
        expect(run.cacheMisses).toBe(0);
        expect(run.cacheHits).toBeGreaterThan(0);
      }
      gate(cold, "cold", viewBudget);
      // A first visit's eager view at 256 sensors is printed, not gated (the owner's ruling on
      // #594): the dataset page prepares the geometry at page load (`prepareAhead`), and phase W6
      // gates that case as "panel opened after page load".
      if (name === "montage_128") gate(eager, "eager", viewBudget);
    },
    120_000,
  );
});

describe.skipIf(!GATED)("drawing budget (QUALITY_VIEWS_PERF=gate)", () => {
  it.each([
    ["montage_128", BUDGET.view128],
    ["montage_256", BUDGET.view256],
  ] as const)(
    "%s: the first maps and the whole view within the budget",
    async (name, viewBudget) => {
      const first = await timeView(name, 0);
      const runs = [];
      for (let run = 1; run <= 5; run++) runs.push(await timeView(name, run));
      expect(first.drawn).toBe(view(name).maps.length);
      const firstMaps = median(runs.map((r) => r.firstMaps));
      const whole = median(runs.map((r) => r.view));
      console.info(
        `[quality-views perf] ${name}: first run (cold JIT) first maps ${first.firstMaps.toFixed(1)} ms, view ${first.view.toFixed(1)} ms; median of 5: first maps ${firstMaps.toFixed(1)} ms, view ${whole.toFixed(1)} ms; views ${runs.map((r) => r.view.toFixed(1)).join(", ")} ms`,
      );
      expect(firstMaps).toBeLessThanOrEqual(BUDGET.firstMaps);
      expect(whole).toBeLessThanOrEqual(viewBudget);
    },
    60_000,
  );
});

/**
 * Probes for a faster first-visit geometry (the owner's follow-up to #594), printed on the runner
 * and not gated: how often an r² repeats exactly across the evaluation matrix (what a cache of
 * ln(r²) could reuse), and what a second thread computing half of the matrix's rows costs to start
 * and to run, with its rows checked bit for bit against the worker's own.
 */
describe.skipIf(!GATED)("geometry probes (QUALITY_VIEWS_PERF=gate, printed)", () => {
  it("montage_256: exact r² reuse and a second thread for half the rows", async () => {
    const { prepareSensorField, green } = await import("../src/lib/quality-views/sensor-field");
    const { thetaDeg, radius } = view("montage_256");
    const built = prepareSensorField(thetaDeg, radius, new Uint8Array(thetaDeg.length).fill(1));
    if (built.kind !== "geometry") throw new Error(built.kind);
    const g = built.geometry;
    const k = g.px.length;
    const cells = g.inside.length;
    const size = g.x.length;
    const distinct = new Set<number>();
    let start = performance.now();
    const full = new Float64Array(cells * k);
    for (let c = 0; c < cells; c++) {
      const qx = g.x[(g.inside[c] / size) | 0];
      const qy = g.y[g.inside[c] % size];
      for (let s = 0; s < k; s++) {
        const dx = qx - g.px[s];
        const dy = qy - g.py[s];
        const r2 = dx * dx + dy * dy;
        full[c * k + s] = green(r2);
      }
    }
    const inThread = performance.now() - start;
    for (let c = 0; c < cells; c++) {
      const qx = g.x[(g.inside[c] / size) | 0];
      const qy = g.y[g.inside[c] % size];
      for (let s = 0; s < k; s++) {
        const dx = qx - g.px[s];
        const dy = qy - g.py[s];
        distinct.add(dx * dx + dy * dy);
      }
    }
    const { Worker } = await nodeWorkerThreads();
    const code = `
      const { parentPort } = require("node:worker_threads");
      parentPort.postMessage({ ready: true });
      parentPort.on("message", ({ x, y, px, py, inside, from, to, size }) => {
        const k = px.length;
        const out = new Float64Array((to - from) * k);
        for (let c = from; c < to; c++) {
          const qx = x[(inside[c] / size) | 0];
          const qy = y[inside[c] % size];
          for (let s = 0; s < k; s++) {
            const dx = qx - px[s];
            const dy = qy - py[s];
            const r2 = dx * dx + dy * dy;
            out[(c - from) * k + s] = r2 === 0 ? 0 : r2 * (0.5 * Math.log(r2) - 1);
          }
        }
        parentPort.postMessage(out, [out.buffer]);
      });`;
    start = performance.now();
    const thread = new Worker(code, { eval: true });
    const messages: unknown[] = [];
    let wake: () => void = () => {};
    thread.on("message", (data) => {
      messages.push(data);
      wake();
    });
    const next = async () => {
      while (messages.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      return messages.shift();
    };
    await next();
    const startup = performance.now() - start;
    const half = cells >> 1;
    start = performance.now();
    thread.postMessage({
      x: g.x,
      y: g.y,
      px: g.px,
      py: g.py,
      inside: g.inside,
      from: half,
      to: cells,
      size,
    });
    const rows = (await next()) as Float64Array;
    const halfInThread = performance.now() - start;
    await thread.terminate();
    let same = rows.length === (cells - half) * k;
    for (let i = 0; same && i < rows.length; i++)
      same = Object.is(rows[i], g.evaluation[half * k + i]);
    console.info(
      `[quality-views perf] montage_256 geometry probes: evaluation matrix ${cells}x${k} in this thread ${inThread.toFixed(1)} ms; distinct r2 ${distinct.size} of ${cells * k} (${((100 * distinct.size) / (cells * k)).toFixed(1)}%); second thread: start ${startup.toFixed(1)} ms, half the rows ${halfInThread.toFixed(1)} ms (cold), bit-identical ${same}`,
    );
    expect(same).toBe(true);
  }, 60_000);
});
