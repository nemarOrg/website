/**
 * The scalp maps' drawing budgets (website ADR 0035, Consequences; the live-views plan's C14): once
 * a view's data arrive, its first maps within 50 ms and the whole view within 100 ms at 128 sensors
 * and 300 ms at 256, on a mid-range laptop. CI gates at twice those numbers, as the plan sets; a
 * laptop measurement in a real browser and a real module worker is `e2e/quality-views-perf.spec.ts`.
 *
 * Each view is the heaviest the pipeline declares for its size: independent-component maps, one
 * map per sensor (128 maps on 128 sensors, 256 on 256), on the vectors' caps, drawn through the
 * whole path a page uses: the client, a structured-cloning `MessageChannel`, the worker handler
 * (geometry, maps, Float32 grids, contour lines) and back, with the 8 maps on screen asked for
 * first. Every run starts with an empty cache (a new client); one run before the timed ones warms
 * the JIT, and the median of five is gated.
 */

import { describe, expect, it } from "vitest";
import { inThreadWorker } from "../src/lib/quality-views/worker";
import { SensorFieldClient } from "../src/lib/quality-views/worker-client";
import { loadFieldVectors, numbers } from "./quality-views-vectors";

const field = await loadFieldVectors();

/** The budgets on a mid-range laptop, in milliseconds; CI allows twice these. */
const BUDGET = { firstMaps: 50, view128: 100, view256: 300 } as const;
const CI_FACTOR = 2;
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
      batchSize: VISIBLE.length,
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

describe("drawing budgets", () => {
  it.each([
    ["montage_128", BUDGET.view128],
    ["montage_256", BUDGET.view256],
  ] as const)(
    "%s: the first maps and the whole view within twice the budget",
    async (name, viewBudget) => {
      const first = await timeView(name, 0);
      const runs = [];
      for (let run = 1; run <= 5; run++) runs.push(await timeView(name, run));
      expect(first.drawn).toBe(view(name).maps.length);
      const firstMaps = median(runs.map((r) => r.firstMaps));
      const whole = median(runs.map((r) => r.view));
      console.info(
        `[quality-views perf] ${name}: first run (cold JIT) first maps ${first.firstMaps.toFixed(1)} ms, view ${first.view.toFixed(1)} ms; median of 5: first maps ${firstMaps.toFixed(1)} ms, view ${whole.toFixed(1)} ms`,
      );
      expect(firstMaps).toBeLessThanOrEqual(BUDGET.firstMaps * CI_FACTOR);
      expect(whole).toBeLessThanOrEqual(viewBudget * CI_FACTOR);
    },
    30_000,
  );
});
