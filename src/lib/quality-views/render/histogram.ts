/**
 * `nemar.histogram` version 1 (neuroschema 0.6.0 `docs/views/generic-kinds.md`): one bar per bin in
 * order, drawn from the counts the model holds; nothing is binned here. A pure function from the
 * model to an SVG tree, so the server draws it into the page (the dataset summary, phase W5) and the
 * page draws the same tree.
 *
 * - With `heights` `count`, a bar's height is its count; with `density` (bins of unequal width) its
 *   height is its density, so its area is its count, and the value axis says so.
 * - Bins by edges sit on a numeric axis from the first edge to the last; bins by category are bars
 *   of equal width. An underflow or overflow bar is drawn at its end only when its count is not
 *   zero, and under `density` as a count marker apart from the density axis.
 * - The missing count is shown beside the bars, never as a bar.
 * - A value can be marked (one recording on its dataset's distribution): its bin is found by the
 *   edges' rule (`locateBin`), and NaN marks nothing.
 */

import { type Download, type HistogramModel, locateBin } from "../model";
import { numberText } from "../read";
import { type Child, type Element, h } from "../tree";
import { type ViewContext, figure, textTable } from "./figure";
import { readoutWriter, step } from "./interact";
import { fraction } from "./scale";

export const HISTOGRAM_SIZE = { width: 480, height: 240 } as const;
const MARGIN = { left: 56, right: 12, top: 12, bottom: 44 } as const;
/** The share of the plot's width an underflow or overflow bar takes. */
const END_SHARE = 1 / 14;

export interface HistogramMark {
  /** The marked value, which places it in a bin. */
  readonly value: number;
  /** Its stored text, the only form of it printed. */
  readonly text: string;
  /** What the mark is, e.g. "this recording". */
  readonly label: string;
}

/** One drawn bar, in plot coordinates; `index` is the item's, -1 the underflow and `items.length`
 *  the overflow. */
export interface HistogramBar {
  readonly index: number;
  readonly label: string;
  readonly count: number;
  readonly x: number;
  readonly width: number;
  readonly height: number;
  /** A count marker apart from the density axis (an end bar under `density`). */
  readonly marker: boolean;
}

/** The value axis's name. */
export function valueAxisLabel(model: HistogramModel): string {
  if (model.heights === "count") return "count";
  return model.unit ? `count per unit width (per ${model.unit})` : "count per unit width";
}

/** The bars, laid out on a plot of `width` by `height`. */
export function histogramBars(
  model: HistogramModel,
  width: number,
  height: number,
): HistogramBar[] {
  const density = model.heights === "density";
  const top = density ? (model.max_density ?? 0) : model.max_count;
  const scale = (v: number): number => (top > 0 ? (v / top) * height : 0);
  const bars: HistogramBar[] = [];
  if (model.bins === "categories") {
    const step = width / model.items.length;
    model.items.forEach((item, i) => {
      bars.push({
        index: i,
        label: item.label,
        count: item.count,
        x: i * step + step * 0.1,
        width: step * 0.8,
        height: scale(item.count),
        marker: false,
      });
    });
    return bars;
  }
  const under = model.underflow && model.underflow.count > 0 ? model.underflow : null;
  const over = model.overflow && model.overflow.count > 0 ? model.overflow : null;
  const end = width * END_SHARE;
  const left = under ? end : 0;
  const span = width - left - (over ? end : 0);
  const first = model.items[0].lower!;
  const last = model.items[model.items.length - 1].upper!;
  const at = (v: number): number => left + fraction(v, first, last) * span;
  if (under) {
    bars.push({
      index: -1,
      label: under.label,
      count: under.count,
      x: 0,
      width: end * 0.8,
      height: density ? 0 : scale(under.count),
      marker: density,
    });
  }
  model.items.forEach((item, i) => {
    const x0 = at(item.lower!);
    const x1 = at(item.upper!);
    const value = density ? item.density! : item.count;
    bars.push({
      index: i,
      label: item.label,
      count: item.count,
      x: x0,
      width: Math.max(0, x1 - x0),
      height: scale(value),
      marker: false,
    });
  });
  if (over) {
    bars.push({
      index: model.items.length,
      label: over.label,
      count: over.count,
      x: width - end * 0.8,
      width: end * 0.8,
      height: density ? 0 : scale(over.count),
      marker: density,
    });
  }
  return bars;
}

/** Where a mark falls, in words: its stored text and its bin's label. */
export function markSentence(model: HistogramModel, mark: HistogramMark): string {
  const bin = markedIndex(model, mark.value);
  const where =
    bin === null
      ? "in no bin"
      : bin < 0
        ? `below the bins (${model.underflow!.label})`
        : bin >= model.items.length
          ? `above the bins (${model.overflow!.label})`
          : `in the bin ${model.items[bin].label}`;
  return `${mark.label}: ${mark.text}${model.unit ? ` ${model.unit}` : ""}, ${where}.`;
}

/** The text alternative: the axes and units, the mark, and the counts through the data table. */
export function histogramLabel(
  model: HistogramModel,
  caption: string,
  mark?: HistogramMark,
): string {
  const bins =
    model.bins === "categories"
      ? `${model.items.length} categories`
      : `${model.items.length} bins from ${numberText(model.items[0].lower!)} to ${numberText(model.items[model.items.length - 1].upper!)}${model.unit ? ` ${model.unit}` : ""}`;
  const missing = model.missing ? `, and ${model.missing.count} missing` : "";
  const marked = mark ? ` ${markSentence(model, mark)}` : "";
  return `${caption} Histogram of ${bins}; ${valueAxisLabel(model)} on the value axis; ${model.total} values in all${missing}.${marked}`;
}

/** The data table's rows: each item, then the underflow and the overflow, then the missing count. */
export function histogramRows(model: HistogramModel): string[][] {
  const density = model.heights === "density";
  const rows = model.items.map((item) =>
    density
      ? [item.label, String(item.count), numberText(item.density!)]
      : [item.label, String(item.count)],
  );
  for (const end of [model.underflow, model.overflow]) {
    if (end)
      rows.push(density ? [end.label, String(end.count), ""] : [end.label, String(end.count)]);
  }
  if (model.missing)
    rows.push(
      density
        ? ["missing", String(model.missing.count), ""]
        : ["missing", String(model.missing.count)],
    );
  return rows;
}

/** The bar `value` falls in (by the edges' rule), as an index into `histogramBars`' `index`. */
export function markedIndex(model: HistogramModel, value: number): number | null {
  if (model.bins !== "edges") return null;
  const edges = [model.items[0].lower!, ...model.items.map((item) => item.upper!)];
  return locateBin(edges, value);
}

/** The histogram as an SVG tree. */
export function histogramSvg(model: HistogramModel, mark?: HistogramMark): Element {
  const { width, height } = HISTOGRAM_SIZE;
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const bars = histogramBars(model, plotW, plotH);
  const marked = mark ? markedIndex(model, mark.value) : null;
  const density = model.heights === "density";
  const top = density ? numberText(model.max_density ?? 0) : String(model.max_count);
  const children: Child[] = [
    h("line", { class: "qv-axis", x1: 0, y1: plotH, x2: plotW, y2: plotH }),
    h("line", { class: "qv-axis", x1: 0, y1: 0, x2: 0, y2: plotH }),
    h("text", { class: "qv-tick", x: -6, y: plotH, "text-anchor": "end" }, "0"),
    h("text", { class: "qv-tick", x: -6, y: 8, "text-anchor": "end" }, top),
    h(
      "text",
      {
        class: "qv-axis-label",
        transform: `translate(${-MARGIN.left + 12} ${plotH / 2}) rotate(-90)`,
        "text-anchor": "middle",
      },
      valueAxisLabel(model),
    ),
  ];
  for (const bar of bars) {
    const isMarked = marked !== null && bar.index === marked;
    const cls = `qv-bar${bar.index < 0 || bar.index >= model.items.length ? " qv-bar-end" : ""}${isMarked ? " qv-marked" : ""}`;
    const title = h("title", {}, `${bar.label}: ${bar.count}`);
    if (bar.marker) {
      children.push(
        h(
          "g",
          { class: cls, "data-index": bar.index },
          title,
          h(
            "text",
            { class: "qv-tick", x: bar.x + bar.width / 2, y: plotH - 4, "text-anchor": "middle" },
            String(bar.count),
          ),
        ),
      );
      continue;
    }
    children.push(
      h(
        "rect",
        {
          class: cls,
          "data-index": bar.index,
          x: bar.x,
          y: plotH - bar.height,
          width: bar.width,
          height: bar.height,
        },
        title,
      ),
    );
  }
  if (model.bins === "edges") {
    const first = bars.find((bar) => bar.index === 0)!;
    const last = bars.find((bar) => bar.index === model.items.length - 1)!;
    children.push(
      h(
        "text",
        { class: "qv-tick", x: first.x, y: plotH + 16, "text-anchor": "middle" },
        numberText(model.items[0].lower!),
      ),
      h(
        "text",
        { class: "qv-tick", x: last.x + last.width, y: plotH + 16, "text-anchor": "middle" },
        numberText(model.items[model.items.length - 1].upper!),
      ),
    );
    if (model.unit) {
      children.push(
        h(
          "text",
          { class: "qv-axis-label", x: plotW / 2, y: plotH + 34, "text-anchor": "middle" },
          model.unit,
        ),
      );
    }
  } else if (model.items.length <= 12) {
    for (const bar of bars) {
      children.push(
        h(
          "text",
          { class: "qv-tick", x: bar.x + bar.width / 2, y: plotH + 16, "text-anchor": "middle" },
          bar.label,
        ),
      );
    }
  }
  if (mark && marked !== null) {
    children.push(
      h(
        "text",
        { class: "qv-mark", x: plotW, y: 8, "text-anchor": "end" },
        `${mark.label}: ${mark.text}`,
      ),
    );
  }
  return h(
    "svg",
    {
      class: "qv-histogram",
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      "aria-hidden": "true",
      focusable: "false",
    },
    h("g", { transform: `translate(${MARGIN.left} ${MARGIN.top})` }, ...children),
  );
}

/** The data table: each bin with its count (and density), the ends and the missing count. */
export function histogramTable(model: HistogramModel, caption: string): Element {
  const header =
    model.heights === "density" ? ["bin", "count", valueAxisLabel(model)] : ["bin", "count"];
  return textTable(caption, header, histogramRows(model));
}

export function renderHistogram(
  model: HistogramModel,
  downloads: readonly Download[],
  ctx: ViewContext,
  mark?: HistogramMark,
): Element {
  return figure({
    ctx,
    drawing: histogramSvg(model, mark),
    label: histogramLabel(model, ctx.caption, mark),
    readout: true,
    roleDescription: "histogram",
    keys: "Keys: left and right arrows move between bars.",
    notes: model.missing
      ? [h("p", { class: "qv-note" }, `${model.missing.label}: ${model.missing.count}, in no bin`)]
      : [],
    table: () => histogramTable(model, ctx.caption),
    downloads,
  });
}

/** What a pointer or a key on a bar reads: its label (with the unit, for bins by edges), its
 *  count, and its density when the heights are densities. */
export function histogramReadout(model: HistogramModel, bar: HistogramBar): string {
  const unit = model.bins === "edges" && model.unit ? ` ${model.unit}` : "";
  const item = bar.index >= 0 && bar.index < model.items.length ? model.items[bar.index] : null;
  const density =
    item && model.heights === "density" ? `, ${numberText(item.density!)} per unit width` : "";
  return `${bar.label}${unit}: ${bar.count}${density}`;
}

/** The page's side: a pointer or the arrow keys select a bar and the readout prints it. */
export function attachHistogram(root: HTMLElement, model: HistogramModel): void {
  const drawing = root.querySelector<HTMLElement>(".qv-drawing");
  const output = root.querySelector<HTMLOutputElement>(".qv-readout");
  if (!drawing || !output) return;
  const write = readoutWriter(output);
  const bars = histogramBars(model, 1, 1);
  let at = 0;
  const show = (): void => {
    write(histogramReadout(model, bars[at]));
    for (const el of root.querySelectorAll(".qv-bar")) {
      el.classList.toggle("qv-selected", el.getAttribute("data-index") === String(bars[at].index));
    }
  };
  for (const el of root.querySelectorAll<SVGElement>(".qv-bar")) {
    el.addEventListener("pointerenter", () => {
      const k = bars.findIndex((bar) => String(bar.index) === el.getAttribute("data-index"));
      if (k >= 0) {
        at = k;
        show();
      }
    });
  }
  drawing.addEventListener("keydown", (event) => {
    const next = step(event.key, at, bars.length);
    if (next === null) return;
    event.preventDefault();
    at = next;
    show();
  });
}
