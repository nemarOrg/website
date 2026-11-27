/**
 * Contour lines of a drawn scalp map, by marching squares (website ADR 0035 decision 1).
 *
 * `nemar.sensor-field.v1` fixes the levels (step 12: six, evenly inside the cells' range) and leaves
 * the lines to the renderer, outside parity. This is the site's own: each square of four unmasked
 * neighboring cells that a level crosses gets one segment (two at a saddle, split by the square's
 * mean), its ends placed on the square's edges by linear interpolation. A square with a masked
 * corner draws nothing, so no line enters the area outside the head.
 *
 * Coordinates are the grid's: `x` toward the nose and `y` toward the right ear, so a renderer draws
 * a point at screen `(y, -x)`.
 */

/** One level's segments, four numbers each: `x0, y0, x1, y1`. */
export type ContourSegments = Float32Array;

/**
 * The segments of the level `level` through the grid `z`, where `z[i * y.length + j]` is the value
 * at `(x[i], y[j])` and NaN is a masked cell.
 */
export function contourSegments(
  z: ArrayLike<number>,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  level: number,
): ContourSegments {
  return contourLines(z, x, y, [level])[0];
}

/**
 * The segments of every level, in order: one pass over the squares, each square visited once and
 * traced only for the levels inside its range (a level crosses a square when the smallest corner is
 * at most the level and the largest above it).
 */
export function contourLines(
  z: ArrayLike<number>,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  levels: readonly number[],
): ContourSegments[] {
  const rows = x.length;
  const columns = y.length;
  if (z.length !== rows * columns) {
    throw new RangeError(`contours: ${z.length} cells for a ${rows}-by-${columns} grid`);
  }
  const out: number[][] = levels.map(() => []);
  for (let i = 0; i + 1 < rows; i++) {
    const x0 = x[i];
    const x1 = x[i + 1];
    for (let j = 0; j + 1 < columns; j++) {
      // Corners, counterclockwise: c0 (i, j), c1 (i + 1, j), c2 (i + 1, j + 1), c3 (i, j + 1).
      const z0 = z[i * columns + j];
      const z1 = z[(i + 1) * columns + j];
      const z2 = z[(i + 1) * columns + j + 1];
      const z3 = z[i * columns + j + 1];
      // NaN fails every comparison, so a square with a masked corner is skipped here.
      const low = Math.min(z0, z1, z2, z3);
      const high = Math.max(z0, z1, z2, z3);
      if (!(low <= high)) continue;
      const y0 = y[j];
      const y1 = y[j + 1];
      for (let l = 0; l < levels.length; l++) {
        const level = levels[l];
        if (!(low <= level && level < high)) continue;
        trace(out[l], level, z0, z1, z2, z3, x0, x1, y0, y1);
      }
    }
  }
  return out.map((segments) => Float32Array.from(segments));
}

/**
 * The segments of one level through one square it crosses. Edges: e0 c0-c1 (at y0), e1 c1-c2 (at
 * x1), e2 c3-c2 (at y1), e3 c0-c3 (at x0); the level's point on each is linear between its corners.
 */
function trace(
  out: number[],
  level: number,
  z0: number,
  z1: number,
  z2: number,
  z3: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): void {
  const code =
    (z0 > level ? 1 : 0) | (z1 > level ? 2 : 0) | (z2 > level ? 4 : 0) | (z3 > level ? 8 : 0);
  const e0x = (): number => x0 + ((level - z0) / (z1 - z0)) * (x1 - x0);
  const e1y = (): number => y0 + ((level - z1) / (z2 - z1)) * (y1 - y0);
  const e2x = (): number => x0 + ((level - z3) / (z2 - z3)) * (x1 - x0);
  const e3y = (): number => y0 + ((level - z0) / (z3 - z0)) * (y1 - y0);
  switch (code) {
    case 1:
    case 14:
      out.push(x0, e3y(), e0x(), y0);
      return;
    case 2:
    case 13:
      out.push(e0x(), y0, x1, e1y());
      return;
    case 3:
    case 12:
      out.push(x0, e3y(), x1, e1y());
      return;
    case 4:
    case 11:
      out.push(x1, e1y(), e2x(), y1);
      return;
    case 6:
    case 9:
      out.push(e0x(), y0, e2x(), y1);
      return;
    case 7:
    case 8:
      out.push(x0, e3y(), e2x(), y1);
      return;
    default: {
      // A saddle (5 or 10): the corners above the level are joined through the middle when the
      // square's mean is above it too, and the lines then cut off the two corners below.
      const middleAbove = (z0 + z1 + z2 + z3) / 4 > level;
      if ((code === 5) !== middleAbove) {
        out.push(x0, e3y(), e0x(), y0, x1, e1y(), e2x(), y1);
      } else {
        out.push(e0x(), y0, x1, e1y(), x0, e3y(), e2x(), y1);
      }
    }
  }
}
