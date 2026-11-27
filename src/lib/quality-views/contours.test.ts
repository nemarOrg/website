import { describe, expect, it } from "vitest";
import { contourLines, contourSegments } from "./contours";

/** A grid of `n` points per axis on [-0.5, 0.5], with `f(x, y)` in each cell, NaN outside `mask`. */
function grid(
  n: number,
  f: (x: number, y: number) => number,
  mask = (_x: number, _y: number) => true,
) {
  const axis = Float64Array.from({ length: n }, (_, i) => -0.5 + i / (n - 1));
  const z = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      z[i * n + j] = mask(axis[i], axis[j]) ? f(axis[i], axis[j]) : Number.NaN;
    }
  }
  return { z, x: axis, y: axis };
}

function segments(lines: Float32Array): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let s = 0; s < lines.length; s += 4) {
    out.push([lines[s], lines[s + 1], lines[s + 2], lines[s + 3]]);
  }
  return out;
}

describe("contourSegments", () => {
  it("traces a straight level line through a linear field", () => {
    const { z, x, y } = grid(11, (px) => px);
    const lines = segments(contourSegments(z, x, y, 0.13));
    expect(lines).toHaveLength(10);
    for (const [x0, , x1] of lines) {
      expect(x0).toBeCloseTo(0.13, 6);
      expect(x1).toBeCloseTo(0.13, 6);
    }
  });

  it("closes a ring around a peak: every end is shared by exactly two segments", () => {
    const { z, x, y } = grid(41, (px, py) => -(px * px + py * py));
    const lines = segments(contourSegments(z, x, y, -0.04));
    expect(lines.length).toBeGreaterThan(8);
    const ends = new Map<string, number>();
    for (const [x0, y0, x1, y1] of lines) {
      for (const key of [`${x0},${y0}`, `${x1},${y1}`]) ends.set(key, (ends.get(key) ?? 0) + 1);
      // Each end lies on the circle of radius 0.2 to within the grid's linear interpolation.
      expect(Math.hypot(x0, y0)).toBeCloseTo(0.2, 2);
    }
    expect([...ends.values()].every((count) => count === 2)).toBe(true);
  });

  it("draws nothing in a square with a masked corner", () => {
    const { z, x, y } = grid(
      21,
      (px) => px,
      (px, py) => Math.hypot(px, py) <= 0.3,
    );
    for (const [x0, y0, x1, y1] of segments(contourSegments(z, x, y, 0))) {
      expect(Math.hypot(x0, y0)).toBeLessThanOrEqual(0.3 + 0.05);
      expect(Math.hypot(x1, y1)).toBeLessThanOrEqual(0.3 + 0.05);
    }
    const masked = grid(
      5,
      () => 1,
      () => false,
    );
    expect(contourSegments(masked.z, masked.x, masked.y, 0.5)).toHaveLength(0);
  });

  it("splits a saddle by the square's mean", () => {
    const x = [0, 1];
    const y = [0, 1];
    // z[i * 2 + j]: c0 (0,0), c3 (0,1), c1 (1,0), c2 (1,1). c0 and c2 above the level 0.5.
    const above = contourSegments([1, 0, 0, 1], x, y, 0.5);
    // Mean 0.5 is not above 0.5: the corners above are cut off, c0 then c2.
    expect(Array.from(above)).toEqual([0, 0.5, 0.5, 0, 1, 0.5, 0.5, 1]);
    const joined = contourSegments([1, 0.4, 0.3, 1], x, y, 0.5);
    // Mean 0.675 is above: the corners below (c1 at (1,0), c3 at (0,1)) are cut off.
    expect(segments(joined)).toHaveLength(2);
    const [first, second] = segments(joined);
    // c1's corner: from edge c0-c1 (y = 0) to edge c1-c2 (x = 1).
    expect(first[0]).toBeGreaterThan(0.5);
    expect(first[1]).toBe(0);
    expect(first[2]).toBe(1);
    // c3's corner: from edge c0-c3 (x = 0) to edge c3-c2 (y = 1).
    expect(second[0]).toBe(0);
    expect(second[3]).toBe(1);
  });

  it("draws nothing for a level outside the field, and refuses a grid of the wrong size", () => {
    const { z, x, y } = grid(9, (px) => px);
    expect(contourSegments(z, x, y, 2)).toHaveLength(0);
    expect(() => contourSegments([1, 2, 3], [0, 1], [0, 1], 1)).toThrow(RangeError);
  });

  it("gives one set of segments per level, in order", () => {
    const { z, x, y } = grid(11, (px) => px);
    const lines = contourLines(z, x, y, [-0.25, 0.25]);
    expect(lines).toHaveLength(2);
    expect(lines[0][0]).toBeCloseTo(-0.25, 6);
    expect(lines[1][0]).toBeCloseTo(0.25, 6);
  });
});
