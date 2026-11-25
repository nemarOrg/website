/**
 * The scalp maps' color maps (website ADR 0035 decision 7): the tokens and the canvas tables agree,
 * the sequential map is the signal viewer's viridis (so phase W3 moves the viewer onto it with no
 * color change), the Turbo table is Google's, rounded to 8 bits, with its notice, and a grid is
 * painted nose up with masked cells left transparent.
 */

import { describe, expect, it } from "vitest";
import {
  COLOR_MAPS_NOTICE,
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
import { sensorField } from "../src/lib/quality-views/sensor-field";
import { TURBO_HEX } from "../src/lib/quality-views/turbo-lut";
import { nodeFs, repoPath, sha256Hex } from "./node";
import { loadFieldVectors, numbers } from "./quality-views-vectors";

const fs = await nodeFs();
const field = await loadFieldVectors();
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

  it("make the sequential map the signal viewer's former viridis, color for color", async () => {
    // The digest of the 256-entry table the viewer's `viridisColor` gave (removed in phase W3),
    // the same one the iEEG activity overlay's table is pinned to (src/lib/ieeg-spatial).
    expect(await sha256Hex(JSON.stringify([...lookupTable("sequential")]))).toBe(
      "81b0cc4ed9099f6720f202189ad366431f29baebcb153e7bda6bdf19497294cb",
    );
    expect([...colorAt(SEQUENTIAL_STOPS, 0)]).toEqual([68, 1, 84]);
    expect([...colorAt(SEQUENTIAL_STOPS, 1)]).toEqual([253, 231, 37]);
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
    expect(notices).toContain(`public${COLOR_MAPS_NOTICE}`);
    expect([...lookupTable("turbo").slice(0, 3)]).toEqual([48, 18, 59]);
  });
});

describe("the color maps' notices", () => {
  it("ship with the site: both copyrights and the full Apache License, Version 2.0", () => {
    expect(COLOR_MAPS_NOTICE).toBe("/licenses/quality-views/NOTICE.txt");
    const notice = fs.readFileSync(repoPath(`public${COLOR_MAPS_NOTICE}`), "utf8");
    expect(notice).toContain("Copyright 2019 Google LLC. Author: Anton Mikhailov.");
    expect(notice).toContain(
      "Copyright (c) 2002 Cynthia Brewer, Mark Harrower, and The Pennsylvania State University.",
    );
    expect(notice).toContain("This product includes color specifications and designs developed by");
    expect(notice).toContain("Version 2.0, January 2004");
    expect(notice).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
    expect(notice).toContain("4. Redistribution.");
    expect(notice.trimEnd().endsWith("END OF TERMS AND CONDITIONS")).toBe(true);
    expect(notice).not.toContain("\r");
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

  it("places a value on an axis wider than the largest double, and never leaves a cell black", () => {
    // flat_huge_duplicate_pair: a flat field at 1.5e308, whose absmax axis is +-1.575e308.
    const vectorCase = field.cases.find((c) => c.name === "flat_huge_duplicate_pair")!;
    const result = sensorField(
      numbers(vectorCase.sensors.theta_deg!),
      numbers(vectorCase.sensors.radius!),
      numbers(vectorCase.sensors.value),
    );
    if (result.kind !== "map") throw new Error(result.word);
    const axis = result.map.colorAxis.absmax;
    expect(axis[1] - axis[0]).toBe(Number.POSITIVE_INFINITY);
    // (1.5e308 + 1.575e308) / (2 * 1.575e308) of the way up: entry 249 of 255.
    expect(entryFor(1.5e308, axis)).toBe(249);
    const table = lookupTable("diverging");
    const pixels = paintGrid(result.map.z, axis, table);
    let painted = 0;
    for (let p = 0; p < pixels.length; p += 4) {
      if (pixels[p + 3] === 0) continue;
      painted++;
      expect([pixels[p], pixels[p + 1], pixels[p + 2]]).toEqual([
        table[249 * 3],
        table[249 * 3 + 1],
        table[249 * 3 + 2],
      ]);
    }
    expect(painted).toBe(result.map.geometry.inside.length);
    // Its minmax axis is one point: the middle.
    expect(entryFor(1.5e308, result.map.colorAxis.minmax)).toBe(MIDDLE);
  });

  it("gives the middle, not an empty entry, to a value or axis that is not finite", () => {
    expect(entryFor(Number.NaN, [0, 1])).toBe(MIDDLE);
    expect(entryFor(1, [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY])).toBe(MIDDLE);
    expect(entryFor(Number.POSITIVE_INFINITY, [0, 1])).toBe(LUT_SIZE - 1);
    expect(entryFor(-1.7e308, [1.7e308, 1.79e308])).toBe(0);
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
