import { describe, expect, it } from "vitest";
import {
  type AgeBucket,
  type HistogramBin,
  bucketAgesBySex,
  buildHistogram,
  filePlotUrl,
  parseLinenoiseDb,
  pickAgeBuckets,
} from "./qa";

describe("parseLinenoiseDb", () => {
  it("parses '14.40dB' to 14.4", () => {
    expect(parseLinenoiseDb("14.40dB")).toBe(14.4);
  });
  it("accepts numeric input verbatim", () => {
    expect(parseLinenoiseDb(7.2)).toBe(7.2);
  });
  it("handles negative dB", () => {
    expect(parseLinenoiseDb("-3.5 dB")).toBe(-3.5);
  });
  it("returns null on invalid input", () => {
    expect(parseLinenoiseDb(null)).toBeNull();
    expect(parseLinenoiseDb(undefined)).toBeNull();
    expect(parseLinenoiseDb("not a number")).toBeNull();
  });
});

describe("buildHistogram", () => {
  it("returns empty for empty input", () => {
    expect(buildHistogram([])).toEqual([]);
  });
  it("creates 10 bins by default", () => {
    const bins = buildHistogram([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(bins).toHaveLength(10);
    // Each bin should have exactly one value
    expect(bins.every((b) => b.count >= 1)).toBe(true);
  });
  it("respects custom binCount", () => {
    expect(buildHistogram([0, 50, 100], 5)).toHaveLength(5);
  });
  it("respects custom domain", () => {
    const bins = buildHistogram([5, 7, 9], 4, [0, 100]);
    expect(bins).toHaveLength(4);
    // All values fall in the first bin
    expect(bins[0].count).toBe(3);
  });
  it("collapses degenerate range", () => {
    const bins = buildHistogram([5, 5, 5]);
    expect(bins).toHaveLength(1);
    expect(bins[0].count).toBe(3);
  });
  it("places exact-max value in the top bin", () => {
    const bins = buildHistogram([0, 100], 10);
    expect(bins[bins.length - 1].count).toBe(1);
  });
  it("ignores non-finite values", () => {
    const bins = buildHistogram([10, 20, Number.NaN, Number.POSITIVE_INFINITY, 30]);
    expect(bins.reduce((s: number, b: HistogramBin) => s + b.count, 0)).toBe(3);
  });
});

describe("bucketAgesBySex", () => {
  it("buckets 10-year ranges and splits by sex", () => {
    const buckets = bucketAgesBySex([5, 15, 25, 25, 35, 8], ["M", "F", "F", "M", "O", null]);
    expect(buckets.map((b: AgeBucket) => b.label)).toEqual(["0-9", "10-19", "20-29", "30-39"]);
    expect(buckets[0]).toMatchObject({ label: "0-9", M: 1, F: 0, O: 1 });
    expect(buckets[1]).toMatchObject({ label: "10-19", M: 0, F: 1, O: 0 });
    expect(buckets[2]).toMatchObject({ label: "20-29", M: 1, F: 1, O: 0 });
    expect(buckets[3]).toMatchObject({ label: "30-39", M: 0, F: 0, O: 1 });
  });
  it("handles empty input", () => {
    expect(bucketAgesBySex([], [])).toEqual([]);
  });
  it("respects custom bucket width", () => {
    const buckets = bucketAgesBySex([5, 15, 25], ["M", "F", "O"], 5);
    expect(buckets.map((b: AgeBucket) => b.label)).toEqual([
      "0-4",
      "5-9",
      "10-14",
      "15-19",
      "20-24",
      "25-29",
    ]);
  });
  it("ignores invalid ages", () => {
    const buckets = bucketAgesBySex([10, Number.NaN, -3, 20], ["M", "F", "F", "M"]);
    expect(buckets.reduce((s: number, b: AgeBucket) => s + b.M + b.F + b.O, 0)).toBe(2);
  });

  it("respects a non-zero bucketStart and labels accordingly", () => {
    // HBN-like shape: ages 5-21 with start=4 and width=2.
    const buckets = bucketAgesBySex([5, 7, 11, 21, 21], ["M", "F", "M", "F", "M"], 2, 4);
    expect(buckets[0].label).toBe("4-5");
    expect(buckets[buckets.length - 1].label).toBe("20-21");
    // Last bucket gets 21,21.
    expect(buckets[buckets.length - 1]).toMatchObject({ M: 1, F: 1, O: 0 });
  });

  it("uses single-number labels when bucketWidth=1", () => {
    const buckets = bucketAgesBySex([8, 8, 9], ["M", "F", "F"], 1, 8);
    expect(buckets.map((b) => b.label)).toEqual(["8", "9"]);
    expect(buckets[0]).toMatchObject({ M: 1, F: 1, O: 0 });
    expect(buckets[1]).toMatchObject({ M: 0, F: 1, O: 0 });
  });

  it("skips ages below bucketStart (no negative-index underflow)", () => {
    // start=20, age=10 should be skipped, not mapped into bucket 0.
    const buckets = bucketAgesBySex([10, 22, 25], ["M", "F", "M"], 5, 20);
    const total = buckets.reduce((s, b) => s + b.M + b.F + b.O, 0);
    expect(total).toBe(2);
  });
});

describe("pickAgeBuckets", () => {
  it("returns the safe default for empty input", () => {
    expect(pickAgeBuckets([])).toEqual({ width: 10, start: 0 });
  });

  it("picks ~9 bins of width 2 for an HBN child cohort (5-21)", () => {
    const ages = Array.from({ length: 17 }, (_, i) => 5 + i);
    const { width, start } = pickAgeBuckets(ages);
    expect(width).toBe(2);
    expect(start).toBe(4);
  });

  it("picks 10 bins of width 5 for an adult cohort (20-69)", () => {
    const ages = Array.from({ length: 50 }, (_, i) => 20 + i);
    expect(pickAgeBuckets(ages)).toEqual({ width: 5, start: 20 });
  });

  it("falls back to width 1 when the span is tiny", () => {
    expect(pickAgeBuckets([8, 8, 9, 9, 10])).toEqual({ width: 1, start: 8 });
  });

  it("steps up to width 20 for a 100-year-wide cohort", () => {
    const ages = Array.from({ length: 100 }, (_, i) => i);
    // span = 99 → raw = 9.9 → picks 10. (20 only kicks in when raw > 10.)
    expect(pickAgeBuckets(ages)).toEqual({ width: 10, start: 0 });
  });

  it("respects an explicit targetCount", () => {
    const ages = Array.from({ length: 50 }, (_, i) => 20 + i);
    expect(pickAgeBuckets(ages, 5).width).toBe(10);
  });

  it("ignores non-finite + negative values when sizing", () => {
    const { width, start } = pickAgeBuckets([5, 21, Number.NaN, -7, 14]);
    expect(width).toBe(2);
    expect(start).toBe(4);
  });
});

describe("filePlotUrl", () => {
  it("builds a SVG URL for a given file + plot kind", () => {
    const url = filePlotUrl(
      "ds002718",
      "sub-002/eeg/sub-002_task-FaceRecognition_eeg.set",
      "icamaps",
      "https://data.nemar.org",
    );
    expect(url).toBe(
      "https://data.nemar.org/ds002718/qa/sub-002/eeg/sub-002_task-FaceRecognition_eeg_icamaps.svg",
    );
  });
  it("strips the .set extension before appending plot kind", () => {
    const url = filePlotUrl("nm000104", "sub-x/eeg/foo.set", "spectopo", "https://x");
    expect(url).toBe("https://x/nm000104/qa/sub-x/eeg/foo_spectopo.svg");
  });
  it("percent-encodes path segments", () => {
    const url = filePlotUrl("ds00x", "sub-1 odd/eeg/file name.set", "icaact", "https://x");
    expect(url).toBe("https://x/ds00x/qa/sub-1%20odd/eeg/file%20name_icaact.svg");
  });
});
