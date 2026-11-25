/**
 * The scalp maps' color maps (website ADR 0035 decision 7): the tokens and the canvas tables agree,
 * the sequential map is the signal viewer's viridis (so phase W3 moves the viewer onto it with no
 * color change), the Turbo table is Google's, rounded to 8 bits, with its notice, and a grid is
 * painted nose up with masked cells left transparent.
 */

import { describe, expect, it } from "vitest";
import { viridisColor } from "../src/lib/eeg-viewer/topo";
import {
  DIVERGING_STOPS,
  LUT_SIZE,
  MIDDLE,
  SEQUENTIAL_STOPS,
  colorAt,
  entryFor,
  hexToRgb,
  lookupTable,
  paintGrid,
} from "../src/lib/quality-views/colormap";
import { TURBO_HEX } from "../src/lib/quality-views/turbo-lut";
import { nodeFs, repoPath, sha256Hex } from "./node";

const fs = await nodeFs();
const TOKENS = fs.readFileSync(repoPath("src/styles/tokens.css"), "utf8");

function block(startMarker: string): string {
  const start = TOKENS.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = TOKENS.indexOf("{", start); i < TOKENS.length; i++) {
    if (TOKENS[i] === "{") depth++;
    if (TOKENS[i] === "}") {
      depth--;
      if (depth === 0) return TOKENS.slice(start, i);
    }
  }
  throw new Error("unbalanced braces");
}

function token(css: string, name: string): string | undefined {
  return new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1].trim();
}

const LIGHT = block("\n:root {");
const DARK_MEDIA = block(':root:not([data-theme="light"])');
const DARK = block(':root[data-theme="dark"]');

describe("the color-map tokens", () => {
  it("are the diverging and sequential stops the canvas paints with", () => {
    DIVERGING_STOPS.forEach((hex, i) => expect(token(LIGHT, `--qv-diverging-${i}`)).toBe(hex));
    expect(token(LIGHT, `--qv-diverging-${DIVERGING_STOPS.length}`)).toBeUndefined();
    SEQUENTIAL_STOPS.forEach(([, hex], i) =>
      expect(token(LIGHT, `--qv-sequential-${i}`)).toBe(hex),
    );
    expect(token(LIGHT, `--qv-sequential-${SEQUENTIAL_STOPS.length}`)).toBeUndefined();
  });

  it("keep data colors out of the dark blocks, and give the head outline a color per theme", () => {
    for (const dark of [DARK_MEDIA, DARK]) {
      expect(dark).not.toMatch(/--qv-(diverging|sequential)-/);
      expect(token(dark, "--qv-head-line")).toBe("#cbd5e1");
    }
    expect(token(LIGHT, "--qv-head-line")).toBe("#334155");
  });
});

describe("the color maps", () => {
  it("run the diverging map from blue through near-white to red", () => {
    const table = lookupTable("diverging");
    expect(table).toHaveLength(LUT_SIZE * 3);
    expect([...table.slice(0, 3)]).toEqual([...hexToRgb("#053061")]);
    expect([...table.slice(-3)]).toEqual([...hexToRgb("#67001f")]);
    const middle = [...table.slice(MIDDLE * 3, MIDDLE * 3 + 3)];
    expect(Math.min(...middle)).toBeGreaterThan(240);
  });

  it("make the sequential map the signal viewer's viridis, color for color", () => {
    for (let k = 0; k <= 200; k++) {
      const t = -1 + k / 100;
      expect(colorAt(SEQUENTIAL_STOPS, (Math.max(-1, Math.min(1, t)) + 1) / 2)).toEqual(
        viridisColor(t),
      );
    }
  });

  it("hold Google's Turbo table, rounded to 8 bits, with its Apache-2.0 notice", async () => {
    expect(TURBO_HEX).toMatch(/^[0-9a-f]{1536}$/);
    expect(TURBO_HEX.slice(0, 6)).toBe("30123b");
    expect(TURBO_HEX.slice(-6)).toBe("7a0403");
    // The digest of the table as generated from the published floats, round(v * 255).
    expect(await sha256Hex(TURBO_HEX)).toBe(
      "b13497b0473a512b463460741c8f6b8f47350eae667e5d1c1e636a09c79d9193",
    );
    const source = fs.readFileSync(repoPath("src/lib/quality-views/turbo-lut.ts"), "utf8");
    expect(source).toContain("Copyright 2019 Google LLC");
    expect(source).toContain("Apache License, Version 2.0");
    const notices = fs.readFileSync(repoPath("THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain("### Turbo color map");
    expect(notices).toContain("### ColorBrewer RdBu");
    expect([...lookupTable("turbo").slice(0, 3)]).toEqual([48, 18, 59]);
  });
});

describe("painting a grid", () => {
  it("takes the end colors beyond the axis and the middle on an axis of one point", () => {
    expect(entryFor(-5, [-1, 1])).toBe(0);
    expect(entryFor(5, [-1, 1])).toBe(LUT_SIZE - 1);
    expect(entryFor(0, [-1, 1])).toBe(128);
    expect(entryFor(3, [3, 3])).toBe(MIDDLE);
    expect(entryFor(0, [0, 0])).toBe(MIDDLE);
  });

  it("puts the nose up and leaves masked cells transparent", () => {
    const size = 3;
    // Cell (i = 2, j = 0), the largest x (nose) and the smallest y (left), is the high value.
    const grid = [0, 0, Number.NaN, 0, 0, 0, 1, 0, 0];
    const pixels = paintGrid(grid, [0, 1], lookupTable("sequential"), size);
    expect([...pixels.slice(0, 4)]).toEqual([...hexToRgb("#fde725"), 255]);
    // Cell (0, 2) is masked: the bottom-right pixel.
    expect(pixels[(2 * size + 2) * 4 + 3]).toBe(0);
    expect(() => paintGrid([1, 2, 3], [0, 1], lookupTable("turbo"))).toThrow(RangeError);
  });
});
