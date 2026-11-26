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
import { type ViewContext, dataTableToggle, figure, textTable } from "./figure";
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
    table: dataTableToggle(heatmapTable(model, ctx.caption)),
    downloads,
    colorMaps: true,
  });
}
