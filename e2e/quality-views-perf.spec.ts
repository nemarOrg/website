/**
 * The scalp maps' drawing budgets in a real browser and a real module worker (website ADR 0035;
 * the live-views plan's C14): once a view's data arrive, its first maps within 50 ms, one view at
 * 128 sensors within 100 ms and at 256 within 300 ms, on a mid-range laptop. This is the laptop
 * measurement the plan asks the pull request to record; CI gates the same path at twice the budget
 * in `test/quality-views-perf.test.ts`, without a browser.
 *
 * No page draws quality views yet (phases W4 and W6 add them), so the spec opens a plain page of the
 * dev server (its `robots.txt`, a same-origin document that needs no API) and loads `worker-client.ts` through Vite, which bundles `worker.ts` as a module worker
 * exactly as a page's import would. Each view is the heaviest of its size, one independent-component
 * map per sensor on the vectors' caps, with the 8 maps on screen asked for first. The first view is
 * timed on its own (it starts the worker and compiles its code); the budgets are gated on the median
 * of five later views, each with a layout the worker has not cached. The first views a page meets
 * (website#592) are each drawn by a client with a new worker: cold (the panel warms the worker on
 * mount and prepares the geometry when the layout arrives, the values come after), eager (cached
 * data at mount) and mid-warm (the data arrive during the warm-up's first batch). Cold is gated at
 * the same budgets, and eager at 128 sensors; eager at 256 and mid-warm are printed.
 *
 * Run it with `bun run test:e2e e2e/quality-views-perf.spec.ts` (see playwright.config.ts). It needs
 * no network: the page's own requests to the API may fail without changing what is measured.
 */

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const BUDGET = { firstMaps: 50, view128: 100, view256: 300 } as const;

interface Sensors {
  readonly theta_deg: (number | null)[];
  readonly radius: (number | null)[];
  readonly value: (number | null)[];
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../test/fixtures/quality-views/vectors/sensor-field.v1.json", import.meta.url),
    "utf8",
  ),
) as { cases: { name: string; sensors: Sensors }[] };

function sensors(name: string): Sensors {
  return vectors.cases.find((c) => c.name === name)!.sensors;
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

for (const [name, viewBudget] of [
  ["montage_128", BUDGET.view128],
  ["montage_256", BUDGET.view256],
] as const) {
  test(`${name}: first maps and the whole view within the budget`, async ({ page }, info) => {
    await page.goto("/robots.txt");
    const timings = await page.evaluate(
      async ({ name, data }) => {
        const specifier = "/src/lib/quality-views/worker-client.ts";
        const { SensorFieldClient } = await import(/* @vite-ignore */ specifier);
        const nan = (list: (number | null)[]) => Float64Array.from(list, (v) => v ?? Number.NaN);
        const thetaDeg = nan(data.theta_deg);
        const radius = nan(data.radius);
        const base = nan(data.value);
        const maps = Array.from({ length: thetaDeg.length }, (_, m) =>
          Float64Array.from(base, (v, s) => v * Math.cos(m + 1) + Math.sin(s * (m + 1))),
        );
        type Run = { firstMaps: number; view: number; drawn: number; kind: string; worker: number };
        // biome-ignore lint/suspicious/noExplicitAny: the client module is imported by URL.
        const timeDraw = async (client: any, layoutKey: string): Promise<Run> => {
          let firstMaps = Number.NaN;
          const start = performance.now();
          const outcome = await client.draw(
            { layoutKey, thetaDeg, radius, maps },
            {
              first: [0, 1, 2, 3, 4, 5, 6, 7],
              onBatch: () => {
                if (Number.isNaN(firstMaps)) firstMaps = performance.now() - start;
              },
            },
          );
          return {
            firstMaps,
            view: performance.now() - start,
            kind: outcome.kind,
            // The worker's own time, from the request's arrival to its last batch.
            worker: outcome.kind === "done" ? outcome.stats.totalMs : Number.NaN,
            drawn:
              outcome.kind === "done"
                ? outcome.maps.filter((m: { kind: string }) => m.kind === "map").length
                : 0,
          };
        };
        // Each scenario's client starts a new module worker, so its first view is cold.
        // Cold: the panel warms the worker when it mounts, prepares the layout's geometry when the
        // layout arrives, and the values arrive after the warm-up.
        const coldClient = new SensorFieldClient();
        const coldWarm = coldClient.warm();
        await coldClient.prepare({ layoutKey: `${name}-cold`, thetaDeg, radius });
        const warm = await coldWarm;
        const cold = await timeDraw(coldClient, `${name}-cold`);
        coldClient.terminate();
        // Eager: cached data are there when the panel mounts.
        const eagerClient = new SensorFieldClient();
        const eagerWarm = eagerClient.warm();
        const eager = await timeDraw(eagerClient, `${name}-eager`);
        await eagerWarm;
        eagerClient.terminate();
        // Mid-warm: the data arrive while the warm-up draws its first batch.
        const client = new SensorFieldClient();
        let midway: () => void = () => {};
        const firstBatch = new Promise<void>((resolve) => {
          midway = resolve;
        });
        const midWarming = client.warm(undefined, { onBatch: () => midway() });
        await firstBatch;
        const midWarm = await timeDraw(client, `${name}-mid`);
        await midWarming;
        const later: Run[] = [];
        for (let run = 1; run <= 5; run++) later.push(await timeDraw(client, `${name}-${run}`));
        client.terminate();
        return {
          cold,
          eager,
          midWarm,
          later,
          warmMs: warm.ms,
          warmed: warm.draw.kind,
          userAgent: navigator.userAgent,
          cores: navigator.hardwareConcurrency,
        };
      },
      { name, data: sensors(name) },
    );
    const { cold, eager, midWarm, later } = timings;
    for (const run of [cold, eager, midWarm, ...later]) {
      expect(run.kind).toBe("done");
      expect(run.drawn).toBe(sensors(name).value.length);
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
    const firstMaps = median(later.map((r) => r.firstMaps));
    const view = median(later.map((r) => r.view));
    const worker = median(later.map((r) => r.worker));
    const at = (r: { firstMaps: number; view: number }) =>
      `first maps ${r.firstMaps.toFixed(1)} ms, view ${r.view.toFixed(1)} ms`;
    const line = `${name} in ${timings.userAgent} (${timings.cores} cores): warm-up ${timings.warmMs.toFixed(1)} ms (${timings.warmed}); cold ${at(cold)}; eager ${at(eager)}; mid-warm ${at(midWarm)}; median of 5: ${at({ firstMaps, view })} (in the worker ${worker.toFixed(1)} ms)`;
    info.annotations.push({ type: "quality-views perf", description: line });
    console.info(`[quality-views perf] ${line}`);
    expect(timings.warmed).toBe("done");
    // A first visit's eager view at 256 sensors is printed, not gated: W6 gates it as "panel
    // opened after page load", once the page prepares the geometry in idle time.
    const gated =
      name === "montage_128" ? [cold, eager, { firstMaps, view }] : [cold, { firstMaps, view }];
    for (const run of gated) {
      expect(run.firstMaps).toBeLessThanOrEqual(BUDGET.firstMaps);
      expect(run.view).toBeLessThanOrEqual(viewBudget);
    }
  });
}
