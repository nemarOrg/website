/**
 * The scalp maps' color maps and how a grid is painted with them (website ADR 0035 decision 7;
 * `nemar.sensor-field.v1` step 11).
 *
 * Three maps, each a 256-entry lookup table:
 * - `diverging`, for `absmax` limits (the default): ColorBrewer's RdBu, reversed so negative is blue
 *   and positive red, colorblind-safe by ColorBrewer's rating. Copyright (c) 2002 Cynthia Brewer,
 *   Mark Harrower, and The Pennsylvania State University; licensed under the Apache License,
 *   Version 2.0 (THIRD_PARTY_NOTICES.md). This product includes color specifications and designs
 *   developed by Cynthia Brewer (https://colorbrewer2.org/);
 * - `sequential`, for `minmax` limits: viridis (public domain, CC0), the same stops the signal
 *   viewer's `viridisColor` uses today, so phase W3 can move the viewer onto this module with no
 *   color change (`test/quality-views-colormap.test.ts` holds them equal);
 * - `turbo`, the optional toggle (Apache-2.0, `turbo-lut.ts`).
 *
 * The diverging and sequential stops are design tokens (`--qv-diverging-*`, `--qv-sequential-*` in
 * `src/styles/tokens.css`) for legends drawn in CSS; a canvas needs numbers, so the stops are
 * repeated here and the test holds the two equal. The maps are data colors: the same in both
 * themes.
 */

import type { Pair } from "./sensor-field";
import { TURBO_HEX } from "./turbo-lut";

export type ColorMapName = "diverging" | "sequential" | "turbo";
export type Rgb = readonly [number, number, number];

/** ColorBrewer RdBu, 11 classes, reversed: low (negative) blue to high (positive) red. */
export const DIVERGING_STOPS: readonly string[] = [
  "#053061",
  "#2166ac",
  "#4393c3",
  "#92c5de",
  "#d1e5f0",
  "#f7f7f7",
  "#fddbc7",
  "#f4a582",
  "#d6604d",
  "#b2182b",
  "#67001f",
];

/** Viridis at the signal viewer's ten stops: position on [0, 1] and color. */
export const SEQUENTIAL_STOPS: readonly (readonly [number, string])[] = [
  [0, "#440154"],
  [0.111, "#482878"],
  [0.222, "#3e4a89"],
  [0.333, "#31688e"],
  [0.444, "#26828e"],
  [0.556, "#1f9e89"],
  [0.667, "#35b779"],
  [0.778, "#6ece58"],
  [0.889, "#b5de2b"],
  [1, "#fde725"],
];

/** Entries in each lookup table. */
export const LUT_SIZE = 256;
/** The entry nearest the middle: the color of a map whose axis is one point (`minmax` on a
 *  constant map, or a map of zeros). */
export const MIDDLE = 128;

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.replace(/^#/, ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The color at `t` in [0, 1] (clamped) along `stops`, interpolated linearly in sRGB and rounded,
 *  as the signal viewer's `viridisColor` does. */
export function colorAt(stops: readonly (readonly [number, string])[], t: number): Rgb {
  const u = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (u <= t1) {
      const f = (u - t0) / (t1 - t0);
      const a = hexToRgb(c0);
      const b = hexToRgb(c1);
      return [
        Math.round(a[0] + f * (b[0] - a[0])),
        Math.round(a[1] + f * (b[1] - a[1])),
        Math.round(a[2] + f * (b[2] - a[2])),
      ];
    }
  }
  return hexToRgb(stops[stops.length - 1][1]);
}

const evenly = (colors: readonly string[]): (readonly [number, string])[] =>
  colors.map((color, i) => [i / (colors.length - 1), color] as const);

const tables = new Map<ColorMapName, Uint8Array>();

/** The 256-entry table of a map, three bytes (RGB) per entry, low end first. */
export function lookupTable(name: ColorMapName): Uint8Array {
  const held = tables.get(name);
  if (held) return held;
  const table = new Uint8Array(LUT_SIZE * 3);
  if (name === "turbo") {
    for (let i = 0; i < LUT_SIZE * 3; i++) {
      table[i] = Number.parseInt(TURBO_HEX.slice(i * 2, i * 2 + 2), 16);
    }
  } else {
    const stops = name === "diverging" ? evenly(DIVERGING_STOPS) : SEQUENTIAL_STOPS;
    for (let i = 0; i < LUT_SIZE; i++) table.set(colorAt(stops, i / (LUT_SIZE - 1)), i * 3);
  }
  tables.set(name, table);
  return table;
}

/**
 * The table entry for `value` on the color axis `axis`: a value beyond the axis takes the color at
 * its end, and an axis that is one point gives the middle.
 *
 * The position is computed on halved operands, `(value / 2 − low / 2) / (high / 2 − low / 2)`: an
 * axis of finite limits can still span more than the largest double (a flat field at 1.5e308 has
 * the `absmax` axis ±1.575e308), and the plain difference would overflow to a position that is not a
 * number. Anything that still is not one (a value or limit that is not finite) takes the middle,
 * never an empty entry, so no cell is ever painted black.
 */
export function entryFor(value: number, axis: Pair): number {
  const [low, high] = axis;
  if (!(high > low)) return MIDDLE;
  const t = (value / 2 - low / 2) / (high / 2 - low / 2);
  const entry = Math.max(0, Math.min(LUT_SIZE - 1, Math.round(t * (LUT_SIZE - 1))));
  return Number.isFinite(entry) ? entry : MIDDLE;
}

/**
 * Paint a map's grid (`grid[i * size + j]` at `(x[i], y[j])`, NaN where masked) into RGBA pixels,
 * `size` by `size`, nose up: cell (i, j) is the pixel in row `size − 1 − i`, column j. A masked cell
 * is transparent.
 */
export function paintGrid(
  grid: ArrayLike<number>,
  axis: Pair,
  table: Uint8Array,
  size = Math.round(Math.sqrt(grid.length)),
): Uint8ClampedArray {
  if (size * size !== grid.length) throw new RangeError(`paintGrid: ${grid.length} cells`);
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const value = grid[i * size + j];
      if (Number.isNaN(value)) continue;
      const entry = entryFor(value, axis) * 3;
      const pixel = ((size - 1 - i) * size + j) * 4;
      pixels[pixel] = table[entry];
      pixels[pixel + 1] = table[entry + 1];
      pixels[pixel + 2] = table[entry + 2];
      pixels[pixel + 3] = 255;
    }
  }
  return pixels;
}
