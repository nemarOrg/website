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
 * "Panel opened after page load" (phase W6, the owner's ruling of 2026-11-25) replaces W4's
 * printed-only first-visit eager case at 256 sensors: the dataset page's idle preload
 * (`startIdlePreload`) runs first, through its real code (the record read and checked, the layout
 * fetched, checked and its geometry prepared in the worker, the first windows' files fetched and
 * checked), the panel opens at least one idle period later and takes the held record, and the view
 * is built from the preloaded files with no fetch (`preloadedSource`), so its values are there at
 * mount. Timed from the mount to the view ready (the held record, the view's digest, the model,
 * the figure's tree and the maps' draw), gated at 50 / 100 / 300 ms at 128 and 256 sensors; the
 * draw must find the geometry in the cache.
 *
 * Every fresh-first-view case (cold, eager, and the panel opened after page load) is gated on the
 * median of five fresh runs, each printed (the owner's ruling on #599: a steadier gate, the
 * budgets unchanged).
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
const FIRST_VIEW_RUNS = 5;

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
      // #594): the dataset page prepares the geometry at page load, and "panel opened after page
      // load" below gates that case (phase W6).
      if (name === "montage_128") gate(eager, "eager", viewBudget);
    },
    240_000,
  );
});

/** One recording's record as the route serves it, with one `nemar.ic-maps` view of `name`'s
 *  sensors (one component per sensor), its files, and the route's answer bytes. */
async function icMapsRecord(name: string) {
  const { viewDigest } = await import("../src/lib/quality-views/verify");
  const { subtleSha256 } = await import("../src/lib/quality-views/model");
  const { thetaDeg, radius, maps } = view(name);
  const n = thetaDeg.length;
  const sensors = Array.from({ length: n }, (_, s) => `E${s + 1}`);
  const ics = Array.from({ length: n }, (_, m) => `IC${String(m + 1).padStart(3, "0")}`);
  const tsv = (rows: string[][]) =>
    new TextEncoder().encode(`${rows.map((r) => r.join("\t")).join("\n")}\n`);
  const layout = tsv([
    ["name", "sensor_type", "theta_deg", "radius"],
    ...sensors.map((label, s) => [label, "EEG", String(thetaDeg[s]), String(radius[s])]),
  ]);
  const values = tsv([ics, ...sensors.map((_, s) => maps.map((m) => String(m[s])))]);
  const components = tsv([
    ["component", "variance_pct"],
    ...ics.map((ic, m) => [ic, String(m + 1)]),
  ]);
  const stem = "sub-01/eeg/sub-01_task-rest_desc-nemarica";
  const file = async (suffix: string, bytes: Uint8Array) => ({
    location: `${stem}_${suffix}.tsv`,
    format: "tsv",
    size: bytes.length,
    sha256: await subtleSha256(bytes),
  });
  const declaration = {
    key: "icmaps",
    kind: "nemar.ic-maps",
    kind_version: 1,
    base: "nemar.sensor-field",
    base_version: 1,
    caption: "Scalp maps of the independent components.",
    source: { recipe: { name: "nemar-ica", version: "1.0.0" } },
    data: [
      {
        role: "values",
        ...(await file("mixing", values)),
        columns: ics.map((ic) => ({ name: ic, type: "number" })),
        dims: [
          {
            name: "sensor",
            axis: "rows",
            type: "string",
            coords: { role: "layout", column: "name" },
          },
          { name: "component", axis: "columns", type: "string", coords: { header: true } },
        ],
      },
      {
        role: "layout",
        ...(await file("chanlocs", layout)),
        columns: [
          { name: "name", type: "string" },
          { name: "sensor_type", type: "string" },
          { name: "theta_deg", type: "number", unit: "deg" },
          { name: "radius", type: "number" },
        ],
        dims: [{ name: "sensor", axis: "rows", type: "string", coords: { column: "name" } }],
        coordinate_system: "CapTrak",
        position_source: "measured",
      },
      {
        role: "components",
        ...(await file("components", components)),
        columns: [
          { name: "component", type: "string" },
          { name: "variance_pct", type: "number", unit: "%" },
        ],
        dims: [
          { name: "component", axis: "rows", type: "string", coords: { column: "component" } },
        ],
      },
    ],
  };
  const recording = "sub-01/eeg/sub-01_task-rest_eeg.edf";
  const answer = {
    format: "nemar.quality-record.v1",
    dataset_id: "nm000001",
    recipe: "nemar-ica",
    recording,
    derivative: {
      key: "a".repeat(64),
      version: "v1.0.0",
      recipe_version: "1.0.0",
      retention: "catalog",
      stored_at: "2026-11-20 10:00:00",
    },
    dataQuality: {
      level: "record",
      recipes: {
        "nemar-ica": {
          recipe_version: "1.0.0",
          input_kind: "zarr",
          profile: "serving",
          record_sha256: "b".repeat(64),
          metrics: {},
          views: [declaration],
        },
      },
    },
    view_digests: { icmaps: await viewDigest(declaration) },
  };
  const bytes = new Map<string, Uint8Array>();
  for (const [entry, data] of [
    [declaration.data[0], values],
    [declaration.data[1], layout],
    [declaration.data[2], components],
  ] as const) {
    bytes.set(entry.sha256, data);
  }
  const text = JSON.stringify(answer);
  // The route's strong ETag, the SHA-256 of the body: required from the data plane.
  const etag = `"${await subtleSha256(new TextEncoder().encode(text))}"`;
  return { recording, declaration, answer: text, etag, bytes };
}

interface OpenedView extends FirstView {
  readonly buildMs: number;
  readonly fetchedAtMount: number;
}

/** The panel opened after page load: the idle preload first, then, an idle period later, the view
 *  built from the preloaded files and drawn. Freshly imported code, as a first visit has it. */
async function panelAfterLoad(name: string): Promise<OpenedView> {
  vi.resetModules();
  const worker = await import("../src/lib/quality-views/worker");
  const { SensorFieldClient: Client } = await import("../src/lib/quality-views/worker-client");
  const { startIdlePreload } = await import("../src/lib/quality-views/preload");
  const { preloadedSource } = await import("../src/lib/quality-views/preloaded");
  const { buildModel } = await import("../src/lib/quality-views/model");
  const { fieldDrawInput } = await import("../src/lib/quality-views/render/sensor-field-view");
  const { renderView, viewContext } = await import("../src/lib/quality-views/render/index");
  const { recordFor } = await import("../src/lib/quality-views/panel-bridge");
  const { viewDigest } = await import("../src/lib/quality-views/verify");
  const fixture = await icMapsRecord(name);
  const client = new Client(worker.inThreadWorker);
  const base = "https://data.example.invalid";
  const fetchAnswer = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/record/")) return new Response(fixture.answer, { headers: { ETag: fixture.etag } });
    const sha = [...fixture.bytes.keys()].find((s) => url.includes(`/${s}/`));
    return sha
      ? new Response(fixture.bytes.get(sha) as Uint8Array<ArrayBuffer>)
      : new Response(null, { status: 404 });
  };
  const preload = await startIdlePreload(
    { base, datasetId: "nm000001", recipe: "nemar-ica" },
    {
      loaded: Promise.resolve(),
      idle: (run) => run(),
      recordings: async () => [{ path: fixture.recording, name: "x" }],
      viewerOpen: () => false,
      panelOpened: () => false,
      onLeave: () => {},
      fetch: fetchAnswer,
      client,
    },
  ).done;
  if (preload.kind !== "ran" || preload.outcome?.layout?.kind !== "prepared") {
    throw new Error(`the preload did not prepare the layout: ${JSON.stringify(preload)}`);
  }
  // At least one idle period between the page's load and the panel's opening, in which the
  // warm-up's throwaway batches (started by the preload) finish.
  await new Promise((resolve) => setTimeout(resolve, 100));
  let fetchedAtMount = 0;
  const panelFetch = async () => {
    fetchedAtMount++;
    return null;
  };
  const layoutKey = fixture.declaration.data[1].sha256;
  // From the panel's mount to its first view ready, as the panel does it: the record the preload
  // holds (no request), the view's digest, the model from the preloaded files, the figure's tree
  // (the DOM nodes are made from this tree on a page; Vitest has no DOM) and the maps' draw.
  const mount = performance.now();
  const held = await recordFor(fixture.recording, () => {
    throw new Error("the panel asked for the record again");
  });
  if ((held as { kind: string }).kind !== "ok") throw new Error("no record held");
  const view = (held as unknown as { record: { views: unknown[]; digests: Record<string, string> } })
    .record;
  if ((await viewDigest(view.views[0])) !== view.digests.icmaps) throw new Error("digest");
  const built = await buildModel(fixture.declaration, preloadedSource(panelFetch), {
    checks: client.checks(),
    montage: () => Promise.reject(new Error("no montage")),
    onLayout: (places) => void client.prepare({ layoutKey, ...places }),
  });
  const buildMs = performance.now() - mount;
  const { tree } = await renderView(built, viewContext(fixture.declaration as never, "qp-icmaps"));
  if (!tree) throw new Error("no tree");
  const draw = fieldDrawInput(built as never);
  if (!draw) throw new Error("no maps to draw");
  let firstMaps = Number.NaN;
  const outcome = await client.draw(
    { layoutKey, thetaDeg: draw.thetaDeg, radius: draw.radius, maps: draw.maps },
    {
      first: VISIBLE,
      onBatch: () => {
        if (Number.isNaN(firstMaps)) firstMaps = performance.now() - mount;
      },
    },
  );
  const start = mount;
  const elapsed = performance.now() - start;
  client.terminate();
  if (outcome.kind !== "done") throw new Error(`the view was not drawn: ${outcome.kind}`);
  return {
    warmMs: 0,
    warmed: "preload",
    warmMaps: 0,
    firstMaps,
    view: elapsed,
    drawn: outcome.maps.filter((map) => map.kind === "map").length,
    cacheHits: outcome.stats.cacheHits,
    cacheMisses: outcome.stats.cacheMisses,
    geometryMs: outcome.stats.geometryMs,
    mapsMs: outcome.stats.mapsMs,
    buildMs,
    fetchedAtMount,
  };
}

describe.skipIf(!GATED)("panel opened after page load (QUALITY_VIEWS_PERF=gate)", () => {
  it.each([
    ["montage_128", BUDGET.view128],
    ["montage_256", BUDGET.view256],
  ] as const)(
    "%s: the idle preload, then the panel's first view within the budget",
    async (name, viewBudget) => {
      const list: OpenedView[] = [];
      for (let k = 0; k < FIRST_VIEW_RUNS; k++) list.push(await panelAfterLoad(name));
      for (const run of list) {
        console.info(
          `${line(name, "eager", run).replace("eager first view", "panel opened after page load")} (model built from the preloaded files in ${run.buildMs.toFixed(1)} ms)`,
        );
        expect(run.drawn).toBe(view(name).maps.length);
        // The values were there at mount: the panel fetched nothing, and the geometry the preload
        // prepared was the draw's.
        expect(run.fetchedAtMount).toBe(0);
        expect(run.cacheMisses).toBe(0);
        expect(run.cacheHits).toBeGreaterThan(0);
      }
      console.info(
        `[quality-views perf] ${name} panel opened after page load, median of ${list.length}: first maps ${medianOf(list, "firstMaps").toFixed(1)} ms, view ${medianOf(list, "view").toFixed(1)} ms`,
      );
      gate(list, "panel opened after page load", viewBudget);
    },
    240_000,
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
