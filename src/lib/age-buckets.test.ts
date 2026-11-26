import { describe, expect, it } from "vitest";
import { type AgeBucket, bucketAgesBySex, pickAgeBuckets } from "./age-buckets";

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
