/**
 * Formatters for the /compute page. Vectors for `suFixed` and `formatDuration` are copied from
 * nemar-cli's `suFixed` and `durationText` (src/commands/compute-read.ts), so the page and
 * `nemar compute balance` print the same digits.
 */
import { describe, expect, it } from "vitest";
import {
  dayFromEpoch,
  dbTimeToIso,
  epochDay,
  formatDayShort,
  formatDuration,
  suFixed,
  formatSu,
  formatUtcDate,
  formatUtcMinute,
  formatUtcSecond,
  parseDbTime,
  sumMilli,
} from "./compute-format";

describe("suFixed", () => {
  it.each([
    [0, "0.000"],
    [1, "0.001"],
    [999, "0.999"],
    [1000, "1.000"],
    [12500, "12.500"],
    [123456789012, "123456789.012"],
    [-500, "-0.500"],
    [-1, "-0.001"],
    [-1000, "-1.000"],
    [-12345, "-12.345"],
    [Number.MAX_SAFE_INTEGER, "9007199254740.991"],
  ])("%i milli is %s", (milli, text) => {
    expect(suFixed(milli)).toBe(text);
  });

  it("prints a negative balance as negative, never as zero", () => {
    expect(suFixed(-2500)).toBe("-2.500");
    expect(suFixed(-2500)).not.toBe("0.000");
  });

  it.each([Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])(
    "throws for %s instead of printing a wrong figure",
    (bad) => {
      expect(() => suFixed(bad)).toThrow(RangeError);
    },
  );

  it("has no thousands separator, so the digits match the CLI", () => {
    expect(suFixed(1234567890)).toBe("1234567.890");
  });
});

describe("formatSu", () => {
  it.each([
    [0, "0"],
    [2500, "2.5"],
    [10000, "10"],
    [250, "0.25"],
    [1, "0.001"],
    [-500, "-0.5"],
    [500000, "500"],
  ])("%i milli is %s", (milli, text) => {
    expect(formatSu(milli)).toBe(text);
  });
  it("throws for a float", () => {
    expect(() => formatSu(0.5)).toThrow(RangeError);
  });
});

describe("sumMilli", () => {
  it("adds integers exactly", () => {
    expect(sumMilli([])).toBe(0);
    expect(sumMilli([4000, 12500, -300])).toBe(16200);
  });
  it("is exact where floats are not", () => {
    // 0.1 + 0.2 in SU would be 0.30000000000000004; in milli-SU it is 300.
    expect(sumMilli([100, 200])).toBe(300);
  });
  it("throws for a non-integer or a sum that leaves the safe range", () => {
    expect(() => sumMilli([1, 1.5])).toThrow(RangeError);
    expect(() => sumMilli([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [37, "37s"],
    [59, "59s"],
    [60, "1m 0s"],
    [252, "4m 12s"],
    [3599, "59m 59s"],
    [3600, "1h 0m"],
    [3900, "1h 5m"],
    [90000, "25h 0m"],
  ])("%i seconds is %s", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });
  it("throws for a negative, a float or NaN", () => {
    expect(() => formatDuration(-1)).toThrow(RangeError);
    expect(() => formatDuration(1.5)).toThrow(RangeError);
    expect(() => formatDuration(Number.NaN)).toThrow(RangeError);
  });
});

describe("database times are UTC whatever the machine's zone", () => {
  it("parses field by field, not as local time", () => {
    // Local-time parsing would differ from this on any machine whose offset is not zero.
    expect(parseDbTime("2026-11-05 12:00:00")).toBe(Date.UTC(2026, 10, 5, 12));
    expect(dbTimeToIso("2026-11-05 12:00:00")).toBe("2026-11-05T12:00:00Z");
  });
  it("formats to the minute and to the second", () => {
    expect(formatUtcMinute("2026-11-05 12:07:59")).toBe("2026-11-05 12:07 UTC");
    expect(formatUtcSecond("2026-11-05 12:07:59")).toBe("2026-11-05 12:07:59 UTC");
  });
  it("formats the UTC date, not the viewer's", () => {
    expect(formatUtcDate("2026-10-20 23:59:59")).toBe("Oct 20, 2026");
    expect(formatUtcDate("2026-01-01 00:00:00")).toBe("Jan 1, 2026");
    expect(formatUtcDate("soon")).toBe("soon");
  });
  it("rejects a shape or an impossible instant, and returns the text unchanged", () => {
    for (const bad of [
      "",
      "2026-11-05T12:00:00Z",
      "2026-13-05 12:00:00",
      "2026-02-30 12:00:00",
      "x",
    ]) {
      expect(parseDbTime(bad), bad).toBeNull();
      expect(dbTimeToIso(bad), bad).toBeNull();
      expect(formatUtcMinute(bad), bad).toBe(bad);
    }
  });
});

describe("days", () => {
  it("round-trips an epoch day", () => {
    const e = epochDay("2026-11-03");
    expect(e).not.toBeNull();
    expect(dayFromEpoch(e as number)).toBe("2026-11-03");
    expect((epochDay("2026-11-04") as number) - (e as number)).toBe(1);
  });
  it("crosses a month and a year boundary", () => {
    expect(dayFromEpoch((epochDay("2026-10-31") as number) + 1)).toBe("2026-11-01");
    expect(dayFromEpoch((epochDay("2026-12-31") as number) + 1)).toBe("2027-01-01");
    expect(dayFromEpoch((epochDay("2028-02-28") as number) + 1)).toBe("2028-02-29");
  });
  it("rejects what is not a day", () => {
    expect(epochDay("2026-02-30")).toBeNull();
    expect(epochDay("2026-1-1")).toBeNull();
    expect(epochDay("")).toBeNull();
  });
  it("labels a day without a locale", () => {
    expect(formatDayShort("2026-11-03")).toBe("Nov 3");
    expect(formatDayShort("2026-01-15")).toBe("Jan 15");
    expect(formatDayShort("garbage")).toBe("garbage");
  });
});
