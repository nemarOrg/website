import { describe, expect, it } from "vitest";
import { designFilters, filtfilt, hasFilters } from "./filters";

const FS = 250;

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

function sine(freq: number, n: number, fs = FS): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * freq * i) / fs);
  return x;
}

describe("hasFilters / designFilters", () => {
  it("detects active filters and builds the cascade", () => {
    expect(hasFilters({})).toBe(false);
    expect(hasFilters({ hp: 0, lp: 0, notch: 0 })).toBe(false);
    expect(hasFilters({ hp: 0.5 })).toBe(true);
    expect(designFilters({ hp: 0.5, lp: 45, notch: 60 }, FS)).toHaveLength(3);
  });
  it("drops cutoffs at or above Nyquist", () => {
    expect(designFilters({ lp: 200 }, FS)).toHaveLength(0); // 200 > 125
    expect(designFilters({ hp: 1 }, FS)).toHaveLength(1);
  });
});

describe("filtfilt high-pass", () => {
  it("removes a DC offset", () => {
    const x = new Float32Array(1000).fill(5);
    const y = filtfilt(x, designFilters({ hp: 1 }, FS));
    // the steady-state middle should be ~0 (DC blocked)
    expect(Math.abs(y[500])).toBeLessThan(0.05);
  });
  it("passes a mid-band oscillation largely intact", () => {
    const x = sine(10, 1500);
    const y = filtfilt(x, designFilters({ hp: 1 }, FS));
    expect(rms(y) / rms(x)).toBeGreaterThan(0.8);
  });
});

describe("filtfilt low-pass", () => {
  it("attenuates a high-frequency tone and passes a low one", () => {
    const lp = designFilters({ lp: 20 }, FS);
    const hi = filtfilt(sine(60, 1500), lp);
    const lo = filtfilt(sine(5, 1500), lp);
    expect(rms(hi)).toBeLessThan(0.2); // 60 Hz well above 20 Hz cutoff
    expect(rms(lo) / rms(sine(5, 1500))).toBeGreaterThan(0.8);
  });
});

describe("filtfilt notch", () => {
  it("suppresses the notch frequency but keeps neighbors", () => {
    const n = designFilters({ notch: 60 }, FS);
    const at = filtfilt(sine(60, 2000), n);
    const off = filtfilt(sine(20, 2000), n);
    expect(rms(at)).toBeLessThan(0.3);
    expect(rms(off) / rms(sine(20, 2000))).toBeGreaterThan(0.9);
  });
});

describe("filtfilt", () => {
  it("is zero-phase: a symmetric input stays symmetric", () => {
    const n = 401;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.exp(-(((i - 200) / 20) ** 2)); // gaussian bump at center
    const y = filtfilt(x, designFilters({ lp: 30 }, FS));
    // peak stays centered (no phase shift)
    let peak = 0;
    for (let i = 0; i < n; i++) if (y[i] > y[peak]) peak = i;
    expect(Math.abs(peak - 200)).toBeLessThanOrEqual(1);
  });
  it("returns a copy with no biquads", () => {
    const x = new Float32Array([1, 2, 3]);
    const y = filtfilt(x, []);
    expect(Array.from(y)).toEqual([1, 2, 3]);
    expect(y).not.toBe(x);
  });
});
