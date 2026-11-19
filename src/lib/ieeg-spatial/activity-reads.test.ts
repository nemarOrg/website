import { describe, expect, it } from "vitest";
import { nodeFs, repoPath } from "../../../test/node";
import { openRecording, readLevel0 } from "../eeg-viewer/store";
import { activityChannelsFromWindow, computeActivity, shortWindowValues } from "./activity";
import { type ActivityPlan, computeActivityPlan } from "./panel";

/**
 * How many chunks of a Zarr store one Activity read fetches, through the viewer's real reader
 * (`openRecording` and `readLevel0` over zarrita) against a store served from memory: the transport
 * boundary is the only stand-in, as in `store.test.ts`. The samples are the real on006136 window of
 * test/fixtures/ieeg-activity (14 channels, 2 s at 1 kHz, SOURCES.json has its dataset, version,
 * path and SHA-256), quantized to the store's 16-bit integers with a scale per channel.
 *
 * The bug this pins (IS-Q2): the plan read the located rows in slices of 16 channels, and a chunk
 * of the store holds many channels, so the same chunks were fetched again for every slice
 * (nm000485: 3 distinct ranges nine times, 27 requests and 11.7 MB for 1.4 MB of samples).
 */

const fs = await nodeFs();
const sources = JSON.parse(
  fs.readFileSync(repoPath("test/fixtures/ieeg-activity/SOURCES.json"), "utf8"),
) as { slice: { file: string; n_channels: number; n_samples: number; channel_labels: string[] } };
const volts = new Float32Array(
  fs.readFileSync(repoPath(`test/fixtures/ieeg-activity/${sources.slice.file}`)).slice().buffer,
);
const ROWS = sources.slice.n_channels;
const COLS = sources.slice.n_samples;
const LABELS = sources.slice.channel_labels;

/** The fixture as the store holds it: int16 digital values and the per-channel scale that restores volts. */
const scales = Array.from({ length: ROWS }, (_, r) => {
  let peak = 0;
  for (let i = 0; i < COLS; i++) peak = Math.max(peak, Math.abs(volts[r * COLS + i]));
  return peak / 30000;
});
const digital = new Int16Array(ROWS * COLS);
for (let r = 0; r < ROWS; r++) {
  for (let i = 0; i < COLS; i++)
    digital[r * COLS + i] = Math.round(volts[r * COLS + i] / scales[r]);
}

function windowStore(chunkRows: number, chunkCols: number) {
  const requests: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const handler = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname.replace(/^\/store\//, "");
    requests.push(path);
    if (path === "zarr.json") {
      return json({
        zarr_format: 3,
        node_type: "group",
        attributes: { format: "test", channel_groups: ["eeg"] },
      });
    }
    if (path === "eeg/zarr.json") {
      return json({
        zarr_format: 3,
        node_type: "group",
        attributes: {
          rate: 1000,
          n_samples: COLS,
          channels: LABELS.map((label, i) => ({
            label,
            unit: "V",
            row_index: i,
            scale: scales[i],
            offset: 0,
          })),
        },
      });
    }
    if (path === "eeg/0/zarr.json") {
      return json({
        zarr_format: 3,
        node_type: "array",
        shape: [ROWS, COLS],
        data_type: "int16",
        chunk_grid: { name: "regular", configuration: { chunk_shape: [chunkRows, chunkCols] } },
        chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
        fill_value: 0,
        codecs: [{ name: "bytes", configuration: { endian: "little" } }],
        attributes: {},
      });
    }
    const chunk = path.match(/^eeg\/0\/c\/(\d+)\/(\d+)$/);
    if (chunk) {
      const [ci, cj] = [Number(chunk[1]), Number(chunk[2])];
      const out = new Int16Array(chunkRows * chunkCols);
      for (let r = 0; r < chunkRows; r++) {
        for (let c = 0; c < chunkCols; c++) {
          const [row, col] = [ci * chunkRows + r, cj * chunkCols + c];
          if (row < ROWS && col < COLS) out[r * chunkCols + c] = digital[row * COLS + col];
        }
      }
      return new Response(out.buffer.slice(0), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { handler, requests };
}

async function withFetch(handler: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

const plan: ActivityPlan = {
  token: 1,
  groupIndex: 0,
  startS: 0,
  endS: 2,
  rateHz: 1000,
  metric: "rms",
  band: null,
  relative: false,
  cursorMs: null,
  contactRows: [],
  rows: Array.from({ length: ROWS }, (_, i) => i),
};
const group = { labels: LABELS, units: LABELS.map(() => "V"), nativeRateHz: 1000 };

describe("an Activity read through the viewer's own reader", () => {
  for (const [chunkRows, chunkCols] of [
    [14, 1000], // every channel in a chunk, as the real nm000485 store lays them out
    [5, 1000], // chunks that cut across the slices
  ] as const) {
    it(`fetches each chunk once, not once per slice (chunks of ${chunkRows} channels by ${chunkCols} samples)`, async () => {
      const { handler, requests } = windowStore(chunkRows, chunkCols);
      await withFetch(handler, async () => {
        const opened = await openRecording("https://example.test/store/");
        const g = opened.groups[0];
        await g.viewLevelsReady;
        await opened.eventsReady;
        const chunkGets = () => requests.filter((p) => /\/c\//.test(p));

        // The reference: one read of every row fetches the distinct chunks of the window.
        requests.length = 0;
        const whole = await readLevel0(g, plan.startS, plan.endS, 0, ROWS);
        const distinct = new Set(chunkGets());
        expect(distinct.size).toBe(Math.ceil(ROWS / chunkRows) * Math.ceil(COLS / chunkCols));

        // The plan, in four slices: the same requests, none repeated.
        requests.length = 0;
        const outcome = await computeActivityPlan(
          plan,
          group,
          (r0, r1) => readLevel0(g, plan.startS, plan.endS, r0, r1),
          { sliceChannels: 4, yieldTask: async () => {} },
        );
        expect(chunkGets().length).toBe(distinct.size);
        expect(new Set(chunkGets()).size).toBe(chunkGets().length);

        // And the values are those of the window read whole.
        expect(outcome?.ok).toBe(true);
        if (!outcome?.ok) return;
        const adapted = activityChannelsFromWindow(
          whole,
          LABELS.map((label) => ({ label, unit: "V", nativeRateHz: 1000 })),
        );
        expect(adapted.ok).toBe(true);
        if (!adapted.ok) return;
        const direct = computeActivity({
          channels: adapted.channels,
          rateHz: 1000,
          unit: adapted.unit,
          metric: "rms",
          displayUnit: "µV",
        });
        expect(direct.ok).toBe(true);
        if (!direct.ok) return;
        expect(outcome.report.channels.map((c) => c?.value)).toEqual(
          direct.channels.map((c) => c.value),
        );
      });
    });
  }

  it("a plan that names only some rows still reads the chunks of its span once", async () => {
    const { handler, requests } = windowStore(5, 1000);
    await withFetch(handler, async () => {
      const opened = await openRecording("https://example.test/store/");
      const g = opened.groups[0];
      await g.viewLevelsReady;
      await opened.eventsReady;
      requests.length = 0;
      const rows = [0, 1, 2, 3, 10, 11];
      await computeActivityPlan(
        { ...plan, rows },
        group,
        (r0, r1) => readLevel0(g, plan.startS, plan.endS, r0, r1),
        { sliceChannels: 2, yieldTask: async () => {} },
      );
      const gets = requests.filter((p) => /\/c\//.test(p));
      // Rows 0 to 11 lie in three chunk rows (0 to 4, 5 to 9, 10 to 14), two column chunks each.
      expect(gets.length).toBe(3 * 2);
      expect(new Set(gets).size).toBe(gets.length);
    });
  });
});

describe("the cursor measure keeps the read it computed", () => {
  it("retains the located rows' samples and a fixed scale, with no second read", async () => {
    const { handler, requests } = windowStore(14, 1000);
    await withFetch(handler, async () => {
      const opened = await openRecording("https://example.test/store/");
      const g = opened.groups[0];
      await g.viewLevelsReady;
      await opened.eventsReady;
      const rows = [0, 3, 4, 9];
      const read = (r0: number, r1: number) => readLevel0(g, plan.startS, plan.endS, r0, r1);
      const base = await computeActivityPlan({ ...plan, rows }, group, read, {
        yieldTask: async () => {},
      });
      requests.length = 0;
      const outcome = await computeActivityPlan({ ...plan, rows, cursorMs: 200 }, group, read, {
        yieldTask: async () => {},
      });
      const reads = requests.filter((p) => /\/c\//.test(p)).length;
      expect(outcome?.ok && base?.ok).toBe(true);
      if (!outcome?.ok || !base?.ok) return;
      // The whole-window values are exactly those of the plain plan.
      expect(outcome.report.channels.map((c) => c?.value)).toEqual(
        base.report.channels.map((c) => c?.value),
      );
      expect(base.matrix).toBeNull();
      expect(base.report.cursorScale).toBeNull();
      // The matrix holds the located rows only, at the read's own length and start.
      const m = outcome.matrix;
      expect(m?.nSamples).toBe(COLS);
      expect(m?.t0S).toBe(0);
      expect(m?.rows.map((r, i) => (r === null ? null : i))).toEqual(
        Array.from({ length: ROWS }, (_, i) => (rows.includes(i) ? i : null)),
      );
      expect(outcome.report.cursorScale?.kind).toBe("sequential");
      // A cursor window as long as the read gives the whole-window value of the same metric.
      if (!m) return;
      const out = new Float64Array(rows.length);
      shortWindowValues(m, COLS / 2000, 2000, "rms", rows, out);
      rows.forEach((row, k) => {
        expect(out[k]).toBeCloseTo(outcome.report.channels[row]?.value as number, 5);
      });
      // Measuring at the cursor afterwards asks the store for nothing more than the one read did.
      const before = requests.length;
      for (let c = 0.1; c < 1.9; c += 0.01) shortWindowValues(m, c, 200, "rms", rows, out);
      expect(requests.length).toBe(before);
      expect(reads).toBe(1 * Math.ceil(COLS / 1000));
    });
  });
});
