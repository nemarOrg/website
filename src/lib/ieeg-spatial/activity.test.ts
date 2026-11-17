import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { WindowData } from "../eeg-viewer/store";
import { VIRIDIS_CSS, viridisColor } from "../eeg-viewer/topo";
import {
  BANDS,
  type BandName,
  DIVERGING_CSS,
  activityChannelsFromWindow,
  buildScale,
  colorFor,
  computeActivity,
  divergingColor,
  minWindowSamples,
  welchSegmentSamples,
} from "./activity";

const FIXTURE_DIR = new URL("../../../test/fixtures/ieeg-activity/", import.meta.url);

interface Sources {
  rate_hz: number;
  slice: { file: string; n_channels: number; n_samples: number; channel_labels: string[] };
}
interface Reference {
  channels: {
    rms: number;
    line_length: number;
    band_power: Record<BandName, number>;
    broadband_1_150: number;
  }[];
}

const sources = JSON.parse(readFileSync(new URL("SOURCES.json", FIXTURE_DIR), "utf8")) as Sources;
const reference = JSON.parse(
  readFileSync(new URL("reference.json", FIXTURE_DIR), "utf8"),
) as Reference;

/** The captured level-0 slice as the viewer's own `WindowData` (volts, as `readLevel0` returns). */
function fixtureWindow(level = 0): WindowData {
  const bytes = readFileSync(new URL(sources.slice.file, FIXTURE_DIR));
  const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const { n_channels: nCh, n_samples: nCols } = sources.slice;
  expect(all.length).toBe(nCh * nCols);
  return {
    level,
    nCols,
    channels: Array.from({ length: nCh }, (_, i) => ({
      kind: "line" as const,
      line: all.slice(i * nCols, (i + 1) * nCols),
    })),
  };
}

function sine(amplitude: number, hz: number, rate: number, seconds: number): Float64Array {
  const n = Math.round(rate * seconds);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return x;
}

function relErr(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

function ok<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) throw new Error(`expected an ok outcome, got ${JSON.stringify(outcome)}`);
  return outcome as Extract<T, { ok: true }>;
}

describe("known-answer inputs (analytic signals)", () => {
  const x = sine(100, 10, 1000, 4);
  const channels = [{ label: "s", samples: x }];

  it("rms of a 10 Hz sine of amplitude 100 is 100/sqrt(2), and its power sits in alpha", () => {
    const rms = ok(computeActivity({ channels, rateHz: 1000, unit: "uV", metric: "rms" }));
    expect(relErr(rms.channels[0].value as number, 100 / Math.SQRT2)).toBeLessThan(0.005);
    expect(rms.unit).toBe("µV");

    const powers = Object.fromEntries(
      (Object.keys(BANDS) as BandName[]).map((band) => [
        band,
        ok(computeActivity({ channels, rateHz: 1000, unit: "uV", metric: "band_power", band }))
          .channels[0].value as number,
      ]),
    ) as Record<BandName, number>;
    const total = Object.values(powers).reduce((s, v) => s + v, 0);
    expect(powers.alpha / total).toBeGreaterThan(0.95);
    // The density is normalized by the window's energy, so the 1 to 150 Hz total is the
    // sine's variance, amplitude squared over two.
    expect(relErr(total, (100 * 100) / 2)).toBeLessThan(0.02);

    const rel = ok(
      computeActivity({
        channels,
        rateHz: 1000,
        unit: "uV",
        metric: "band_power",
        band: "alpha",
        relative: true,
      }),
    );
    expect(rel.unit).toBe("dB");
    expect(rel.referenceHz).toEqual([1, 150]);
    expect(rel.channels[0].value as number).toBeLessThan(0);
    expect(rel.channels[0].value as number).toBeGreaterThan(-0.5);
    expect(rel.channels[0].value as number).toBeCloseTo(10 * Math.log10(powers.alpha / total), 6);
  });

  it("band power carries its unit squared, and converts a display unit", () => {
    const volts = Float64Array.from(x, (v) => v * 1e-6);
    const power = ok(
      computeActivity({
        channels: [{ label: "s", samples: volts }],
        rateHz: 1000,
        unit: "V",
        displayUnit: "µV",
        metric: "band_power",
        band: "alpha",
      }),
    );
    expect(power.unit).toBe("µV²");
    expect(relErr(power.channels[0].value as number, (100 * 100) / 2)).toBeLessThan(0.05);
  });

  it("line length of a ramp of step 3 at 1000 Hz is 3000 per second", () => {
    const ramp = Float64Array.from({ length: 50 }, (_, i) => 3 * i);
    const r = ok(
      computeActivity({
        channels: [{ label: "r", samples: ramp }],
        rateHz: 1000,
        unit: "uV",
        metric: "line_length",
      }),
    );
    expect(r.channels[0].value).toBeCloseTo(3000, 9);
    expect(r.unit).toBe("µV/s");
  });

  it("rms ignores a constant offset, and a non-finite sample yields no value", () => {
    const square = Float64Array.from({ length: 200 }, (_, i) => 5 + (i % 2 ? 2 : -2));
    const r = ok(
      computeActivity({
        channels: [
          { label: "sq", samples: square },
          {
            label: "bad",
            samples: Float64Array.from(square, (v, i) => (i === 7 ? Number.NaN : v)),
          },
        ],
        rateHz: 1000,
        unit: "uV",
        metric: "rms",
      }),
    );
    expect(r.channels[0].value).toBeCloseTo(2, 12);
    expect(r.channels[1].value).toBeNull();
  });
});

describe("the captured on006136 level-0 slice against SciPy", () => {
  const win = fixtureWindow();
  const adapted = ok(activityChannelsFromWindow(win, sources.slice.channel_labels));
  const base = {
    channels: adapted.channels,
    rateHz: sources.rate_hz,
    unit: "V",
    displayUnit: "µV",
  };

  it("rms and alpha band power per channel are within 1 percent of the reference", () => {
    const rms = ok(computeActivity({ ...base, metric: "rms" }));
    const alpha = ok(computeActivity({ ...base, metric: "band_power", band: "alpha" }));
    expect(rms.channels).toHaveLength(reference.channels.length);
    expect(alpha.segments).toBe(2);
    expect(alpha.segmentSamples).toBe(1024);
    reference.channels.forEach((ref, i) => {
      expect(rms.channels[i].label).toBe(sources.slice.channel_labels[i]);
      expect(relErr(rms.channels[i].value as number, ref.rms)).toBeLessThan(0.01);
      expect(relErr(alpha.channels[i].value as number, ref.band_power.alpha)).toBeLessThan(0.01);
    });
  });

  it("line length, every other band and the relative form match as well", () => {
    const ll = ok(computeActivity({ ...base, metric: "line_length" }));
    reference.channels.forEach((ref, i) => {
      expect(relErr(ll.channels[i].value as number, ref.line_length)).toBeLessThan(0.01);
    });
    for (const band of Object.keys(BANDS) as BandName[]) {
      const p = ok(computeActivity({ ...base, metric: "band_power", band }));
      const rel = ok(computeActivity({ ...base, metric: "band_power", band, relative: true }));
      reference.channels.forEach((ref, i) => {
        expect(relErr(p.channels[i].value as number, ref.band_power[band])).toBeLessThan(0.01);
        const refDb = 10 * Math.log10(ref.band_power[band] / ref.broadband_1_150);
        expect(Math.abs((rel.channels[i].value as number) - refDb)).toBeLessThan(0.05);
      });
    }
  });

  it("refuses a view-level window: min/max envelopes are not samples", () => {
    const refused = activityChannelsFromWindow(fixtureWindow(1), sources.slice.channel_labels);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("not_level0");
    const band = activityChannelsFromWindow(
      {
        level: 0,
        nCols: 2,
        channels: [{ kind: "band", min: new Float32Array(2), max: new Float32Array(2) }],
      },
      ["x"],
    );
    expect(band.ok).toBe(false);
  });
});

describe("refusals", () => {
  const x = sine(50, 20, 250, 8);

  it("refuses high gamma at 250 Hz with band_above_nyquist", () => {
    const r = computeActivity({
      channels: [{ label: "s", samples: x }],
      rateHz: 250,
      unit: "uV",
      metric: "band_power",
      band: "high_gamma",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("band_above_nyquist");
  });

  it("holds the limit at 0.45 of the rate, not at the full Nyquist frequency", () => {
    const at = (rateHz: number) =>
      computeActivity({
        channels: [{ label: "s", samples: sine(50, 20, rateHz, 8) }],
        rateHz,
        unit: "uV",
        metric: "band_power",
        band: "high_gamma",
      });
    // 150 Hz is below Nyquist at 300 Hz (150 is not above 150) but above 0.45 * 300 = 135.
    const refused = at(300);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("band_above_nyquist");
    expect(at(340).ok).toBe(true);
    // Low gamma (70 Hz) is carried at 250 Hz: 70 is below 112.5.
    expect(
      computeActivity({
        channels: [{ label: "s", samples: x }],
        rateHz: 250,
        unit: "uV",
        metric: "band_power",
        band: "low_gamma",
      }).ok,
    ).toBe(true);
  });

  it("refuses a window shorter than two Welch segments", () => {
    expect(welchSegmentSamples(1000)).toBe(1024);
    expect(welchSegmentSamples(250)).toBe(256);
    expect(minWindowSamples(1000)).toBe(1536);
    const at = (n: number) =>
      computeActivity({
        channels: [{ label: "s", samples: sine(10, 10, 1000, 4).subarray(0, n) }],
        rateHz: 1000,
        unit: "uV",
        metric: "band_power",
        band: "alpha",
      });
    const short = at(1535);
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.reason).toBe("window_too_short");
    expect(ok(at(1536)).segments).toBe(2);
  });

  it("refuses unusable input by reason word", () => {
    const channels = [{ label: "s", samples: x }];
    const reasons = [
      computeActivity({ channels, rateHz: 0, unit: "uV", metric: "rms" }),
      computeActivity({ channels: [], rateHz: 250, unit: "uV", metric: "rms" }),
      computeActivity({ channels, rateHz: 250, unit: "uV", metric: "band_power" }),
      computeActivity({
        channels,
        rateHz: 250,
        unit: "furlongs",
        displayUnit: "µV",
        metric: "rms",
      }),
      computeActivity({
        channels: [...channels, { label: "t", samples: x.subarray(0, 10) }],
        rateHz: 250,
        unit: "uV",
        metric: "rms",
      }),
    ];
    for (const r of reasons) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("bad_input");
    }
  });
});

describe("color scales", () => {
  it("zscore limits are symmetric about zero", () => {
    // A skewed set: min and max are not mirror images, so only a symmetric rule gives lo = -hi.
    const values = [1, 2, 2, 3, 3, 4, 20];
    const scale = buildScale(values, "zscore", "µV");
    expect(scale.unit).toBe("z");
    expect(scale.hi).toBeGreaterThan(0);
    expect(scale.lo).toBe(-scale.hi);
    expect(scale.mean).toBeCloseTo(5, 12);
    expect(scale.css).toBe(DIVERGING_CSS);
    // The mean is the neutral middle color; a value above it is warmer (more red than blue).
    expect(colorFor(scale, 5)).toEqual(divergingColor(0));
    const high = colorFor(scale, 20) as number[];
    expect(high[0]).toBeGreaterThan(high[2]);
    const low = colorFor(scale, 1) as number[];
    expect(low[2]).toBeGreaterThan(low[0]);
  });

  it("sequential limits are the 2nd and 98th percentiles of the located channels", () => {
    const values = Array.from({ length: 101 }, (_, i) => i);
    values.push(1e6); // an unlocated outlier must not stretch the scale
    const located = values.map((_, i) => i < 101);
    const scale = buildScale(values, "sequential", "µV", located);
    expect(scale.lo).toBeCloseTo(2, 12);
    expect(scale.hi).toBeCloseTo(98, 12);
    expect(scale.unit).toBe("µV");
    expect(scale.css).toBe(VIRIDIS_CSS);
    expect(scale.nLocated).toBe(101);
    // Clipped at the ends; the middle lands mid-scale.
    expect(colorFor(scale, 0)).toEqual(viridisColor(-1));
    expect(colorFor(scale, 1e6)).toEqual(viridisColor(1));
    expect(colorFor(scale, 50)).toEqual(viridisColor(0));
  });

  it("paints no data as null and flat or empty inputs as the middle color", () => {
    const flat = buildScale([4, 4, 4], "sequential", "µV");
    expect(flat.degenerate).toBe(true);
    expect(colorFor(flat, 4)).toEqual(viridisColor(0));
    expect(colorFor(flat, null)).toBeNull();
    expect(colorFor(flat, Number.NaN)).toBeNull();
    const none = buildScale([null, Number.NaN], "zscore", "µV");
    expect(none.degenerate).toBe(true);
    expect(none.nLocated).toBe(0);
    expect(colorFor(none, 1)).toEqual(divergingColor(0));
    expect(buildScale([2, 2], "zscore", "µV").degenerate).toBe(true);
  });
});
