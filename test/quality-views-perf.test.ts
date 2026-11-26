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
import type { GeometryStore } from "../src/lib/quality-views/geometry-store";
import { inThreadWorker } from "../src/lib/quality-views/worker";
import { SensorFieldClient } from "../src/lib/quality-views/worker-client";
import { nodeProcess } from "./node";
import { loadFieldVectors, numbers, serializedStore } from "./quality-views-vectors";

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

type Scenario = "cold" | "eager" | "mid-warm" | "repeat-eager";

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
  readonly storeHits: number;
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
async function firstView(
  name: string,
  scenario: Scenario,
  store?: GeometryStore,
): Promise<FirstView> {
  vi.resetModules();
  const worker = await import("../src/lib/quality-views/worker");
  const { SensorFieldClient: Client } = await import("../src/lib/quality-views/worker-client");
  const { thetaDeg, radius, maps } = view(name);
  const client = new Client(() => worker.inThreadWorker({ store: store ?? null }));
  const layoutKey = scenario === "repeat-eager" ? `${name}-visited` : `${name}-${scenario}`;
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
    storeHits: outcome.stats.storeHits,
  };
}

/** A repeat visit: an earlier visit drew the view and stored its geometry; this one opens with
 *  cached data, on freshly imported code and a new worker. */
async function repeatVisit(name: string): Promise<FirstView> {
  const store = await serializedStore();
  vi.resetModules();
  const worker = await import("../src/lib/quality-views/worker");
  const { SensorFieldClient: Client } = await import("../src/lib/quality-views/worker-client");
  const { thetaDeg, radius } = view(name);
  const earlier = new Client(() => worker.inThreadWorker({ store }));
  await earlier.prepare({ layoutKey: `${name}-visited`, thetaDeg, radius });
  earlier.terminate();
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (store.bytes.size === 0) throw new Error("the earlier visit stored no geometry");
  return firstView(name, "repeat-eager", store);
}

const line = (name: string, scenario: Scenario, run: FirstView): string =>
  `[quality-views perf] ${name} ${scenario} first view: first maps ${run.firstMaps.toFixed(1)} ms, view ${run.view.toFixed(1)} ms (warm-up ${run.warmed}, ${run.warmMs.toFixed(1)} ms)`;

describe.skipIf(!GATED)("first views (QUALITY_VIEWS_PERF=gate)", () => {
  it.each([
    ["montage_128", BUDGET.view128],
    ["montage_256", BUDGET.view256],
  ] as const)(
    "%s: cold, eager and mid-warm first views",
    async (name, viewBudget) => {
      const cold = await firstView(name, "cold");
      // A first visit: the page's storage is there and empty.
      const eager = await firstView(name, "eager", await serializedStore());
      const midWarm = await firstView(name, "mid-warm");
      for (const [scenario, run] of [
        ["cold", cold],
        ["eager", eager],
        ["mid-warm", midWarm],
      ] as const) {
        console.info(line(name, scenario, run));
        expect(run.drawn, scenario).toBe(view(name).maps.length);
      }
      // Cold: the warm-up ran to its end and the layout's geometry was built before the values.
      expect(cold.warmed).toBe("done");
      expect(cold.warmMaps).toBe(16);
      expect(cold.cacheMisses).toBe(0);
      expect(cold.cacheHits).toBeGreaterThan(0);
      for (const [scenario, run] of [
        ["cold", cold],
        ["eager", eager],
      ] as const) {
        expect(run.firstMaps, `${scenario} first maps`).toBeLessThanOrEqual(BUDGET.firstMaps);
        expect(run.view, `${scenario} view`).toBeLessThanOrEqual(viewBudget);
      }
    },
    60_000,
  );
});

describe.skipIf(!GATED)("repeat visits (QUALITY_VIEWS_PERF=gate)", () => {
  it.each([
    ["montage_128", BUDGET.view128],
    ["montage_256", BUDGET.view256],
  ] as const)(
    "%s: eager, the geometry read back from the earlier visit's storage",
    async (name, viewBudget) => {
      const run = await repeatVisit(name);
      console.info(line(name, "repeat-eager", run));
      expect(run.drawn).toBe(view(name).maps.length);
      expect(run.storeHits).toBeGreaterThan(0);
      expect(run.cacheMisses).toBe(0);
      expect(run.firstMaps).toBeLessThanOrEqual(BUDGET.firstMaps);
      expect(run.view).toBeLessThanOrEqual(viewBudget);
    },
    60_000,
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
