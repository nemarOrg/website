/**
 * A heatmap in the PNG export (website phase W8): the page's own canvas of its cells, one pixel
 * each, scaled without smoothing, with its row and column labels and its legend's stored texts
 * (`heatmapScale`), so the picture carries its scale. A chunk of its own, loaded as a heatmap's
 * export controls open: no other view's export carries it.
 */

import { lookupTable } from "../colormap";
import type { HeatmapModel } from "../model";
import type { Paint, Part } from "./palette";

export const HEATMAP_WIDTH = 560;
/** Room left of a heatmap's cells for its row labels. */
export const ROW_LABELS = 96;
const HEATMAP_MAX_HEIGHT = 560;

/** The labels and legend a heatmap's picture prints: every `step`-th row and column label, so as
 *  many fit as the space allows, and the legend's stored texts (`heatmapLegend`: under `absmax`
 *  the sign words and the largest magnitude's cell). */
export interface HeatmapScale {
  readonly rows: readonly (readonly [number, string])[];
  readonly columns: readonly (readonly [number, string])[];
  readonly low: string;
  readonly high: string;
  readonly note: string | null;
}

/** Which labels to print when `fit` of them fit along each axis, and the legend's words. */
export function heatmapScale(
  model: HeatmapModel,
  legend: { readonly low: string; readonly high: string; readonly note: string | null },
  fit: { readonly rows: number; readonly columns: number },
): HeatmapScale {
  const pick = (labels: readonly string[], room: number) => {
    const step = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(room))));
    return labels.flatMap((label, i) => (i % step === 0 ? [[i, label] as const] : []));
  };
  return {
    rows: pick(model.rows.labels, fit.rows),
    columns: pick(model.columns.labels, fit.columns),
    low: legend.low,
    high: legend.high,
    note: legend.note,
  };
}

/** `text` cut to `width`, with an ellipsis when it is cut. */
function fitted(c: CanvasRenderingContext2D, text: string, width: number): string {
  if (c.measureText(text).width <= width) return text;
  let n = text.length;
  while (n > 1 && c.measureText(`${text.slice(0, n)}…`).width > width) n--;
  return `${text.slice(0, n)}…`;
}

/** The page's heatmap cells, one pixel each, scaled without smoothing as the page shows them,
 *  with its row and column labels and its legend: the scale, as the page prints it. */
export function heatmapPart(
  ctx: CanvasRenderingContext2D,
  cells: HTMLCanvasElement,
  model: HeatmapModel,
  legend: Parameters<typeof heatmapScale>[1],

  { light: LIGHT, font: FONT }: Paint,
): Part {
  const height = Math.min(HEATMAP_MAX_HEIGHT, Math.max(cells.height * 4, 120));
  ctx.font = `10px ${FONT}`;
  const widest = Math.max(1, ...model.columns.labels.map((l) => ctx.measureText(l).width));
  const scale = heatmapScale(model, legend, {
    rows: height / 12,
    columns: HEATMAP_WIDTH / Math.min(widest + 8, HEATMAP_WIDTH),
  });
  const rowH = height / Math.max(1, model.rows.labels.length);
  const colW = HEATMAP_WIDTH / Math.max(1, model.columns.labels.length);
  const slot = HEATMAP_WIDTH / Math.max(1, scale.columns.length);
  const table = lookupTable(model.limits.rule === "absmax" ? "diverging" : "sequential");
  return {
    height: height + 40,
    paint(c) {
      c.imageSmoothingEnabled = false;
      c.drawImage(cells, ROW_LABELS, 0, HEATMAP_WIDTH, height);
      c.font = `10px ${FONT}`;
      c.fillStyle = LIGHT.axis;
      c.textAlign = "right";
      c.textBaseline = "middle";
      for (const [r, label] of scale.rows) {
        c.fillText(fitted(c, label, ROW_LABELS - 6), ROW_LABELS - 4, (r + 0.5) * rowH);
      }
      c.textAlign = "center";
      c.textBaseline = "top";
      for (const [k, label] of scale.columns) {
        c.fillText(fitted(c, label, slot - 4), ROW_LABELS + (k + 0.5) * colW, height + 3);
      }
      // The legend: the low end's text, the color bar, the high end's text, then its note.
      const y = height + 22;
      c.font = `12px ${FONT}`;
      c.fillStyle = LIGHT.muted;
      c.textAlign = "left";
      c.fillText(scale.low, ROW_LABELS, y);
      let x = ROW_LABELS + c.measureText(scale.low).width + 6;
      for (let i = 0; i < 160; i++) {
        const e = Math.round((i / 159) * 255) * 3;
        c.fillStyle = `rgb(${table[e]} ${table[e + 1]} ${table[e + 2]})`;
        c.fillRect(x + i, y + 2, 1, 10);
      }
      x += 166;
      c.fillStyle = LIGHT.muted;
      c.fillText(scale.high, x, y);
      x += c.measureText(scale.high).width + 10;
      if (scale.note) c.fillText(scale.note, x, y);
    },
  };
}
