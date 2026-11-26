/**
 * `nemar.lines` version 1 (neuroschema 0.6.0 `docs/views/generic-kinds.md`): each series as straight
 * segments between its stored points in row order, on one x axis and one y axis.
 *
 * Every number on screen is a stored cell's text: the axis ticks print stored x texts and the
 * texts of the smallest and largest stored values, and a pointer, or a key, reads one stored row,
 * never a value between rows (`snapRow`).
 */

import { type Download, type LinesModel, snapRow } from "../model";
import { type Element, h } from "../tree";
import { type ViewContext, dataTableToggle, figure, textTable } from "./figure";
import { columnHeader } from "./table";

export const LINES_SIZE = { width: 640, height: 320 } as const;
export const LINES_MARGIN = { left: 64, right: 16, top: 12, bottom: 44 } as const;
/** Stored x texts printed under the axis, at most. */
const X_TICKS = 6;

export interface Plot {
  readonly width: number;
  readonly height: number;
  /** Plot x of a stored x value, and back. */
  readonly px: (x: number) => number;
  readonly xAt: (px: number) => number;
  readonly py: (y: number) => number;
}

export function linesPlot(model: LinesModel): Plot {
  const width = LINES_SIZE.width - LINES_MARGIN.left - LINES_MARGIN.right;
  const height = LINES_SIZE.height - LINES_MARGIN.top - LINES_MARGIN.bottom;
  const xs = model.x.values;
  const x0 = xs[0];
  const x1 = xs[xs.length - 1];
  const xSpan = x1 - x0;
  const { min, max } = model.y;
  const ySpan = max - min;
  return {
    width,
    height,
    px: (x) => (xSpan > 0 ? ((x - x0) / xSpan) * width : width / 2),
    xAt: (px) => (xSpan > 0 ? x0 + (px / width) * xSpan : x0),
    py: (y) => (ySpan > 0 ? height - ((y - min) / ySpan) * height : height / 2),
  };
}

/** The stored rows whose x texts are printed under the axis: evenly spaced, first and last. */
export function xTickRows(rows: number): number[] {
  if (rows <= X_TICKS) return Array.from({ length: rows }, (_, i) => i);
  return Array.from({ length: X_TICKS }, (_, i) => Math.round((i * (rows - 1)) / (X_TICKS - 1)));
}

/** The stored text of the smallest and of the largest value, as the y axis prints them. */
export function yTickTexts(model: LinesModel): { min: string; max: string } {
  let min = "";
  let max = "";
  for (const item of model.series.items) {
    item.values.forEach((v, r) => {
      if (min === "" && v === model.y.min) min = item.text[r];
      if (max === "" && v === model.y.max) max = item.text[r];
    });
  }
  return { min, max };
}

/** The series nearest a plot y at stored row `row` (the hovered series). */
export function nearestSeries(model: LinesModel, plot: Plot, row: number, py: number): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  model.series.items.forEach((item, s) => {
    const d = Math.abs(plot.py(item.values[row]) - py);
    if (d < distance) {
      distance = d;
      best = s;
    }
  });
  return best;
}

const withUnit = (text: string, unit: string | null): string => (unit ? `${text} ${unit}` : text);

/** What the readout prints for stored row `row` and series `series`: stored texts only. */
export function linesReadout(model: LinesModel, row: number, series: number): string {
  const item = model.series.items[series];
  const x = `${model.x.dim} ${withUnit(model.x.text[row], model.x.unit)}`;
  return `${x}: ${item.label} ${withUnit(item.text[row], model.y.unit)}`;
}

/** The pointer at plot x `px` reads this stored row. */
export const rowAtPointer = (model: LinesModel, plot: Plot, px: number): number =>
  snapRow(model.x.values, plot.xAt(px));

export function linesLabel(model: LinesModel, caption: string): string {
  const rows = model.x.text.length;
  const x = `${model.x.dim}${model.x.unit ? ` in ${model.x.unit}` : ""}`;
  const y = model.y.unit ? `values in ${model.y.unit}` : "values";
  return `${caption} Line chart of ${model.series.items.length} series (${model.series.dim}) over ${rows} stored rows of ${x}, from ${model.x.text[0]} to ${model.x.text[rows - 1]}; ${y}.`;
}

export function linesSvg(model: LinesModel): Element {
  const plot = linesPlot(model);
  const ticks = yTickTexts(model);
  const series = model.series.items.map((item, s) =>
    h("polyline", {
      class: "qv-series",
      "data-series": s,
      points: item.values
        .map((v, r) => `${round(plot.px(model.x.values[r]))},${round(plot.py(v))}`)
        .join(" "),
    }),
  );
  const xTicks = xTickRows(model.x.values.length).map((r) =>
    h(
      "text",
      {
        class: "qv-tick",
        x: round(plot.px(model.x.values[r])),
        y: plot.height + 16,
        "text-anchor": "middle",
      },
      model.x.text[r],
    ),
  );
  return h(
    "svg",
    {
      class: "qv-lines",
      viewBox: `0 0 ${LINES_SIZE.width} ${LINES_SIZE.height}`,
      "aria-hidden": "true",
      focusable: "false",
    },
    h(
      "g",
      { transform: `translate(${LINES_MARGIN.left} ${LINES_MARGIN.top})` },
      h("line", { class: "qv-axis", x1: 0, y1: plot.height, x2: plot.width, y2: plot.height }),
      h("line", { class: "qv-axis", x1: 0, y1: 0, x2: 0, y2: plot.height }),
      h(
        "text",
        { class: "qv-tick", x: -6, y: round(plot.py(model.y.min)), "text-anchor": "end" },
        ticks.min,
      ),
      h(
        "text",
        { class: "qv-tick", x: -6, y: round(plot.py(model.y.max)) + 8, "text-anchor": "end" },
        ticks.max,
      ),
      ...xTicks,
      h(
        "text",
        { class: "qv-axis-label", x: plot.width / 2, y: plot.height + 36, "text-anchor": "middle" },
        columnHeader(model.x.dim ?? model.x.column, model.x.unit),
      ),
      model.y.unit
        ? h(
            "text",
            {
              class: "qv-axis-label",
              transform: `translate(${-LINES_MARGIN.left + 14} ${plot.height / 2}) rotate(-90)`,
              "text-anchor": "middle",
            },
            model.y.unit,
          )
        : null,
      h("g", { class: "qv-series-group" }, ...series),
      h("line", { class: "qv-cursor", x1: 0, y1: 0, x2: 0, y2: plot.height, visibility: "hidden" }),
    ),
  );
}

const round = (v: number): number => Math.round(v * 100) / 100;

export function linesTable(model: LinesModel, caption: string): Element {
  const header = [
    columnHeader(model.x.column, model.x.unit),
    ...model.series.items.map((item) => columnHeader(item.label, model.y.unit)),
  ];
  const rows = model.x.text.map((x, r) => [x, ...model.series.items.map((item) => item.text[r])]);
  return textTable(caption, header, rows);
}

export function renderLines(
  model: LinesModel,
  downloads: readonly Download[],
  ctx: ViewContext,
): Element {
  return figure({
    ctx,
    drawing: linesSvg(model),
    label: linesLabel(model, ctx.caption),
    readout: true,
    table: dataTableToggle(linesTable(model, ctx.caption)),
    downloads,
  });
}
