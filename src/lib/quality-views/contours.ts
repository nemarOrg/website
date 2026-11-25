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
  const rows = x.length;
  const columns = y.length;
  if (z.length !== rows * columns) {
    throw new RangeError(`contours: ${z.length} cells for a ${rows}-by-${columns} grid`);
  }
  const out: number[] = [];
  // Corners of the square at (i, j), counterclockwise: c0 (i, j), c1 (i + 1, j),
  // c2 (i + 1, j + 1), c3 (i, j + 1). Edges: e0 c0-c1, e1 c1-c2, e2 c3-c2, e3 c0-c3.
  const ex = [0, 0, 0, 0];
  const ey = [0, 0, 0, 0];
  for (let i = 0; i + 1 < rows; i++) {
    for (let j = 0; j + 1 < columns; j++) {
      const z0 = z[i * columns + j];
      const z1 = z[(i + 1) * columns + j];
      const z2 = z[(i + 1) * columns + j + 1];
      const z3 = z[i * columns + j + 1];
      if (Number.isNaN(z0) || Number.isNaN(z1) || Number.isNaN(z2) || Number.isNaN(z3)) continue;
      const code =
        (z0 > level ? 1 : 0) | (z1 > level ? 2 : 0) | (z2 > level ? 4 : 0) | (z3 > level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const x0 = x[i];
      const x1 = x[i + 1];
      const y0 = y[j];
      const y1 = y[j + 1];
      // Where the level crosses each edge (only crossed edges are read).
      ex[0] = x0 + ((level - z0) / (z1 - z0)) * (x1 - x0);
      ey[0] = y0;
      ex[1] = x1;
      ey[1] = y0 + ((level - z1) / (z2 - z1)) * (y1 - y0);
      ex[2] = x0 + ((level - z3) / (z2 - z3)) * (x1 - x0);
      ey[2] = y1;
      ex[3] = x0;
      ey[3] = y0 + ((level - z0) / (z3 - z0)) * (y1 - y0);
      const join = (a: number, b: number): void => {
        out.push(ex[a], ey[a], ex[b], ey[b]);
      };
      switch (code) {
        case 1:
        case 14:
          join(3, 0);
          break;
        case 2:
        case 13:
          join(0, 1);
          break;
        case 3:
        case 12:
          join(3, 1);
          break;
        case 4:
        case 11:
          join(1, 2);
          break;
        case 6:
        case 9:
          join(0, 2);
          break;
        case 7:
        case 8:
          join(3, 2);
          break;
        case 5:
        case 10: {
          // A saddle: the corners above the level are joined through the middle when the square's
          // mean is above it too, and the lines then cut off the two corners below.
          const middleAbove = (z0 + z1 + z2 + z3) / 4 > level;
          const cutC0AndC2 = (code === 5) !== middleAbove;
          if (cutC0AndC2) {
            join(3, 0);
            join(1, 2);
          } else {
            join(0, 1);
            join(3, 2);
          }
          break;
        }
      }
    }
  }
  return Float32Array.from(out);
}

/** The segments of every level, in order. */
export function contourLines(
  z: ArrayLike<number>,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  levels: readonly number[],
): ContourSegments[] {
  return levels.map((level) => contourSegments(z, x, y, level));
}
