/**
 * `nemar.ic-activity.v1` and the kind `nemar.ic-activity` version 1 (website phase W7;
 * `src/lib/quality-views/activations.ts` on the page and `transforms/ic-activity.ts` in the map
 * worker) against neuroschema's vectors, `views/vectors/ic-activity.v1.json` (the live-views plan's
 * C9): every case's state, components, rows, factors, times, activations and filtered values within
 * the parity tolerance of each component's largest activation, its shaded spans and notes; every
 * refusal's word, through the checks on both threads in order; the filter's coefficients and its
 * filter cases; the store digest's states. Then what the panel adds: the window it asks for never
 * exceeds the view's cap, the worker's path gives the same numbers with the samples transferred,
 * and a recording switch stops the work between its steps.
 */

import { describe, expect, it } from "vitest";
import {
  ActivityRefused,
  type ActivityTransform,
  activity,
  burstsRepaired,
  checkDeclaration,
  fetchInputs,
  firstWindow,
  workerTransform,
} from "../src/lib/quality-views/activations";
import { localChecks } from "../src/lib/quality-views/local-checks";
import { CAPS, type FileDecl, type ViewDecl } from "../src/lib/quality-views/model";
import type { ServingStore } from "../src/lib/quality-views/panel-bridge";
import {
  computeActivity,
  displayFilter,
  highpass,
  planActivity,
} from "../src/lib/quality-views/transforms/ic-activity";
import { inThreadWorker } from "../src/lib/quality-views/worker";
import { SensorFieldClient } from "../src/lib/quality-views/worker-client";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const vectors = JSON.parse(
  fs.readFileSync(repoPath("test/fixtures/quality-views/vectors/ic-activity.v1.json"), "utf8"),
);

interface Case {
  name: string;
  view: ViewDecl;
  files: Record<string, { text: string }>;
  store: {
    labels: (string | null)[];
    units: (string | null)[];
    scale: number[];
    offset: number[];
    rate: number;
    published_sha256: string | null;
    digital: number[][];
  };
  window: { start: number; count: number };
  bursts_repaired: boolean | null;
  caps?: Record<string, number>;
  word?: string;
  expected?: {
    state: string;
    components: string[];
    rows: number[];
    factors: number[];
    time_s: number[];
    activations: number[][];
    filtered: number[][];
    shaded: { onset: number; duration: number }[];
    notes: string[];
  };
}

const tolerance: number = vectors.tolerance.parity;

const source = (files: Case["files"]) => async (file: FileDecl) =>
  files[file.location] === undefined ? null : new TextEncoder().encode(files[file.location].text);

/** The vector's store as the serving copy gives it: its rows' description and their integers. */
function servingStore(c: Case, reads: { rows: number[]; from: number; to: number }[] = []) {
  const { digital, ...meta } = c.store;
  const store: ServingStore = {
    ...meta,
    samples: digital[0]?.length ?? 0,
    read: async (rows, from, to) => {
      reads.push({ rows: [...rows], from, to });
      const out = new Int16Array(rows.length * (to - from));
      rows.forEach((row, j) => out.set(digital[row].slice(from, to), j * (to - from)));
      return out;
    },
  };
  return store;
}

const here: ActivityTransform = {
  plan: async (input) => planActivity(input),
  compute: async (plan, digital, scale, offset) => computeActivity(plan, digital, scale, offset),
};

/** The whole view, as the panel runs it: checks 1 to 4 here, then the transform. */
async function run(
  c: Case,
  transform: ActivityTransform = here,
  signal = new AbortController().signal,
) {
  const caps = { ...CAPS, ...c.caps };
  const word = await checkDeclaration(c.view, localChecks);
  if (word !== null) throw new ActivityRefused(word);
  const files = await fetchInputs(c.view, source(c.files), caps);
  return activity(
    c.view,
    files,
    servingStore(c),
    c.window,
    c.bursts_repaired,
    transform,
    signal,
    caps,
  );
}

/** The word a case is refused with, or null when it draws. */
async function wordOf(c: Case): Promise<string | null> {
  try {
    await run(c);
    return null;
  } catch (error) {
    if (error instanceof ActivityRefused) return error.word;
    throw error;
  }
}

function expectParity(c: Case, got: NonNullable<Awaited<ReturnType<typeof run>>>) {
  const e = c.expected!;
  const { plan, result } = got;
  expect(plan.state).toBe(e.state);
  expect(plan.components).toEqual(e.components);
  expect(plan.rows).toEqual(e.rows);
  expect(plan.factors).toEqual(e.factors);
  expect(plan.shaded).toEqual(e.shaded);
  expect(plan.notes).toEqual(e.notes);
  expect(Array.from(result.time)).toEqual(e.time_s);
  const n = c.window.count;
  e.activations.forEach((row, i) => {
    const bound = tolerance * Math.max(...row.map(Math.abs));
    for (let k = 0; k < n; k++) {
      expect(Math.abs(result.activations[i * n + k] - row[k])).toBeLessThanOrEqual(bound);
      expect(Math.abs(result.filtered[i * n + k] - e.filtered[i][k])).toBeLessThanOrEqual(bound);
    }
  });
}

describe("nemar.ic-activity.v1: the cases", () => {
  for (const c of vectors.cases as Case[]) {
    it(`${c.name}`, async () => {
      const got = await run(c);
      expect(got).not.toBeNull();
      expectParity(c, got!);
    });
  }
});

describe("nemar.ic-activity.v1: the refusals, each check in order", () => {
  for (const c of vectors.refusals as Case[]) {
    it(`${c.name}: ${c.word}`, async () => {
      expect(await wordOf(c)).toBe(c.word);
    });
  }

  it("refuses a channel set that differs, whatever the store's order or case (C9)", async () => {
    const names = [
      "store_row_label_differs",
      "store_row_out_of_range",
      "store_row_count",
      "columns_differ",
      "channel_label_unmatched",
      "label_case",
      "label_duplicate",
      "store_unlabeled",
    ];
    for (const name of names) {
      const c = (vectors.refusals as Case[]).find((r) => r.name === name)!;
      expect(await wordOf(c), name).toBe("channel_set_mismatch");
    }
    // A channel the store holds twice is refused when matched by label.
    const archive = (vectors.cases as Case[]).find((c) => c.name === "archive_label_volts")!;
    const store = structuredClone(archive.store);
    const column = (archive.view as { transform: { parameters: { columns: string[] } } }).transform
      .parameters.columns[0];
    store.labels = [...store.labels, column];
    store.units = [...store.units, "uV"];
    store.scale = [...store.scale, 1];
    store.offset = [...store.offset, 0];
    store.digital = [...store.digital, store.digital[0]];
    expect(await wordOf({ ...archive, store })).toBe("channel_set_mismatch");
  });
});

describe("the display filter", () => {
  it("has the stated coefficients and steady state", () => {
    for (const c of vectors.coefficients) {
      const { b, a, zi } = highpass(c.highpass_hz, c.rate);
      [...b, ...a, ...zi].forEach((v, i) => {
        const want = [...c.b, ...c.a, ...c.zi][i];
        // Only the tangent may differ between platforms, in its last bit.
        expect(Math.abs(v - want)).toBeLessThanOrEqual(4 * Number.EPSILON * Math.abs(want));
      });
    }
  });

  it("matches every filter case, padded at both ends", () => {
    for (const f of vectors.filter_cases) {
      f.input.forEach((row: number[], r: number) => {
        const got = displayFilter(Float64Array.from(row), f.rate, f.highpass_hz);
        const bound = tolerance * Math.max(...row.map(Math.abs));
        row.forEach((_, k) => {
          expect(Math.abs(got[k] - f.expected[r][k]), `${f.name} ${r} ${k}`).toBeLessThanOrEqual(
            bound,
          );
        });
      });
    }
  });
});

describe("the store digest's states (open question 1)", () => {
  const base = (vectors.cases as Case[]).find((c) => c.name === "serving_32")!;
  for (const check of vectors.store_checks) {
    it(`declared ${check.declared?.slice(0, 4) ?? "none"}, published ${check.published?.slice(0, 4) ?? "none"}: ${check.outcome}`, async () => {
      const view = structuredClone(base.view) as ViewDecl & {
        inputs: { store?: Record<string, unknown> }[];
      };
      for (const input of view.inputs) if (input.store) input.store.content_sha256 = check.declared;
      // The decomposition read the store it names (check 3), whatever digest the run recorded.
      (
        view as unknown as {
          parameters: { decomposition_input: { store: Record<string, unknown> } };
        }
      ).parameters.decomposition_input.store.content_sha256 = check.declared;
      const files = await fetchInputs(view, source(base.files));
      const outcome = await planActivity({
        view,
        files,
        store: { ...servingStore(base), published_sha256: check.published },
        ...base.window,
        burstsRepaired: null,
        caps: CAPS,
      });
      expect(outcome.word ?? outcome.plan?.state).toBe(check.outcome);
    });
  }

  it("is not_checked for every view until the serving copy publishes digests (nemar-cli#2343)", async () => {
    const { openServingStore } = await import("../src/lib/quality-views/activations");
    // The page's reader states no published digest, whatever the store holds.
    expect(openServingStore.toString()).toContain("published_sha256: null");
    const got = await run({ ...base, store: { ...base.store, published_sha256: null } });
    expect(got!.plan.state).toBe("not_checked");
  });
});

describe("the window", () => {
  it("is never longer than the view's max_window_s allows", () => {
    for (const [samples, rate, max] of [
      [1_000_000, 250, 30],
      [1_000_000, 1000, 5],
      [100, 250, 30],
      [7, 1, 30],
      [1_000_000, 333.3, 2.5],
    ]) {
      const w = firstWindow(samples, rate, max);
      expect(w.start).toBe(0);
      expect(w.count).toBeLessThanOrEqual(Math.floor(max * rate));
      expect(w.count).toBeLessThanOrEqual(samples);
      expect(w.count).toBeGreaterThan(0);
    }
  });

  it("draws exactly floor(max_window_s * rate) samples and refuses one more", async () => {
    const c = (vectors.cases as Case[]).find((x) => x.name === "context_both_sides")!;
    const view = structuredClone(c.view) as ViewDecl & { parameters: { max_window_s: number } };
    view.parameters.max_window_s = 2; // 40 samples at 20 Hz
    const files = await fetchInputs(view, source(c.files));
    const plan = (count: number) =>
      planActivity({
        view,
        files,
        store: servingStore(c),
        start: 80,
        count,
        burstsRepaired: null,
        caps: CAPS,
      });
    expect((await plan(40)).word).toBeNull();
    expect((await plan(41)).word).toBe("window_too_long");
  });

  it("may end at the store's last sample and not one past it", async () => {
    const c = (vectors.cases as Case[]).find((x) => x.name === "last_window")!;
    const files = await fetchInputs(c.view, source(c.files));
    const samples = c.store.digital[0].length;
    const plan = (start: number) =>
      planActivity({
        view: c.view,
        files,
        store: servingStore(c),
        start,
        count: 15,
        burstsRepaired: null,
        caps: CAPS,
      });
    expect((await plan(samples - 15)).word).toBeNull();
    expect((await plan(samples - 14)).word).toBe("window_outside_store");
  });
});

describe("the page's steps around the transform", () => {
  const c = (vectors.cases as Case[]).find((x) => x.name === "serving_32")!;

  it("gives the same numbers through the map worker, the samples transferred", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const worker = workerTransform(client);
    let sent: ArrayLike<number> | null = null;
    const watching: ActivityTransform = {
      plan: worker.plan,
      compute: (plan, digital, scale, offset) => {
        sent = digital;
        return worker.compute(plan, digital, scale, offset);
      },
    };
    const got = await run(c, watching);
    expectParity(c, got!);
    // Both steps were the worker's own answers, not this thread's fallback.
    const files = await fetchInputs(c.view, source(c.files));
    const planned = await client.activity(
      {
        step: "plan",
        input: {
          view: c.view,
          files,
          store: { ...servingStore(c), read: undefined } as never,
          ...c.window,
          burstsRepaired: null,
          caps: CAPS,
        },
      },
      [],
    );
    expect((planned as { plan: { rows: number[] } }).plan.rows).toEqual(c.expected!.rows);
    expect((sent as unknown as Int16Array).byteLength).toBe(0);
    client.terminate();
  });

  it("reads only the matched rows, over the window and its context", async () => {
    const reads: { rows: number[]; from: number; to: number }[] = [];
    const caps = CAPS;
    const files = await fetchInputs(c.view, source(c.files));
    const got = await activity(
      c.view,
      files,
      servingStore(c, reads),
      c.window,
      null,
      here,
      new AbortController().signal,
      caps,
    );
    expect(reads).toEqual([{ rows: c.expected!.rows, from: 0, to: 145 }]);
    expect(got!.plan.before).toBe(20);
  });

  it("stops when the recording is switched: no read after the plan, no transform after the read", async () => {
    const files = await fetchInputs(c.view, source(c.files));
    for (const at of ["plan", "read"] as const) {
      const controller = new AbortController();
      const steps: string[] = [];
      const store = servingStore(c);
      const switching: ServingStore = {
        ...store,
        read: async (rows, from, to, signal) => {
          steps.push("read");
          const out = await store.read(rows, from, to, signal);
          if (at === "read") controller.abort();
          return out;
        },
      };
      const transform: ActivityTransform = {
        plan: async (input) => {
          steps.push("plan");
          const out = await planActivity(input);
          if (at === "plan") controller.abort();
          return out;
        },
        compute: async (...args) => {
          steps.push("compute");
          return computeActivity(...args);
        },
      };
      const got = await activity(
        c.view,
        files,
        switching,
        c.window,
        null,
        transform,
        controller.signal,
      );
      expect(got).toBeNull();
      expect(steps).toEqual(at === "plan" ? ["plan"] : ["plan", "read"]);
    }
  });

  it("reads bursts_repaired from the record's asrBurstFraction", () => {
    const metric = (value: unknown) => ({ asrBurstFraction: { value } });
    expect(burstsRepaired(metric(0.29))).toBe(true);
    expect(burstsRepaired(metric(0))).toBe(false);
    expect(burstsRepaired(metric(null))).toBeNull();
    expect(burstsRepaired({})).toBeNull();
  });
});

describe("readLevel0", () => {
  it("reads the plan's rows, in the plan's order, over the stretch, from a real Zarr array", async () => {
    const zarr = await import("zarrita");
    const { readLevel0 } = await import("../src/lib/quality-views/activations");
    const store = new Map<string, Uint8Array>();
    const array = await zarr.create(zarr.root(store).resolve("eeg/0"), {
      shape: [4, 10],
      dtype: "int16",
      chunkShape: [2, 4],
    });
    const data = Int16Array.from({ length: 40 }, (_, i) => 100 * Math.floor(i / 10) + (i % 10));
    await zarr.set(array, null, { data, shape: [4, 10], stride: [10, 1] });
    const out = await readLevel0(zarr, array as never, [3, 1], 2, 6, new AbortController().signal);
    expect(Array.from(out)).toEqual([302, 303, 304, 305, 102, 103, 104, 105]);
  });
});
