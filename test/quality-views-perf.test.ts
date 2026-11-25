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
 * The gate is the budget itself, and it runs on CI's own runner in a step of its own
 * (`bun run test:quality-views-perf`), after the other tests, so nothing else competes for the
 * machine; the runner stands in for the mid-range laptop. Inside the parallel `bun run test` the
 * timings would measure the other test files, so there it is skipped unless
 * `QUALITY_VIEWS_PERF=gate`. A real module worker in a real browser is timed by
 * `e2e/quality-views-perf.spec.ts`.
 */

import { describe, expect, it } from "vitest";
import { inThreadWorker } from "../src/lib/quality-views/worker";
import { SensorFieldClient } from "../src/lib/quality-views/worker-client";
import { nodeProcess } from "./node";
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
