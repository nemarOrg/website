/**
 * Chart geometry. The known-usage cases run on a fixture captured from the real route:
 *
 *   NEMAR_CLI_DIR=<nemar-cli checkout of the Epic D branch> \
 *     bun scripts/capture-compute-read-fixtures.mjs
 *
 * (test/fixtures/compute/usage-day-partition.json, usage-empty.json, usage-outlier.json). The edge
 * cases that no single route call can produce (a 366 day window, a fourth partition) use inline rows
 * of the same shape.
 */
import { describe, expect, it } from "vitest";
import day from "../../test/fixtures/compute/usage-day-partition.json";
import empty from "../../test/fixtures/compute/usage-empty.json";
import outlier from "../../test/fixtures/compute/usage-outlier.json";
import {
  BAND,
  MIN_VISIBLE_UNITS,
  PLOT_HEIGHT,
  type UsageRow,
  computeUsageChart,
  niceCeiling,
  niceStep,
} from "./compute-chart";

const CPU = ["shared", "compute", "debug"];
const GPU = ["gpu-shared", "gpu", "gpu-debug"];

function rowsOf(body: { rows: unknown[] }, partitions: string[]): UsageRow[] {
  return (body.rows as UsageRow[]).filter(
    (r) => r.partition !== null && partitions.includes(r.partition),
  );
}

describe("niceStep and niceCeiling", () => {
  it.each([
    [0, 500, 1000],
    [1, 1, 1],
    [4, 1, 4],
    [5, 2, 6],
    [13_500, 5_000, 15_000],
    [16_200, 5_000, 20_000],
    [250_000, 100_000, 300_000],
    [1_000, 500, 1_000],
    [1_001, 500, 1_500],
    [8_000, 2_000, 8_000],
  ])("max %i has step %i and ceiling %i", (max, step, ceiling) => {
    expect(niceStep(max)).toBe(step);
    expect(niceCeiling(max)).toBe(ceiling);
  });

  it("always gives at most four intervals", () => {
    for (const max of [1, 3, 7, 99, 101, 999, 1_234, 98_765, 1_000_001, 12_345_678_901]) {
      expect(niceCeiling(max) / niceStep(max), String(max)).toBeLessThanOrEqual(4);
      expect(niceCeiling(max)).toBeGreaterThanOrEqual(max);
    }
  });

  it("takes and returns integers", () => {
    for (const max of [0, 1, 17, 12_500, 250_000]) {
      expect(Number.isInteger(niceStep(max))).toBe(true);
      expect(Number.isInteger(niceCeiling(max))).toBe(true);
    }
    expect(() => niceStep(-1)).toThrow(RangeError);
    expect(() => niceStep(1.5)).toThrow(RangeError);
  });
});

describe("the cpu chart of the captured fixture", () => {
  const chart = computeUsageChart({
    from: day.body.from,
    to: day.body.to,
    rows: rowsOf(day.body, CPU),
    partitions: CPU,
    otherLabel: "Other partitions",
  });

  it("has one band per day of the window, 30 here", () => {
    expect(chart.days).toHaveLength(30);
    expect(chart.viewBoxWidth).toBe(30 * BAND);
    expect(chart.days[0].day).toBe("2026-10-09");
    expect(chart.days[29].day).toBe("2026-11-07");
    expect(chart.days[3].x).toBe(3 * BAND + 1);
    expect(chart.days[3].width).toBe(BAND - 2);
  });

  it("takes its ceiling from the largest STACKED day, not the largest segment", () => {
    // Oct 12 stacks compute 12.500 + shared 4.000 = 16.500; the largest single segment is 12.500.
    // Nov 3 stacks 5.000 (shared) alone. A ceiling from the largest segment would be 15.000.
    const stacked = 16_500;
    const largestSegment = 12_500;
    expect(Math.max(...chart.days.map((d) => d.drawnMilli))).toBe(stacked);
    expect(niceCeiling(largestSegment)).toBe(15_000);
    expect(chart.ceilingMilli).toBe(niceCeiling(stacked));
    expect(chart.ceilingMilli).toBe(20_000);
    expect(chart.stepMilli).toBe(5_000);
    expect(chart.ticks.map((t) => t.label)).toEqual(["0", "5", "10", "15", "20"]);
  });

  it("stacks the segments of a day from the bottom in the order of the offered list", () => {
    const oct12 = chart.days.find((d) => d.day === "2026-10-12");
    expect(oct12?.segments.map((s) => [s.seriesIndex, s.milli])).toEqual([
      [0, 4_000], // shared
      [1, 12_500], // compute
    ]);
    const [shared, compute] = oct12?.segments ?? [];
    expect(shared.height).toBe(20); // 4000 / 20000 * 100
    expect(shared.y).toBe(80);
    expect(compute.height).toBe(62.5);
    expect(compute.y).toBe(17.5); // sits on top of shared: 100 - 20 - 62.5
  });

  it("draws a quiet day as nothing, and a day with no row at zero", () => {
    const quiet = chart.days.find((d) => d.day === "2026-10-10");
    expect(quiet?.segments).toEqual([]);
    expect(quiet?.drawnMilli).toBe(0);
  });

  it("never draws below the baseline: a net-negative partition-day is omitted, counted and tabled", () => {
    const refund = chart.days.find((d) => d.day === "2026-10-22");
    expect(refund?.segments).toEqual([]);
    expect(chart.omitted.cells).toEqual([{ day: "2026-10-22", seriesIndex: 2, milli: -300 }]);
    expect(chart.omitted.negativeMilli).toBe(-300);
    const tabled = chart.table.find((r) => r.day === "2026-10-22");
    expect(tabled?.cells).toEqual([null, null, -300]);
    for (const bar of chart.days) {
      for (const seg of bar.segments) {
        expect(seg.height).toBeGreaterThan(0);
        expect(seg.y + seg.height).toBeLessThanOrEqual(PLOT_HEIGHT + 0.001);
      }
    }
  });

  it("totals what is drawn exactly and names the busiest day", () => {
    // shared 4000+2500+6000+5000, compute 12500+9000, debug 500
    expect(chart.totalMilli).toBe(4_000 + 2_500 + 6_000 + 5_000 + 12_500 + 9_000 + 500);
    expect(chart.busiest).toEqual({ day: "2026-10-12", milli: 16_500 });
    expect(chart.daysWithCharges).toBe(5); // Oct 22 nets negative
    expect(chart.empty).toBe(false);
  });

  it("lists only the days that have a row in the table, in order", () => {
    expect(chart.table.map((r) => r.day)).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-20",
      "2026-10-22",
      "2026-10-27",
      "2026-11-03",
    ]);
    expect(chart.table[0].netMilli).toBe(16_500);
    expect(chart.series.map((s) => s.name)).toEqual(CPU);
  });

  it("carries a series total that includes the negative net row", () => {
    const debug = chart.series.find((s) => s.name === "debug");
    expect(debug?.netMilli).toBe(500 - 300);
  });

  it("offers about six x labels and three on a phone, first and last included", () => {
    expect(chart.xLabels.regular.length).toBeGreaterThanOrEqual(5);
    expect(chart.xLabels.regular.length).toBeLessThanOrEqual(6);
    expect(chart.xLabels.sparse.map((l) => l.index)).toEqual([0, 15, 29]);
    expect(chart.xLabels.regular[0].text).toBe("Oct 9");
    expect(chart.xLabels.sparse.at(-1)?.text).toBe("Nov 7");
    expect(chart.xLabels.sparse[0].leftPercent).toBeCloseTo((0.5 / 30) * 100, 2);
  });
});

describe("the gpu chart of the same fixture", () => {
  const chart = computeUsageChart({
    from: day.body.from,
    to: day.body.to,
    rows: rowsOf(day.body, GPU),
    partitions: GPU,
    otherLabel: "Other partitions",
  });
  it("is a separate currency with its own ceiling", () => {
    expect(chart.totalMilli).toBe(5_000 + 8_000 + 1_500);
    expect(chart.ceilingMilli).toBe(8_000); // the largest day stacks 8.000
  });
});

describe("a window with nothing in it", () => {
  const chart = computeUsageChart({
    from: empty.body.from,
    to: empty.body.to,
    rows: [],
    partitions: CPU,
    otherLabel: "Other partitions",
  });
  it("keeps an axis of 1 SU and draws nothing", () => {
    expect(empty.body.rows).toEqual([]);
    expect(chart.empty).toBe(true);
    expect(chart.totalMilli).toBe(0);
    expect(chart.busiest).toBeNull();
    expect(chart.ceilingMilli).toBe(1_000);
    expect(chart.ticks.map((t) => t.label)).toEqual(["0", "0.5", "1"]);
    expect(chart.days.every((d) => d.segments.length === 0)).toBe(true);
    expect(chart.table).toEqual([]);
  });
});

describe("one large outlier", () => {
  const chart = computeUsageChart({
    from: outlier.body.from,
    to: outlier.body.to,
    rows: rowsOf(outlier.body, CPU),
    partitions: CPU,
    otherLabel: "Other partitions",
  });
  it("scales to the outlier and still shows the small days", () => {
    expect(chart.ceilingMilli).toBe(300_000);
    const big = chart.days.find((d) => d.day === "2026-10-20");
    expect(big?.segments[0].height).toBeCloseTo((250_000 / 300_000) * 100, 2);
    const small = chart.days.find((d) => d.day === "2026-10-15");
    // 400 milli-SU is far under one unit of height: it is still visible, at the minimum.
    expect(small?.segments[0].height).toBe(MIN_VISIBLE_UNITS);
  });
});

describe("a stack never leaves the plot", () => {
  it("when tiny segments raised to the minimum sit on a bar that fills the ceiling", () => {
    // 399.998 + 0.001 + 0.001 = 400.000, which is the ceiling; the two 0.001 segments are raised to
    // one unit each, so the large one gives up 2 units instead of the stack reaching 102.
    const chart = computeUsageChart({
      from: "2026-11-01",
      to: "2026-11-01",
      rows: [
        { day: "2026-11-01", partition: "shared", charged_milli: 399_998, jobs: 1 },
        { day: "2026-11-01", partition: "compute", charged_milli: 1, jobs: 1 },
        { day: "2026-11-01", partition: "debug", charged_milli: 1, jobs: 1 },
      ],
      partitions: CPU,
      otherLabel: "Other",
    });
    expect(chart.ceilingMilli).toBe(400_000);
    const segs = chart.days[0].segments;
    expect(segs).toHaveLength(3);
    expect(segs[1].height).toBe(MIN_VISIBLE_UNITS);
    expect(segs[2].height).toBe(MIN_VISIBLE_UNITS);
    const top = segs[segs.length - 1];
    expect(top.y).toBeGreaterThanOrEqual(0);
    expect(segs.reduce((sum, s) => sum + s.height, 0)).toBeLessThanOrEqual(PLOT_HEIGHT + 0.001);
    expect(segs[0].height).toBeCloseTo(PLOT_HEIGHT - 2 * MIN_VISIBLE_UNITS, 2);
  });

  it("for every day of every fixture", () => {
    for (const body of [day.body, outlier.body]) {
      const chart = computeUsageChart({
        from: body.from,
        to: body.to,
        rows: rowsOf(body, CPU),
        partitions: CPU,
        otherLabel: "Other",
      });
      for (const bar of chart.days) {
        const total = bar.segments.reduce((sum, s) => sum + s.height, 0);
        expect(total).toBeLessThanOrEqual(PLOT_HEIGHT + 0.001);
        for (const seg of bar.segments) expect(seg.y).toBeGreaterThanOrEqual(-0.001);
      }
    }
  });
});

describe("a single day", () => {
  it("is one band with its own label", () => {
    const chart = computeUsageChart({
      from: "2026-11-03",
      to: "2026-11-03",
      rows: [{ day: "2026-11-03", partition: "shared", charged_milli: 2_500, jobs: 1 }],
      partitions: CPU,
      otherLabel: "Other",
    });
    expect(chart.days).toHaveLength(1);
    expect(chart.viewBoxWidth).toBe(BAND);
    expect(chart.xLabels.regular.map((l) => l.text)).toEqual(["Nov 3"]);
    expect(chart.xLabels.sparse.map((l) => l.text)).toEqual(["Nov 3"]);
    expect(chart.ceilingMilli).toBe(3_000);
  });
});

describe("window edges", () => {
  it("spans a month boundary and a year boundary", () => {
    const chart = computeUsageChart({
      from: "2026-12-30",
      to: "2027-01-02",
      rows: [],
      partitions: CPU,
      otherLabel: "Other",
    });
    expect(chart.days.map((d) => d.day)).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  it("accepts 366 days and refuses 367", () => {
    const ok = computeUsageChart({
      from: "2026-01-01",
      to: "2027-01-01",
      rows: [],
      partitions: CPU,
      otherLabel: "Other",
    });
    expect(ok.days).toHaveLength(366);
    expect(ok.xLabels.regular.length).toBeLessThanOrEqual(6);
    expect(() =>
      computeUsageChart({
        from: "2026-01-01",
        to: "2027-01-02",
        rows: [],
        partitions: CPU,
        otherLabel: "Other",
      }),
    ).toThrow(RangeError);
  });

  it("refuses a window that is not two days or ends before it starts", () => {
    for (const [from, to] of [
      ["2026-11-05", "2026-11-04"],
      ["x", "2026-11-04"],
      ["2026-11-05", "2026-02-30"],
    ]) {
      expect(() =>
        computeUsageChart({ from, to, rows: [], partitions: CPU, otherLabel: "Other" }),
      ).toThrow(RangeError);
    }
  });
});

describe("rows the geometry cannot place are an error, never a silent drop", () => {
  const base = { from: "2026-11-01", to: "2026-11-03", partitions: CPU, otherLabel: "Other" };
  it("a row outside the window", () => {
    expect(() =>
      computeUsageChart({
        ...base,
        rows: [{ day: "2026-12-01", partition: "shared", charged_milli: 1, jobs: 1 }],
      }),
    ).toThrow(RangeError);
  });
  it("a null partition or one this chart was not given", () => {
    expect(() =>
      computeUsageChart({
        ...base,
        rows: [{ day: "2026-11-01", partition: null, charged_milli: 1, jobs: 0 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeUsageChart({
        ...base,
        rows: [{ day: "2026-11-01", partition: "gpu", charged_milli: 1, jobs: 1 }],
      }),
    ).toThrow(RangeError);
  });
});

describe("colors", () => {
  const rows = (names: string[]): UsageRow[] =>
    names.map((partition, i) => ({
      day: "2026-11-02",
      partition,
      charged_milli: 1_000 * (i + 1),
      jobs: 1,
    }));

  it("are by position in the offered list, so they survive a window where a partition is absent", () => {
    const wide = computeUsageChart({
      from: "2026-11-01",
      to: "2026-11-03",
      rows: rows(["shared", "compute", "debug"]),
      partitions: CPU,
      otherLabel: "Other",
    });
    const narrow = computeUsageChart({
      from: "2026-11-04",
      to: "2026-11-06",
      rows: [{ day: "2026-11-05", partition: "debug", charged_milli: 700, jobs: 1 }],
      partitions: CPU,
      otherLabel: "Other",
    });
    const colorOf = (c: ReturnType<typeof computeUsageChart>, name: string) =>
      c.series.find((s) => s.name === name)?.colorIndex;
    expect(colorOf(wide, "debug")).toBe(2);
    expect(colorOf(narrow, "debug")).toBe(2);
    expect(narrow.days.find((d) => d.day === "2026-11-05")?.segments[0].seriesIndex).toBe(2);
  });

  it("never need a fifth: partitions past the third share one 'other' series", () => {
    const names = ["a", "b", "c", "d", "e"];
    const chart = computeUsageChart({
      from: "2026-11-01",
      to: "2026-11-03",
      rows: rows(names),
      partitions: names,
      otherLabel: "Other partitions",
    });
    expect(chart.series.map((s) => s.name)).toEqual(["a", "b", "c", "Other partitions"]);
    expect(chart.series.map((s) => s.colorIndex)).toEqual([0, 1, 2, 3]);
    expect(chart.series[3].partitions).toEqual(["d", "e"]);
    // d (4000) and e (5000) stack as one series of 9000.
    expect(chart.days[1].segments.at(-1)?.milli).toBe(9_000);
  });
});
