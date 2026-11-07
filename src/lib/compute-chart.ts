/**
 * Geometry for the `/compute` usage chart (website ADR 0007: hand-rolled SVG, no chart library).
 *
 * Pure and integer-based where it matters: amounts are whole milli-SU and every total goes through
 * `sumMilli`; only the SVG coordinates are fractions, rounded to three decimals, and none of them is
 * ever printed. The chart is a daily bar chart of the NET charge of one pool, each bar stacked by
 * partition, over the window the API answered for (the page never builds a date from a clock).
 *
 * What the geometry refuses to do, and says so instead:
 *  - It never draws below the baseline. A partition-day whose net charge is negative (a refund or a
 *    correction) is left out of the bar, counted in `omitted`, and still listed in the table.
 *  - The y ceiling comes from the largest STACKED day total, never from the largest single segment.
 *  - A quiet day has no row in the API and draws nothing; it is a zero-height bar, which is true.
 *  - Colors are by the partition's place in the offered list, not by data order, so a color keeps its
 *    meaning from one window to the next. A fifth series never exists: partitions past the third share
 *    the "other" series.
 */

import { dayFromEpoch, epochDay, formatDayShort, formatSu, sumMilli } from "./compute-format";

/** The most days a window may span (the API refuses more). */
const MAX_DAYS = 366;
/** Series with their own color; any partition past this many shares the last series, "other". */
export const CHART_SERIES_COLORS = 4;
const NAMED_SERIES = CHART_SERIES_COLORS - 1;

/** The viewBox is `BAND` units wide per day and `PLOT_HEIGHT` units tall; the SVG stretches to fit. */
export const BAND = 10;
export const PLOT_HEIGHT = 100;
/** A bar is inset this far from each side of its band, leaving a gap between neighbors. */
const BAR_INSET = 1;
/** A non-zero segment is never thinner than this many viewBox units (about 2 px on the tall chart). */
export const MIN_VISIBLE_UNITS = 1;

/** One row of `GET /compute/me/usage?group=day,partition`, as the client guard hands it over. */
export interface UsageRow {
  readonly day: string;
  readonly partition: string | null;
  readonly charged_milli: number;
  readonly jobs: number;
}

export interface ChartInput {
  readonly from: string;
  readonly to: string;
  /** Only the rows of ONE pool (the caller decides which pool a row belongs to). */
  readonly rows: readonly UsageRow[];
  /** The partitions offered for this pool, in the backend's order. */
  readonly partitions: readonly string[];
  /** The name of the shared series for partitions past the third. */
  readonly otherLabel: string;
}

export interface ChartSeries {
  /** 0..3, the token `--chart-series-<n+1>`. */
  readonly colorIndex: number;
  readonly name: string;
  /** The partitions this series stands for (one, or the shared "other" series' several). */
  readonly partitions: readonly string[];
  /** The net total over the window, negative rows included, for the table and the legend. */
  readonly netMilli: number;
}

export interface Segment {
  readonly seriesIndex: number;
  readonly milli: number;
  /** viewBox units from the top of the plot. */
  readonly y: number;
  readonly height: number;
}

export interface DayBar {
  readonly day: string;
  readonly label: string;
  readonly x: number;
  readonly width: number;
  /** Bottom to top. */
  readonly segments: readonly Segment[];
  /** The sum of the segments drawn (positive net charges only). */
  readonly drawnMilli: number;
}

export interface Tick {
  readonly milli: number;
  readonly label: string;
  /** Percent from the top of the plot. */
  readonly topPercent: number;
}

export interface XLabel {
  readonly index: number;
  readonly text: string;
  /** Percent from the left of the plot, at the middle of the band. */
  readonly leftPercent: number;
}

export interface TableRow {
  readonly day: string;
  readonly label: string;
  /** Net milli per series, null when the series had no row that day. */
  readonly cells: readonly (number | null)[];
  readonly netMilli: number;
}

export interface UsageChart {
  readonly viewBoxWidth: number;
  readonly viewBoxHeight: number;
  readonly days: readonly DayBar[];
  readonly series: readonly ChartSeries[];
  readonly ticks: readonly Tick[];
  readonly ceilingMilli: number;
  readonly stepMilli: number;
  readonly xLabels: { readonly regular: readonly XLabel[]; readonly sparse: readonly XLabel[] };
  /** The sum of everything drawn. */
  readonly totalMilli: number;
  /** The day with the largest drawn total, or null when nothing is drawn. */
  readonly busiest: { readonly day: string; readonly milli: number } | null;
  readonly daysWithCharges: number;
  /** Partition-days whose net charge is negative: not drawn, counted, and listed in the table. */
  readonly omitted: {
    readonly cells: readonly {
      readonly day: string;
      readonly seriesIndex: number;
      readonly milli: number;
    }[];
    readonly negativeMilli: number;
  };
  /** Only the days that have a row, in order: the numbers behind the bars. */
  readonly table: readonly TableRow[];
  /** True when no row was drawn. */
  readonly empty: boolean;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The step between ticks: 1, 2 or 5 times a power of ten milli-SU, the smallest that gives at most four
 * intervals up to `maxMilli`. Integers in, integer out. An all-zero range gets 500 (a 1 SU ceiling).
 */
export function niceStep(maxMilli: number): number {
  if (!Number.isSafeInteger(maxMilli) || maxMilli < 0) {
    throw new RangeError("the largest total is a non-negative whole number of milli-SU");
  }
  if (maxMilli === 0) return 500;
  const target = Math.ceil(maxMilli / 4);
  for (let power = 1; power <= Number.MAX_SAFE_INTEGER / 10; power *= 10) {
    for (const multiple of [1, 2, 5]) {
      if (multiple * power >= target) return multiple * power;
    }
  }
  throw new RangeError("the largest total is too large to chart");
}

/** The ceiling: the next multiple of the step at or above the maximum (1 SU when there is nothing). */
export function niceCeiling(maxMilli: number): number {
  const step = niceStep(maxMilli);
  return maxMilli === 0 ? 1000 : Math.ceil(maxMilli / step) * step;
}

function windowDays(from: string, to: string): string[] {
  const a = epochDay(from);
  const b = epochDay(to);
  if (a === null || b === null) throw new RangeError("the window is not two days");
  if (b < a) throw new RangeError("the window ends before it starts");
  if (b - a + 1 > MAX_DAYS) throw new RangeError("the window is longer than the API allows");
  const out: string[] = [];
  for (let e = a; e <= b; e++) out.push(dayFromEpoch(e));
  return out;
}

function pickLabels(count: number, wanted: number): number[] {
  if (count <= wanted) return Array.from({ length: count }, (_, i) => i);
  const picks = new Set<number>();
  for (let i = 0; i < wanted; i++) picks.add(Math.round((i * (count - 1)) / (wanted - 1)));
  return [...picks].sort((x, y) => x - y);
}

/** Series for the offered partitions: the first three each their own, the rest share "other". */
function buildSeries(
  partitions: readonly string[],
  otherLabel: string,
): { names: ChartSeries[]; indexOf: (partition: string) => number } {
  const distinct = [...new Set(partitions)];
  const named = distinct.length > CHART_SERIES_COLORS ? NAMED_SERIES : distinct.length;
  const names: ChartSeries[] = [];
  for (let i = 0; i < named; i++) {
    names.push({ colorIndex: i, name: distinct[i], partitions: [distinct[i]], netMilli: 0 });
  }
  const rest = distinct.slice(named);
  if (rest.length > 0) {
    names.push({
      colorIndex: CHART_SERIES_COLORS - 1,
      name: otherLabel,
      partitions: rest,
      netMilli: 0,
    });
  }
  return {
    names,
    indexOf: (partition) => {
      const own = names.findIndex((s) => s.partitions.includes(partition));
      if (own >= 0) return own;
      // A partition that is not offered: the caller routed it here by mistake. Say so.
      throw new RangeError("a row belongs to a partition this chart was not given");
    },
  };
}

export function computeUsageChart(input: ChartInput): UsageChart {
  const dayList = windowDays(input.from, input.to);
  const dayIndex = new Map(dayList.map((d, i) => [d, i] as const));
  const { names, indexOf } = buildSeries(input.partitions, input.otherLabel);

  // Net per (day, series), summed with the exact adder.
  const cells = new Map<string, number[]>();
  const negativeCells: { day: string; seriesIndex: number; milli: number }[] = [];
  for (const row of input.rows) {
    if (row.partition === null) throw new RangeError("a null-partition row has no pool to chart");
    const di = dayIndex.get(row.day);
    if (di === undefined) throw new RangeError("a row is outside the window");
    const si = indexOf(row.partition);
    const key = `${di}:${si}`;
    cells.set(key, [...(cells.get(key) ?? []), row.charged_milli]);
  }
  const net = (di: number, si: number): number | null => {
    const values = cells.get(`${di}:${si}`);
    return values ? sumMilli(values) : null;
  };

  // Day totals of the DRAWN (positive) segments: the ceiling comes from these stacks.
  const drawnTotals = dayList.map((_, di) =>
    sumMilli(names.map((_s, si) => Math.max(0, net(di, si) ?? 0))),
  );
  const maxStack = drawnTotals.reduce((a, b) => Math.max(a, b), 0);
  const step = niceStep(maxStack);
  const ceiling = niceCeiling(maxStack);

  const days: DayBar[] = dayList.map((day, di) => {
    const segments: Segment[] = [];
    // The positive net charges of the day, bottom to top, with their heights before any floor.
    const parts: { seriesIndex: number; milli: number; height: number }[] = [];
    names.forEach((_s, si) => {
      const value = net(di, si);
      if (value === null) return;
      if (value <= 0) {
        if (value < 0) negativeCells.push({ day, seriesIndex: si, milli: value });
        return;
      }
      parts.push({ seriesIndex: si, milli: value, height: (value / ceiling) * PLOT_HEIGHT });
    });
    // A segment is never thinner than the floor, but raising tiny ones must not push the stack past the
    // plot (the SVG draws outside its box): the segments above the floor give up the difference.
    const floored = parts.filter((p) => p.height < MIN_VISIBLE_UNITS);
    const roomy = parts.filter((p) => p.height >= MIN_VISIBLE_UNITS);
    const roomySum = roomy.reduce((sum, p) => sum + p.height, 0);
    const room = PLOT_HEIGHT - floored.length * MIN_VISIBLE_UNITS;
    const factor = roomySum > room && roomySum > 0 ? room / roomySum : 1;
    let offset = 0;
    for (const part of parts) {
      const height = round3(
        part.height < MIN_VISIBLE_UNITS ? MIN_VISIBLE_UNITS : part.height * factor,
      );
      offset = round3(offset + height);
      segments.push({
        seriesIndex: part.seriesIndex,
        milli: part.milli,
        y: round3(PLOT_HEIGHT - offset),
        height,
      });
    }
    return {
      day,
      label: formatDayShort(day),
      x: di * BAND + BAR_INSET,
      width: BAND - 2 * BAR_INSET,
      segments,
      drawnMilli: drawnTotals[di],
    };
  });

  const series = names.map((s, si) => ({
    ...s,
    netMilli: sumMilli(dayList.map((_, di) => net(di, si) ?? 0)),
  }));

  const ticks: Tick[] = [];
  for (let milli = 0; milli <= ceiling; milli += step) {
    ticks.push({
      milli,
      label: formatSu(milli),
      topPercent: round3(100 - (milli / ceiling) * 100),
    });
  }

  const label = (index: number): XLabel => ({
    index,
    text: formatDayShort(dayList[index]),
    leftPercent: round3(((index + 0.5) / dayList.length) * 100),
  });
  const regular = pickLabels(dayList.length, 6).map(label);
  const sparse = pickLabels(dayList.length, 3).map(label);

  let busiest: UsageChart["busiest"] = null;
  drawnTotals.forEach((milli, di) => {
    if (milli > 0 && (busiest === null || milli > busiest.milli)) {
      busiest = { day: dayList[di], milli };
    }
  });

  const table: TableRow[] = [];
  dayList.forEach((day, di) => {
    const row = names.map((_s, si) => net(di, si));
    if (row.every((c) => c === null)) return;
    table.push({
      day,
      label: formatDayShort(day),
      cells: row,
      netMilli: sumMilli(row.map((c) => c ?? 0)),
    });
  });

  return {
    viewBoxWidth: dayList.length * BAND,
    viewBoxHeight: PLOT_HEIGHT,
    days,
    series,
    ticks,
    ceilingMilli: ceiling,
    stepMilli: step,
    xLabels: { regular, sparse },
    totalMilli: sumMilli(drawnTotals),
    busiest,
    daysWithCharges: drawnTotals.filter((m) => m > 0).length,
    omitted: {
      cells: negativeCells,
      negativeMilli: sumMilli(negativeCells.map((c) => c.milli)),
    },
    table,
    empty: drawnTotals.every((m) => m === 0),
  };
}

/**
 * Where the "No charges in this period." line sits in an empty chart: the vertical middle of the
 * widest gap between two gridlines (the upper one on a tie), as a percent from the top of the plot.
 * Centered on the plot it would land on the middle gridline, and the line would strike through the
 * text. The text is 1.5 lines of `--fs-sm` tall at most; the caller checks it fits the gap.
 */
export function emptyLabelTopPercent(ticks: readonly Tick[]): number {
  const tops = ticks.map((t) => t.topPercent).sort((a, b) => a - b);
  let best = { gap: -1, mid: 50 };
  for (let i = 1; i < tops.length; i++) {
    const gap = tops[i] - tops[i - 1];
    if (gap > best.gap) best = { gap, mid: round3((tops[i] + tops[i - 1]) / 2) };
  }
  return best.mid;
}
