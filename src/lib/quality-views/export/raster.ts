/**
 * The PNG export's picture (website phase W8; nemar-cli ADR 0137 decision 9: "PNG at two to four
 * times in a light print palette"): the view's caption, its drawing, every scalp map it shows and
 * the lines naming the view (`meta.ts`), painted on a canvas at the chosen scale, light whatever
 * the page's theme.
 *
 * - A line chart or a histogram is the renderer's own SVG tree, painted element by element
 *   (`paintTree`): the page's Content Security Policy lets no `blob:` image load, and the tree is
 *   what the page drew.
 * - A heatmap is the page's own canvas of its cells, one pixel each, scaled without smoothing, with
 *   its row and column labels and its legend's stored texts (`heatmapScale`).
 * - Scalp maps are painted by the page's own `paintFieldMap`, every drawn map including those never
 *   scrolled into view, with the contour lines `SensorFieldHandle.drawnMaps()` hands over
 *   (`contoursOf`: a map off screen has none from the worker, and gets them traced there).
 *
 * The renderers' modules are imported on demand: each is the one the page drew the view with,
 * already loaded, so painting makes no request, and the export's chunk does not carry them.
 */

import { type ColorMapName, lookupTable } from "../colormap";
import type { BuiltModel, HeatmapModel, SensorFieldModel } from "../model";
import type { SensorFieldHandle } from "../render/sensor-field-view";
import type { Child, Element } from "../tree";
import type { DrawnMap } from "../worker-client";
import { type ExportMeta, footerLines, wrapText } from "./meta";
import { FONT, LIGHT, hasSvg, paintOf, viewBoxSize } from "./palette";
import { svgDrawing } from "./svg";

/** The scales an export offers. */
export const SCALES = [2, 3, 4] as const;
export type Scale = (typeof SCALES)[number];

/** A scalp-map view on the page, as the export reads it. */
export interface ExportField {
  readonly built: BuiltModel & { readonly model: SensorFieldModel };
  readonly field: Pick<SensorFieldHandle, "drawnMaps">;
  readonly colorMap: ColorMapName;
}

/** One drawn map of a field with its contour lines, ready to paint. */
export interface ExportMap {
  readonly index: number;
  readonly label: string;
  readonly map: DrawnMap;
  readonly contours: readonly Float32Array[];
}

/** Every drawn map of a field, in map order, each with its lines: the handle's (`contoursOf`),
 *  set as the map's own, so `paintFieldMap` draws them for a map the worker did not trace. */
export function fieldMaps(field: ExportField): ExportMap[] {
  return field.field.drawnMaps().map(({ index, map, contours }) => ({
    index,
    label: field.built.model.maps.items[index]?.label ?? String(index),
    map: { ...map, contourLines: contours },
    contours,
  }));
}

/** A map's square in CSS pixels: `MAP_SIZE` of `sensor-field-view.ts` (the tests hold them equal). */
export const MAP_PX = 160;
const PAD = 12;
const TEXT = 14;
const MAP_GAP = 16;
const MAP_LABEL = 16;
/** Maps per row, at most. */
export const MAPS_PER_ROW = 6;
const HEATMAP_WIDTH = 560;
/** Room left of a heatmap's cells for its row labels. */
const ROW_LABELS = 96;
const HEATMAP_MAX_HEIGHT = 560;

/** A part of the picture: its height at scale 1 and how it paints at the origin. */
interface Part {
  readonly height: number;
  paint(ctx: CanvasRenderingContext2D): void;
}

function textPart(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
  font: string,
  color: string,
): Part {
  ctx.font = font;
  const lines = wrapText(text, (line) => ctx.measureText(line).width <= width);
  return {
    height: lines.length * TEXT + 4,
    paint(c) {
      c.font = font;
      c.fillStyle = color;
      c.textBaseline = "top";
      lines.forEach((line, i) => c.fillText(line, 0, i * TEXT));
    },
  };
}

/** Apply an SVG `transform` list of `translate` and `rotate`. */
function applyTransform(ctx: CanvasRenderingContext2D, transform: string | undefined): void {
  if (!transform) return;
  for (const [, name, args] of transform.matchAll(/(translate|rotate)\(([^)]*)\)/g)) {
    const [a = 0, b = 0] = args
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (name === "translate") ctx.translate(a, b);
    else ctx.rotate((a * Math.PI) / 180);
  }
}

const num = (node: Element, name: string): number => Number(node.attrs[name] ?? 0);

/** Paint an SVG tree of the renderers (`g`, `line`, `polyline`, `rect`, `text`) in the light
 *  palette (`CLASS_PAINT`); `title` and every other element are left out. */
export function paintTree(ctx: CanvasRenderingContext2D, node: Child, inherited = ""): void {
  if (typeof node === "string") return;
  const classes = `${inherited} ${node.attrs.class ?? ""}`.trim();
  const paint = paintOf(classes);
  if (paint.hidden || node.attrs.visibility === "hidden") return;
  ctx.save();
  applyTransform(ctx, node.attrs.transform);
  ctx.strokeStyle = paint.stroke ?? LIGHT.axis;
  ctx.lineWidth = paint.strokeWidth ?? 1;
  ctx.globalAlpha = paint.strokeOpacity ?? 1;
  switch (node.tag) {
    case "svg":
    case "g":
      for (const child of node.children) paintTree(ctx, child, classes);
      break;
    case "line":
      ctx.beginPath();
      ctx.moveTo(num(node, "x1"), num(node, "y1"));
      ctx.lineTo(num(node, "x2"), num(node, "y2"));
      ctx.stroke();
      break;
    case "polyline":
      ctx.beginPath();
      for (const [i, point] of (node.attrs.points ?? "").split(/\s+/).filter(Boolean).entries()) {
        const [x, y] = point.split(",").map(Number);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      break;
    case "rect":
      ctx.globalAlpha = 1;
      ctx.fillStyle = paint.fill ?? LIGHT.series;
      ctx.fillRect(num(node, "x"), num(node, "y"), num(node, "width"), num(node, "height"));
      break;
    case "text": {
      ctx.globalAlpha = 1;
      ctx.fillStyle = paint.fill ?? LIGHT.foreground;
      ctx.font = `${paint.fontSize ?? 11}px ${FONT}`;
      const anchor = node.attrs["text-anchor"];
      ctx.textAlign = anchor === "middle" ? "center" : anchor === "end" ? "right" : "left";
      ctx.textBaseline = "alphabetic";
      const text = node.children.filter((c): c is string => typeof c === "string").join("");
      ctx.fillText(text, num(node, "x"), num(node, "y"));
      break;
    }
  }
  ctx.restore();
}

function treePart(drawing: Element): Part {
  const { width, height } = viewBoxSize(drawing);
  return {
    height,
    paint(c) {
      c.beginPath();
      c.rect(0, 0, width, height);
      c.clip();
      paintTree(c, drawing);
    },
  };
}

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
function heatmapPart(
  ctx: CanvasRenderingContext2D,
  cells: HTMLCanvasElement,
  model: HeatmapModel,
  legend: Parameters<typeof heatmapScale>[1],
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

/** Every drawn map of a field in rows of at most `MAPS_PER_ROW`, each with its label, then the
 *  legend's words and where the positions came from. */
async function mapParts(
  ctx: CanvasRenderingContext2D,
  doc: Document,
  field: ExportField,
  width: number,
): Promise<Part[]> {
  const maps = fieldMaps(field);
  if (maps.length === 0) return [];
  const view = await import("../render/sensor-field-view");
  const draw = view.fieldDrawInput(field.built);
  if (!draw) return [];
  const { model } = field.built;
  const perRow = Math.max(
    1,
    Math.min(MAPS_PER_ROW, Math.floor((width + MAP_GAP) / (MAP_PX + MAP_GAP))),
  );
  const cell = MAP_PX + MAP_LABEL + MAP_GAP;
  const scratch = doc.createElement("canvas");
  const colors = { foreground: LIGHT.head, background: LIGHT.background, contour: LIGHT.contour };
  const grid: Part = {
    height: Math.ceil(maps.length / perRow) * cell,
    paint(c) {
      maps.forEach((m, i) => {
        c.save();
        c.translate((i % perRow) * (MAP_PX + MAP_GAP), Math.floor(i / perRow) * cell);
        view.paintFieldMap(c, m.map, draw, model.limits, field.colorMap, colors, scratch, null);
        // paintFieldMap clears its square: the light ground goes back under it.
        c.globalCompositeOperation = "destination-over";
        c.fillStyle = LIGHT.background;
        c.fillRect(0, 0, MAP_PX, MAP_PX);
        c.globalCompositeOperation = "source-over";
        c.font = `12px ${FONT}`;
        c.fillStyle = LIGHT.foreground;
        c.textAlign = "center";
        c.textBaseline = "top";
        c.fillText(m.label, MAP_PX / 2, MAP_PX + 2);
        c.restore();
      });
    },
  };
  const [low, middle, high] = view.legendWords(model);
  const legend = `Colors from ${low}${middle ? ` through ${middle}` : ""} to ${high}, each map on its own range (${field.colorMap}).`;
  const font = `12px ${FONT}`;
  return [
    grid,
    textPart(ctx, legend, width, font, LIGHT.muted),
    textPart(ctx, view.placementStatement(model), width, font, LIGHT.muted),
  ];
}

/** What a PNG export draws: the view's base drawing and the scalp maps on show with it. */
export interface PictureInput {
  readonly meta: ExportMeta;
  readonly built: BuiltModel | null;
  readonly fields: readonly ExportField[];
  /** The page's canvas of a heatmap's cells (`.qv-heatmap-cells`), when the view is one. */
  readonly heatmap?: HTMLCanvasElement | null;
}

/** Whether a view has a picture to export: a drawing, a heatmap or a drawn map. */
export function hasPicture(input: Omit<PictureInput, "meta">): boolean {
  return (
    hasSvg(input.built) ||
    !!input.heatmap ||
    input.fields.some((f) => f.field.drawnMaps().length > 0)
  );
}

/** Paint the picture on a new canvas of `doc` at `scale`. */
export async function paintPicture(
  doc: Document,
  input: PictureInput,
  scale: Scale,
): Promise<HTMLCanvasElement> {
  const canvas = doc.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("export: no 2D canvas");
  const drawing = await svgDrawing(input.built);
  const maps = Math.max(0, ...input.fields.map((f) => f.field.drawnMaps().length));
  const inner = Math.max(
    480,
    drawing ? viewBoxSize(drawing).width : 0,
    input.heatmap ? ROW_LABELS + HEATMAP_WIDTH : 0,
    Math.min(MAPS_PER_ROW, maps) * (MAP_PX + MAP_GAP) - MAP_GAP,
  );
  const font = `600 14px ${FONT}`;
  const parts: Part[] = [textPart(ctx, input.meta.caption, inner, font, LIGHT.foreground)];
  if (drawing) parts.push(treePart(drawing));
  if (input.heatmap && input.built?.model.type === "heatmap") {
    const model = input.built.model as HeatmapModel;
    // The page's own legend words (its renderer, already loaded).
    const { heatmapLegend } = await import("../render/heatmap");
    parts.push(heatmapPart(ctx, input.heatmap, model, heatmapLegend(model)));
  }
  for (const field of input.fields) parts.push(...(await mapParts(ctx, doc, field, inner)));
  for (const line of footerLines(input.meta)) {
    parts.push(textPart(ctx, line, inner, `10px ${FONT}`, LIGHT.muted));
  }
  const width = inner + PAD * 2;
  const height = PAD * 2 + parts.reduce((sum, p) => sum + p.height + 6, 0);
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  // A resized canvas resets its context: scale it now, then paint on the light ground.
  ctx.scale(scale, scale);
  ctx.fillStyle = LIGHT.background;
  ctx.fillRect(0, 0, width, height);
  let y = PAD;
  for (const part of parts) {
    ctx.save();
    ctx.translate(PAD, y);
    part.paint(ctx);
    ctx.restore();
    y += part.height + 6;
  }
  return canvas;
}
