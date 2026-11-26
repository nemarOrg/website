/**
 * The exports' light print palette (website phase W8; nemar-cli ADR 0137 decision 9): an exported
 * image is light whatever the page's theme. Shared by the SVG (`svg.ts`, as an inline `<style>`)
 * and the PNG (`raster.ts`, painting element by element).
 */

import type { Element } from "../tree";

/** The values of the page's tokens in the light theme (`tokens.css`, `:root`;
 *  `test/quality-views-export.test.ts` holds them equal). */
export const LIGHT = {
  background: "#ffffff", // --color-bg
  foreground: "#0f172a", // --color-fg
  muted: "#475569", // --color-fg-muted
  axis: "#56657a", // --chart-axis
  series: "#172554", // --chart-series-1
  selected: "#ea580c", // --chart-series-2
  end: "#334155", // --chart-series-4
  head: "#334155", // --qv-head-line
  contour: "rgb(15 23 42 / 45%)", // --qv-contour-line
} as const;

/** How an element of a drawing is painted, by its class. */
export interface ClassPaint {
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly strokeOpacity?: number;
  readonly fill?: string;
  readonly fontSize?: number;
  /** Not drawn in an export (the page's cursor). */
  readonly hidden?: boolean;
}

/** The renderers' classes in the light palette (`src/styles/quality-views.css` in the light theme). */
export const CLASS_PAINT: Readonly<Record<string, ClassPaint>> = {
  "qv-axis": { stroke: LIGHT.axis, strokeWidth: 1 },
  "qv-tick": { fill: LIGHT.axis, fontSize: 11 },
  "qv-axis-label": { fill: LIGHT.axis, fontSize: 11 },
  "qv-mark": { fill: LIGHT.axis, fontSize: 11 },
  "qv-series": { stroke: LIGHT.series, strokeWidth: 1, strokeOpacity: 0.75 },
  "qv-bar": { fill: LIGHT.series },
  "qv-bar-end": { fill: LIGHT.end },
  "qv-marked": { fill: LIGHT.selected },
  "qv-cursor": { hidden: true },
};

/** The paint of an element by its classes, later classes over earlier ones. */
export function paintOf(classes: string | undefined): ClassPaint {
  let paint: ClassPaint = {};
  for (const name of (classes ?? "").split(/\s+/)) {
    if (Object.hasOwn(CLASS_PAINT, name)) paint = { ...paint, ...CLASS_PAINT[name] };
  }
  return paint;
}

export const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** The size a drawing's `viewBox` declares. */
export function viewBoxSize(drawing: Element): { width: number; height: number } {
  const [, , width, height] = (drawing.attrs.viewBox ?? "0 0 0 0").split(/\s+/).map(Number);
  return { width, height };
}

/** Whether a built view has a drawing an export can write as SVG: a line chart (the spectrum) or
 *  a histogram. A scalp map or a heatmap is an image of cells, exported as PNG only. */
export const hasSvg = (built: { refused: unknown; model: { type: string } } | null): boolean =>
  built !== null &&
  built.refused === null &&
  (built.model.type === "lines" || built.model.type === "histogram");

/** A part of an exported picture: its height at scale 1 and how it paints at its origin. */
export interface Part {
  readonly height: number;
  paint(ctx: CanvasRenderingContext2D): void;
}

/** The palette and font a part paints with, handed to the parts' chunks so they import nothing
 *  the picture's chunk holds. */
export interface Paint {
  readonly light: typeof LIGHT;
  readonly font: string;
}
