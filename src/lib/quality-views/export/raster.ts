/**
 * The PNG export's picture (website phase W8; nemar-cli ADR 0137 decision 9: "PNG at two to four
 * times in a light print palette"): the view's caption, its drawing, every scalp map it shows and
 * the lines naming the view (`meta.ts`), painted on a canvas at the chosen scale, light whatever
 * the page's theme.
 *
 * - A line chart or a histogram is the renderer's own SVG tree, painted element by element
 *   (`paintTree`): the page's Content Security Policy lets no `blob:` image load, and the tree is
 *   what the page drew.
 * - A heatmap is the page's own canvas of its cells, with its labels and legend.
 * - Scalp maps are every drawn map, those never scrolled into view included, with their contour
 *   lines (`maps-part.ts`).
 * - A heatmap's part (`heatmap-part.ts`) and the maps' are chunks of their own, loaded as the
 *   controls of a view that has them open.
 *
 * The renderers' modules are imported on demand: each is the one the page drew the view with,
 * already loaded, so painting makes no request, and the export's chunk does not carry them.
 */

import type { ColorMapName } from "../colormap";
import type { BuiltModel, HeatmapModel, SensorFieldModel } from "../model";
import type { SensorFieldHandle } from "../render/sensor-field-view";
import type { Child, Element } from "../tree";
import { type ExportMeta, footerLines, wrapText } from "./meta";
import { FONT, LIGHT, type Part, hasSvg, paintOf, viewBoxSize } from "./palette";
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

const PAD = 12;
const PAINT = { light: LIGHT, font: FONT };
const TEXT = 14;
/** A map's cell and the maps a row holds at most (`maps-part.ts`'s; the tests hold them equal),
 *  and a heatmap's width with its row labels (`heatmap-part.ts`'s): the picture's width. */
export const MAP_CELL = 176;
export const MAPS_PER_ROW = 6;
export const HEATMAP_PICTURE_WIDTH = 656;
/** A computed view's window, as wide as a line chart. */
const ACTIVITY_WIDTH = 640;

/** A paragraph of text wrapped to `width`. */
export function textPart(
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

/** What a PNG export draws: the view's base drawing and the scalp maps on show with it. */
export interface PictureInput {
  readonly meta: ExportMeta;
  readonly built: BuiltModel | null;
  readonly fields: readonly ExportField[];
  /** The page's canvas of a heatmap's cells (`.qv-heatmap-cells`), when the view is one. */
  readonly heatmap?: HTMLCanvasElement | null;
  /** A computed view's drawn window (the activations): its height, and a painter of it in the
   *  colors given (`activityPainter`), drawn again in 2D rather than read from the page. */
  readonly activity?: {
    readonly height: number;
    painter(colors: {
      background: string;
      foreground: string;
      grid: string;
    }): Promise<(ctx: CanvasRenderingContext2D, width: number, height: number) => void>;
  } | null;
}

/** Whether a view has a picture to export: a drawing, a heatmap or a drawn map. */
export function hasPicture(input: Omit<PictureInput, "meta">): boolean {
  return (
    hasSvg(input.built) ||
    !!input.heatmap ||
    !!input.activity ||
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
    input.heatmap ? HEATMAP_PICTURE_WIDTH : 0,
    input.activity ? ACTIVITY_WIDTH : 0,
    Math.min(MAPS_PER_ROW, maps) * MAP_CELL - (MAP_CELL - 160),
  );
  const font = `600 14px ${FONT}`;
  const parts: Part[] = [textPart(ctx, input.meta.caption, inner, font, LIGHT.foreground)];
  if (drawing) parts.push(treePart(drawing));
  if (input.heatmap && input.built?.model.type === "heatmap") {
    const model = input.built.model as HeatmapModel;
    // The page's own legend words (its renderer, already loaded), and the heatmap's part (a
    // chunk the controls load as they open).
    const [{ heatmapLegend }, { heatmapPart }] = await Promise.all([
      import("../render/heatmap"),
      import("./heatmap-part"),
    ]);
    parts.push(heatmapPart(ctx, input.heatmap, model, heatmapLegend(model), PAINT));
  }
  if (input.activity) {
    const { height } = input.activity;
    const paint = await input.activity.painter({
      background: LIGHT.background,
      foreground: LIGHT.foreground,
      grid: LIGHT.grid,
    });
    parts.push({ height, paint: (c) => paint(c, inner, height) });
  }
  if (input.fields.length > 0) {
    const { mapParts } = await import("./maps-part");
    const font = `12px ${FONT}`;
    for (const field of input.fields) {
      const got = await mapParts(doc, field, inner, PAINT);
      if (!got) continue;
      parts.push(got.grid, textPart(ctx, got.legend, inner, font, LIGHT.muted));
      parts.push(textPart(ctx, got.placement, inner, font, LIGHT.muted));
    }
  }
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
