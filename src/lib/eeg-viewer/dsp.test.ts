import { describe, expect, it } from "vitest";
import {
  channelColor,
  defaultScaling,
  dequantize,
  formatClock,
  niceScale,
  pickViewLevel,
  removeDcInPlace,
} from "./dsp";

describe("dequantize", () => {
  it("applies physical = digital * scale + offset", () => {
    expect(dequantize(100, 0.5e-6, 0)).toBeCloseTo(50e-6, 12);
    expect(dequantize(0, 1, 3)).toBe(3);
  });
  it("is identity for a float32 store (scale=1, offset=0)", () => {
    expect(dequantize(42.5, 1, 0)).toBe(42.5);
  });
});

describe("removeDcInPlace", () => {
  it("subtracts the window mean so the result is zero-mean", () => {
    const row = new Float32Array([1, 2, 3, 4]);
    removeDcInPlace(row);
    const mean = row.reduce((a, b) => a + b, 0) / row.length;
    expect(mean).toBeCloseTo(0, 6);
    expect(Array.from(row)).toEqual([-1.5, -0.5, 0.5, 1.5]);
  });
  it("handles an empty row", () => {
    expect(removeDcInPlace(new Float32Array([])).length).toBe(0);
  });
});

describe("defaultScaling", () => {
  it("returns MNE-like per-modality defaults", () => {
    expect(defaultScaling("EEG")).toBeCloseTo(20e-6, 12);
    expect(defaultScaling("EMG")).toBeCloseTo(1e-3, 9);
    expect(defaultScaling("MEG")).toBeCloseTo(1e-12, 15);
  });
});

describe("channelColor", () => {
  it("colors known types and falls back for unknown/missing", () => {
    expect(channelColor("EEG")).toBe("#0072B2");
    expect(channelColor("eog")).toBe("#009E73");
    expect(channelColor(undefined)).toBe("#666666");
    expect(channelColor("WEIRD")).toBe("#666666");
  });
});

describe("pickViewLevel", () => {
  // level 0 = 250000 samples (full), then halving pyramid.
  const levels = [250000, 125000, 62500, 31250, 15625];
  it("picks the coarsest level for a wide window", () => {
    // whole recording at 1000px: coarsest level whose samples >= 1000 is index 4
    // (15625 >= 1000), so we transfer the smallest envelope that still covers it.
    expect(pickViewLevel(levels, 1.0, 1000)).toBe(4);
  });
  it("picks finer levels as the window narrows", () => {
    // 1% visible, 1000px: level L visible = levels[L]*0.01 ; need >=1000 -> levels[L]>=100000
    expect(pickViewLevel(levels, 0.01, 1000)).toBe(1); // 125000*.01=1250>=1000, 62500*.01=625<1000
  });
  it("falls back to level 0 when even it is too sparse", () => {
    expect(pickViewLevel([800], 1.0, 1000)).toBe(0);
  });
  it("returns 0 for an empty pyramid", () => {
    expect(pickViewLevel([], 1, 1000)).toBe(0);
  });
});

describe("formatClock", () => {
  it("formats seconds as HH:MM:SS", () => {
    expect(formatClock(0)).toBe("00:00:00");
    expect(formatClock(3661)).toBe("01:01:01");
    expect(formatClock(59.9)).toBe("00:00:59");
  });
});

describe("niceScale", () => {
  it("rounds to 1/2/5 x 10^n", () => {
    expect(niceScale(18e-6)).toBeCloseTo(10e-6, 12);
    expect(niceScale(23e-6)).toBeCloseTo(20e-6, 12);
    expect(niceScale(70e-6)).toBeCloseTo(50e-6, 12);
    expect(niceScale(130e-6)).toBeCloseTo(100e-6, 12);
  });
});
