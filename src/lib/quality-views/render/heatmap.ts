/**
 * `nemar.heatmap` version 1 (neuroschema 0.6.0 `docs/views/generic-kinds.md`): one flat cell per
 * stored value, rows top to bottom and columns left to right, colored by its value between the
 * model's limits, a sequential map for `minmax` and a diverging map centered on zero for `absmax`;
 * equal limits give every cell one color, and nothing is interpolated or smoothed.
 *
 * A heatmap may hold 262,144 cells, too many for SVG elements, so the cells are painted into a
 * canvas one pixel each (`heatmapPixels`, tested without a browser) and scaled without smoothing.
 * A pointer or a key reads one cell: its row label, column label and stored text.
 */

import { type ColorMapName, entryFor, lookupTable } from "../colormap";
import type { Download, HeatmapModel } from "../model";
import { type Element, h } from "../tree";
import { type ViewContext, figure, textTable } from "./figure";
import { readoutWriter, step } from "./interact";
import { columnHeader } from "./table";

/** Labels printed along an axis, at most; the data table holds every one. */
const AXIS_LABELS = 32;

export const heatmapColorMap = (model: HeatmapModel): ColorMapName =>
  model.limits.rule === "absmax" ? "diverging" : "sequential";

/** RGBA pixels, one per cell: row r of the image is data row r. */
export function heatmapPixels(
  model: HeatmapModel,
  table = lookupTable(heatmapColorMap(model)),
): Uint8ClampedArray {
  const rows = model.values.length;
  const columns = model.values[0].length;
  const axis = [model.limits.min, model.limits.max] as const;
  const pixels = new Uint8ClampedArray(rows * columns * 4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const entry = entryFor(model.values[r][c], axis) * 3;
      const p = (r * columns + c) * 4;
      pixels[p] = table[entry];
      pixels[p + 1] = table[entry + 1];
      pixels[p + 2] = table[entry + 2];
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}

export function heatmapReadout(model: HeatmapModel, row: number, column: number): string {
  const text = model.text[row][column];
  return `${model.rows.labels[row]}, ${model.columns.labels[column]}: ${model.unit ? `${text} ${model.unit}` : text}`;
}

export function heatmapLabel(model: HeatmapModel, caption: string): string {
  const unit = model.unit ? ` in ${model.unit}` : "";
  return `${caption} Heatmap of ${model.rows.labels.length} rows (${model.rows.dim}) by ${model.columns.labels.length} columns (${model.columns.dim}), values${unit}, colored ${model.limits.rule === "absmax" ? "on a diverging scale centered on zero" : "from the smallest to the largest value"}.`;
}

/** Which of `count` labels an axis prints. */
export const labelEvery = (count: number): number => Math.max(1, Math.ceil(count / AXIS_LABELS));

export function heatmapDrawing(model: HeatmapModel): Element {
  const rows = model.rows.labels;
  const columns = model.columns.labels;
  const rowStep = labelEvery(rows.length);
  const columnStep = labelEvery(columns.length);
  return h(
    "div",
    { class: "qv-heatmap", style: `--qv-rows:${rows.length};--qv-columns:${columns.length}` },
    h(
      "ol",
      { class: "qv-heatmap-columns", "aria-hidden": "true" },
      ...columns.map((label, c) => h("li", {}, c % columnStep === 0 ? label : "")),
    ),
    h(
      "ol",
      { class: "qv-heatmap-rows", "aria-hidden": "true" },
      ...rows.map((label, r) => h("li", {}, r % rowStep === 0 ? label : "")),
    ),
    h("canvas", { class: "qv-heatmap-cells", width: columns.length, height: rows.length }),
  );
}

/** The stored text of the cell holding the first value that `pick` prefers. */
function cellText(model: HeatmapModel, better: (a: number, b: number) => boolean): string {
  let at: [number, number] = [0, 0];
  model.values.forEach((row, r) => {
    row.forEach((v, c) => {
      if (better(v, model.values[at[0]][at[1]])) at = [r, c];
    });
  });
  return model.text[at[0]][at[1]];
}

/**
 * The legend's ends, every number a stored cell's text: under `minmax` the smallest and the largest
 * cell; under `absmax` the sign words and the cell of the largest magnitude, which the scale is
 * centered on.
 */
export function heatmapLegend(model: HeatmapModel): {
  readonly low: string;
  readonly high: string;
  readonly note: string | null;
} {
  const unit = model.unit ? ` ${model.unit}` : "";
  if (model.limits.rule === "absmax") {
    const largest = cellText(model, (a, b) => Math.abs(a) > Math.abs(b));
    return {
      low: "negative",
      high: "positive",
      note: `centered on 0; largest magnitude ${largest}${unit}`,
    };
  }
  return {
    low: `${cellText(model, (a, b) => a < b)}${unit}`,
    high: `${cellText(model, (a, b) => a > b)}${unit}`,
    note: null,
  };
}

function legend(model: HeatmapModel): Element {
  const { low, high, note } = heatmapLegend(model);
  return h(
    "div",
    { class: "qv-legend" },
    h("span", { class: "qv-legend-low" }, low),
    h("span", { class: `qv-legend-bar qv-legend-${heatmapColorMap(model)}` }),
    h("span", { class: "qv-legend-high" }, high),
    note ? h("span", { class: "qv-legend-note" }, note) : null,
  );
}

export function heatmapTable(model: HeatmapModel, caption: string): Element {
  const header = [
    columnHeader(model.rows.dim ?? "", model.rows.unit),
    ...model.columns.labels.map((label) => columnHeader(label, model.unit)),
  ];
  return textTable(
    caption,
    header,
    model.rows.labels.map((label, r) => [label, ...model.text[r]]),
  );
}

export function renderHeatmap(
  model: HeatmapModel,
  downloads: readonly Download[],
  ctx: ViewContext,
): Element {
  return figure({
    ctx,
    drawing: heatmapDrawing(model),
    label: heatmapLabel(model, ctx.caption),
    readout: true,
    notes: [legend(model)],
    table: () => heatmapTable(model, ctx.caption),
    downloads,
    colorMaps: true,
  });
}

/** The page's side: paint the cells, and read one cell by pointer or arrow keys. */
export function attachHeatmap(root: HTMLElement, model: HeatmapModel): void {
  const canvas = root.querySelector<HTMLCanvasElement>(".qv-heatmap-cells");
  const drawing = root.querySelector<HTMLElement>(".qv-drawing");
  const output = root.querySelector<HTMLOutputElement>(".qv-readout");
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx || !drawing || !output) return;
  const write = readoutWriter(output);
  const rows = model.values.length;
  const columns = model.values[0].length;
  const image = ctx.createImageData(columns, rows);
  image.data.set(heatmapPixels(model));
  ctx.putImageData(image, 0, 0);
  let at: [number, number] = [0, 0];
  canvas.addEventListener("pointermove", (event) => {
    const box = canvas.getBoundingClientRect();
    const r = Math.min(rows - 1, Math.floor(((event.clientY - box.top) / box.height) * rows));
    const c = Math.min(columns - 1, Math.floor(((event.clientX - box.left) / box.width) * columns));
    if (r < 0 || c < 0) return;
    at = [r, c];
    write(heatmapReadout(model, r, c));
  });
  drawing.addEventListener("keydown", (event) => {
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    const next = vertical ? step(event.key, at[0], rows) : step(event.key, at[1], columns);
    if (next === null) return;
    event.preventDefault();
    at = vertical ? [next, at[1]] : [at[0], next];
    write(heatmapReadout(model, at[0], at[1]));
  });
}
