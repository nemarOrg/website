import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ActivityMatrix,
  CURSOR_WIDTHS_MS,
  NO_REASON,
  REASON_NON_FINITE,
  REASON_UNDEFINED,
  computeActivity,
  cursorScale,
  cursorWindowBounds,
  cursorWindowSamples,
  displayFactor,
  shortWindowValue,
  shortWindowValues,
} from "./activity";
import { createLiveActivity, lutChannel, lutIndex } from "./live-activity";

// The committed real slice: 14 channels of a 1000 Hz human iEEG recording, 2 s, in volts, with
// reference values computed outside this code (activity.test.ts uses the same files).
const DIR = new URL("../../../test/fixtures/ieeg-activity/", import.meta.url);
const sources = JSON.parse(readFileSync(new URL("SOURCES.json", DIR), "utf8")) as {
  rate_hz: number;
  slice: { file: string; n_channels: number; n_samples: number };
};
const reference = JSON.parse(readFileSync(new URL("reference.json", DIR), "utf8")) as {
  channels: { rms: number; line_length: number }[];
};
const { n_channels: CH, n_samples: N } = sources.slice;
const RATE = sources.rate_hz;

function fixtureRows(): Float32Array[] {
  const bytes = readFileSync(new URL(sources.slice.file, DIR));
  const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return Array.from({ length: CH }, (_, i) => all.slice(i * N, (i + 1) * N));
}

function matrixOf(rows: ArrayLike<number>[], t0S = 300, rateHz = RATE): ActivityMatrix {
  return {
    t0S,
    rateHz,
    nSamples: rows[0].length,
    factor: displayFactor("V"),
    rows,
  };
}

const ALL_ROWS = Array.from({ length: CH }, (_, i) => i);
const relErr = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe("the short window at a cursor", () => {
  it("holds round(rate * width) samples, and the offered widths are all measurable at 1000 Hz", () => {
    expect(cursorWindowSamples(1000, 200)).toBe(200);
    expect(cursorWindowSamples(512, 50)).toBe(26);
    for (const ms of CURSOR_WIDTHS_MS)
      expect(cursorWindowSamples(1000, ms)).toBeGreaterThanOrEqual(2);
  });

  it("is centered, and clipped (not shifted) at the edges of the read", () => {
    const m = { t0S: 10, rateHz: 1000, nSamples: 2000 };
    // 200 samples centered on sample 1000: [900, 1100).
    expect(cursorWindowBounds(m, 11, 200)).toEqual({ i0: 900, i1: 1100, clipped: false });
    // At the start only the samples from 0 on remain, still centered on sample 20.
    const start = cursorWindowBounds(m, 10.02, 200);
    expect(start?.i0).toBe(0);
    expect(start?.clipped).toBe(true);
    expect((start?.i1 ?? 0) - 1).toBe(119);
    // At the end likewise.
    const end = cursorWindowBounds(m, 11.98, 200);
    expect(end?.i1).toBe(2000);
    expect(end?.clipped).toBe(true);
    expect(end?.i0).toBe(1880);
  });

  it("keeps a cursor exactly at either end of the read, and refuses one a hair past it", () => {
    // Sample i spans [i, i + 1) / rate after t0S, so the read covers [t0S, t0S + nSamples / rate].
    const m = { t0S: 10, rateHz: 1000, nSamples: 2000 };
    expect(cursorWindowBounds(m, 10, 200)).toEqual({ i0: 0, i1: 100, clipped: true });
    expect(cursorWindowBounds(m, 12, 200)).toEqual({ i0: 1900, i1: 2000, clipped: true });
    expect(cursorWindowBounds(m, 10 - 1e-4, 200)).toBeNull();
    expect(cursorWindowBounds(m, 12 + 1e-4, 200)).toBeNull();
    // Half a sample inside either edge is on the read too.
    expect(cursorWindowBounds(m, 10.0005, 200)).not.toBeNull();
    expect(cursorWindowBounds(m, 11.9995, 200)).not.toBeNull();
  });

  it("refuses a center outside the read, a non-number, and a window under two samples", () => {
    const m = { t0S: 10, rateHz: 1000, nSamples: 2000 };
    expect(cursorWindowBounds(m, 9, 200)).toBeNull();
    expect(cursorWindowBounds(m, 12.5, 200)).toBeNull();
    expect(cursorWindowBounds(m, Number.NaN, 200)).toBeNull();
    // 1 ms at 1000 Hz is one sample; 1000 Hz with width 1 ms is too short for any measure.
    expect(cursorWindowBounds(m, 11, 1)).toBeNull();
    // A rate too low for the width: 20 Hz, 50 ms is one sample.
    expect(cursorWindowBounds({ ...m, rateHz: 20 }, 11, 50)).toBeNull();
  });

  it("over the whole read equals the whole-window metric and the external reference", () => {
    const rows = fixtureRows();
    const m = matrixOf(rows);
    // Width of exactly the read: 2000 ms.
    const rms = new Float64Array(CH);
    const ll = new Float64Array(CH);
    expect(shortWindowValues(m, 301 - 0.0005, 2000, "rms", ALL_ROWS, rms)).not.toBeNull();
    expect(shortWindowValues(m, 301 - 0.0005, 2000, "line_length", ALL_ROWS, ll)).not.toBeNull();
    const whole = computeActivity({
      channels: rows.map((samples, i) => ({ label: String(i), samples })),
      rateHz: RATE,
      unit: "V",
      metric: "rms",
      displayUnit: "µV",
    });
    if (!whole.ok) throw new Error("whole-window read refused");
    reference.channels.forEach((ref, i) => {
      expect(rms[i]).toBeCloseTo(whole.channels[i].value as number, 6);
      expect(relErr(rms[i], ref.rms)).toBeLessThan(0.01);
      expect(relErr(ll[i], ref.line_length)).toBeLessThan(0.01);
    });
  });

  it("matches a hand formula on a known signal: a 10 Hz sine of amplitude 100 µV is 100/sqrt(2)", () => {
    const x = new Float64Array(2000);
    for (let i = 0; i < x.length; i++) x[i] = 100e-6 * Math.sin((2 * Math.PI * 10 * i) / 1000);
    const m = matrixOf([x], 0);
    const out = new Float64Array(1);
    // 100 ms is one whole period; any center away from the edges gives the same RMS.
    shortWindowValues(m, 1.0, 100, "rms", [0], out);
    expect(relErr(out[0], 100 / Math.SQRT2)).toBeLessThan(0.002);
    // Line length of a sine over a whole period: 4 * A per half... mean |dx| * rate = 4 A f.
    shortWindowValues(m, 1.0, 100, "line_length", [0], out);
    expect(relErr(out[0], 4 * 100 * 10)).toBeLessThan(0.01);
  });

  it("removes the mean, so a constant offset changes nothing", () => {
    const x = new Float64Array(400);
    const y = new Float64Array(400);
    for (let i = 0; i < 400; i++) {
      x[i] = Math.sin(i / 7);
      y[i] = x[i] + 5;
    }
    expect(shortWindowValue(y, 100, 300, "rms", 1000, 1)).toBeCloseTo(
      shortWindowValue(x, 100, 300, "rms", 1000, 1),
      9,
    );
  });

  it("gives NaN for a window holding a non-finite sample, and only for that channel", () => {
    const rows = fixtureRows();
    const bad = Float32Array.from(rows[3]);
    bad[1000] = Number.NaN;
    rows[3] = bad;
    const m = matrixOf(rows);
    const out = new Float64Array(CH);
    shortWindowValues(m, 301, 200, "rms", ALL_ROWS, out);
    expect(Number.isNaN(out[3])).toBe(true);
    expect(Number.isFinite(out[2])).toBe(true);
    // The same channel is fine where the window does not hold the bad sample.
    shortWindowValues(m, 300.3, 200, "rms", ALL_ROWS, out);
    expect(Number.isFinite(out[3])).toBe(true);
    shortWindowValues(m, 301, 200, "line_length", ALL_ROWS, out);
    expect(Number.isNaN(out[3])).toBe(true);
  });

  it("converts to the display unit: volts to microvolts, tesla unchanged", () => {
    expect(displayFactor("V")).toBeCloseTo(1e6, 3);
    expect(displayFactor("T")).toBe(1);
    const x = Float32Array.from({ length: 400 }, (_, i) => (i % 2 ? 1e-6 : -1e-6));
    const volts = shortWindowValue(x, 0, 400, "rms", 1000, displayFactor("V"));
    expect(volts).toBeCloseTo(1, 4);
  });

  it("writes nothing when the center is outside the read", () => {
    const m = matrixOf(fixtureRows());
    const out = new Float64Array(CH).fill(-7);
    expect(shortWindowValues(m, 50, 200, "rms", ALL_ROWS, out)).toBeNull();
    expect(out.every((v) => v === -7)).toBe(true);
  });
});

describe("the color scale of the cursor measure", () => {
  const yieldNow = () => Promise.resolve();

  it("is a fixed 2nd to 98th percentile of the short-window values across the read", async () => {
    const m = matrixOf(fixtureRows());
    const scale = await cursorScale(
      m,
      200,
      "rms",
      ALL_ROWS,
      ALL_ROWS.map((r) => [r]),
      "µV",
      yieldNow,
    );
    expect(scale).not.toBeNull();
    if (!scale) return;
    expect(scale.kind).toBe("sequential");
    expect(scale.unit).toBe("µV");
    expect(scale.lo).toBeGreaterThan(0);
    expect(scale.hi).toBeGreaterThan(scale.lo);
    // Every cursor position then colors against these limits: they do not depend on the cursor.
    const again = await cursorScale(
      m,
      200,
      "rms",
      ALL_ROWS,
      ALL_ROWS.map((r) => [r]),
      "µV",
      yieldNow,
    );
    expect(again?.lo).toBe(scale.lo);
    expect(again?.hi).toBe(scale.hi);
    // The limits lie inside the range of the values the percentiles came from.
    const out = new Float64Array(CH);
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (let c = 300.1; c < 301.9; c += 0.05) {
      shortWindowValues(m, c, 200, "rms", ALL_ROWS, out);
      for (const v of out) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    expect(scale.lo).toBeGreaterThanOrEqual(min * 0.5);
    expect(scale.hi).toBeLessThanOrEqual(max * 1.01);
  });

  it("is null for a read shorter than two samples or a window too short for the rate", async () => {
    const one = matrixOf([new Float32Array(1)]);
    expect(await cursorScale(one, 200, "rms", [0], [[0]], "µV", yieldNow)).toBeNull();
    const slow = matrixOf(fixtureRows(), 300, 20);
    expect(
      await cursorScale(
        slow,
        50,
        "rms",
        ALL_ROWS,
        ALL_ROWS.map((r) => [r]),
        "µV",
        yieldNow,
      ),
    ).toBeNull();
  });

  it("a read shorter than the window still gets a scale from the clipped window", async () => {
    const m = matrixOf(fixtureRows().map((r) => r.slice(0, 100)));
    const scale = await cursorScale(
      m,
      500,
      "rms",
      ALL_ROWS,
      ALL_ROWS.map((r) => [r]),
      "µV",
      yieldNow,
    );
    expect(scale).not.toBeNull();
  });
});

describe("the live recolor engine", () => {
  const yieldNow = () => Promise.resolve();

  async function engine() {
    const m = matrixOf(fixtureRows());
    const scale = await cursorScale(
      m,
      200,
      "rms",
      ALL_ROWS,
      ALL_ROWS.map((r) => [r]),
      "µV",
      yieldNow,
    );
    if (!scale) throw new Error("no scale");
    // One contact per channel, plus a bipolar contact fed by channels 0 and 1.
    const contactRows = [...ALL_ROWS.map((r) => [r]), [0, 1]];
    const live = createLiveActivity({
      matrix: m,
      rows: ALL_ROWS,
      contactRows,
      metric: "rms",
      widthMs: 200,
      scale,
    });
    return { m, live, scale };
  }

  it("a bipolar contact takes the mean of its channels, and indexes follow the scale", async () => {
    const { live, scale } = await engine();
    expect(live.update(301)).toBe(true);
    const v = live.contactValues;
    expect(v[CH]).toBeCloseTo((v[0] + v[1]) / 2, 9);
    for (let i = 0; i <= CH; i++) {
      expect(live.indexes[i]).toBe(lutIndex(scale, v[i]));
    }
  });

  it("the table color is within one 8-bit step of the exact viridis color", () => {
    for (const t of [0, 0.1, 0.37, 0.5, 0.93, 1]) {
      const exact = lutChannel(Math.round(t * 255), 1);
      expect(exact).toBeGreaterThanOrEqual(0);
      expect(exact).toBeLessThanOrEqual(255);
    }
    expect([lutChannel(0, 0), lutChannel(0, 1), lutChannel(0, 2)]).toEqual([68, 1, 84]);
    expect([lutChannel(255, 0), lutChannel(255, 1), lutChannel(255, 2)]).toEqual([253, 231, 37]);
  });

  it("moving the cursor across the read changes at least two contacts' entries", async () => {
    const { live } = await engine();
    live.update(300.2);
    const before = Int16Array.from(live.indexes);
    live.update(301.0);
    live.update(301.8);
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== live.indexes[i]) changed++;
    expect(changed).toBeGreaterThanOrEqual(2);
  });

  it("changed is relative to the last commit: a call that does not paint never consumes it", async () => {
    const { live } = await engine();
    // Before the first paint every entry counts as changed.
    expect(live.anyChanged).toBe(true);
    live.update(301);
    live.update(301);
    live.update(301);
    expect(Array.from(live.changed).every((c) => c === 1)).toBe(true);
    live.commit();
    expect(live.anyChanged).toBe(false);
    expect(live.update(301)).toBe(true);
    expect(live.anyChanged).toBe(false);
    live.invalidate();
    expect(live.anyChanged).toBe(true);
    live.update(301);
    expect(Array.from(live.changed).every((c) => c === 1)).toBe(true);
    live.commit();
    live.update(300.2);
    expect(live.anyChanged).toBe(true);
  });

  it("a center off the read changes nothing and returns false", async () => {
    const { live } = await engine();
    live.update(301);
    const before = Int16Array.from(live.indexes);
    expect(live.update(900)).toBe(false);
    expect(Array.from(live.indexes)).toEqual(Array.from(before));
  });

  it("gives -1 (no value) to a contact whose channel holds a non-number in the window", async () => {
    const rows = fixtureRows();
    const bad = Float32Array.from(rows[2]);
    bad[1000] = Number.POSITIVE_INFINITY;
    rows[2] = bad;
    const m = matrixOf(rows);
    const scale = await cursorScale(
      m,
      200,
      "rms",
      ALL_ROWS,
      ALL_ROWS.map((r) => [r]),
      "µV",
      yieldNow,
    );
    if (!scale) throw new Error("no scale");
    const live = createLiveActivity({
      matrix: m,
      rows: ALL_ROWS,
      contactRows: ALL_ROWS.map((r) => [r]),
      metric: "rms",
      widthMs: 200,
      scale,
    });
    live.update(301);
    expect(live.indexes[2]).toBe(-1);
    expect(Number.isNaN(live.contactValues[2])).toBe(true);
    expect(live.indexes[1]).toBeGreaterThanOrEqual(0);
  });

  it("allocates nothing per update beyond the engine's own arrays (heap stays flat over 5000 moves)", async () => {
    const { live } = await engine();
    live.update(301);
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let k = 0; k < 5000; k++) live.update(300.1 + (k % 170) / 100);
    const grew = process.memoryUsage().heapUsed - before;
    // 5000 updates of 15 contacts: a leaking per-update array would be tens of megabytes.
    expect(grew).toBeLessThan(8_000_000);
  });
});

describe("the cursor scale pools contact values, as the colors show them", () => {
  const yieldNow = () => Promise.resolve();

  it("with bipolar contacts the limits are percentiles of the pair means, not of the channels", async () => {
    // Two channels of very different size feed one contact; the scale must follow their mean.
    const small = Float32Array.from({ length: 2000 }, (_, i) => 1e-6 * Math.sin(i / 5));
    const large = Float32Array.from({ length: 2000 }, (_, i) => 100e-6 * Math.sin(i / 5));
    const m = matrixOf([small, large]);
    const pooled = await cursorScale(m, 200, "rms", [0, 1], [[0, 1]], "µV", yieldNow);
    const perChannel = await cursorScale(m, 200, "rms", [0, 1], [[0], [1]], "µV", yieldNow);
    const out = new Float64Array(2);
    shortWindowValues(m, 300.5, 200, "rms", [0, 1], out);
    const mean = (out[0] + out[1]) / 2;
    // One contact, so every pooled value is that contact's mean (about 50 µV): a narrow scale.
    expect(pooled?.hi).toBeCloseTo(mean, 0);
    expect(pooled?.lo).toBeCloseTo(mean, 0);
    // Pooling the raw channels would span 0.7 to 70 µV.
    expect(perChannel?.hi ?? 0).toBeGreaterThan(60);
    expect(perChannel?.lo ?? 1e9).toBeLessThan(5);
  });

  it("the engine colors a bipolar contact with the pair's mean on that same scale", async () => {
    const a = Float32Array.from({ length: 2000 }, (_, i) => 10e-6 * Math.sin(i / 5));
    const b = Float32Array.from({ length: 2000 }, (_, i) => 30e-6 * Math.sin(i / 5));
    const m = matrixOf([a, b]);
    const contactRows = [[0, 1], [1]];
    const scale = await cursorScale(m, 200, "rms", [0, 1], contactRows, "µV", yieldNow);
    if (!scale) throw new Error("no scale");
    const live = createLiveActivity({
      matrix: m,
      rows: [0, 1],
      contactRows,
      metric: "rms",
      widthMs: 200,
      scale,
    });
    live.update(301);
    const ch = new Float64Array(2);
    shortWindowValues(m, 301, 200, "rms", [0, 1], ch);
    expect(live.contactValues[0]).toBeCloseTo((ch[0] + ch[1]) / 2, 9);
    expect(live.contactValues[1]).toBeCloseTo(ch[1], 9);
  });
});

describe("why a contact has no value, as the whole-window metrics say it", () => {
  const yieldNow = () => Promise.resolve();
  const scaleFor = (m: ActivityMatrix) =>
    cursorScale(m, 200, "rms", [0, 1, 2], [[0], [1], [2]], "µV", yieldNow);

  it("a non-number is non_finite, an overflowed result is undefined_value, and a pair takes its first channel's reason", async () => {
    const ok = Float32Array.from({ length: 2000 }, (_, i) => 1e-6 * Math.sin(i / 5));
    const nan = Float32Array.from(ok);
    nan[1000] = Number.NaN;
    // Finite samples whose squares overflow a double: the result is not a number the panel can show.
    const huge = Float64Array.from(ok, (_, i) => (i % 2 ? 1e200 : -1e200));
    const m = matrixOf([ok, nan, huge]);
    const scale = await scaleFor(m);
    if (!scale) throw new Error("no scale");
    const live = createLiveActivity({
      matrix: m,
      rows: [0, 1, 2],
      contactRows: [[0], [1], [2], [1, 2], [2, 1], [0, 1]],
      metric: "rms",
      widthMs: 200,
      scale,
    });
    live.update(301);
    expect(Array.from(live.contactReasons)).toEqual([
      NO_REASON,
      REASON_NON_FINITE,
      REASON_UNDEFINED,
      REASON_NON_FINITE,
      REASON_UNDEFINED,
      NO_REASON,
    ]);
    expect(live.indexes[1]).toBe(-1);
    expect(live.indexes[2]).toBe(-1);
    // A pair with one good channel is colored by that channel.
    expect(Number.isFinite(live.contactValues[5])).toBe(true);
  });
});
