/**
 * `nemar.sensor-field.v1`: the scalp map of one value per sensor (nemar-cli ADR 0137 decision 3 and
 * its amendment of 2026-11-24; website ADR 0035 decisions 1 and 5).
 *
 * neuroschema 0.6.0's `docs/views/sensor-field.md` is normative and its
 * `src/neuroschema/views/sensor_field.py` is the Python reference; this module follows both step
 * for step, and `test/quality-views-sensor-field-parity.test.ts` holds it to every case of
 * `views/vectors/sensor-field.v1.json`. In short: EEGLAB's `topoplot` map (version 4
 * interpolation, the biharmonic Green's function d²(ln d − 1)) on a 67-by-67 grid masked at the
 * head, with the rules eegprep leaves implicit stated outright:
 *
 * - sensors within 1e-3 layout units of an earlier kept sensor merge into it at their exact mean,
 *   `first + sum(x − first) / k`;
 * - fewer than 8 interpolated sensors draw no map (`too_few_sensors`);
 * - the map interpolates each value's deviation from the mean and adds the mean back,
 *   z = m + spline(v − m), so a shared offset (a spectrum's decibels) does not ripple;
 * - a flat field is its value in every cell (`flat_field`), and a near-flat one, whose range is at
 *   most 1e-9 of its magnitude, is one color at its mean (`near_flat`);
 * - the `minmax` color axis widens by 5% of the range on each side, the `absmax` one by 5% of each
 *   limit's magnitude (EEGLAB's `caxis`);
 * - a grid past the head (`head_outside_grid`) and an interpolation that overflows
 *   (`interpolation_failed`) are refused with their words.
 *
 * Every step computes in binary64. The work is split so a view's many maps share one geometry: the
 * radii, the merge, the grid and its mask, the factorized interpolation matrix and the evaluation
 * matrix depend only on the layout and on which sensors are usable, so `prepareSensorField` builds
 * them once and `drawSensorFields` draws any number of maps on them (the worker caches the
 * geometry by the layout file's SHA-256). `sensorField` is the one-shot form.
 */

import { type LuFactors, luFactor, luSolveFactored } from "./linalg";

export const SENSOR_FIELD = "nemar.sensor-field.v1";

/** `rmax`: the head circle's radius on the grid; cells beyond it are masked. */
export const HEAD_RADIUS = 0.5;
/** The plotting and interpolation radii reach just past the outermost sensor. */
export const RADIUS_MARGIN = 1.02;
/** Grid points along each axis. */
export const GRID_SIZE = 67;
/** Sensors this close (raw layout units) to an earlier kept sensor merge into it. */
export const MERGE_DISTANCE = 1e-3;
/** Fewer interpolated sensors than this draw no map: as many as `nemar.sensor-labels.v1` needs to
 *  place sensors by name. */
export const MIN_SENSORS = 8;
/** Interior contour levels. */
export const CONTOUR_COUNT = 6;
/** A map whose usable values' range is at most this share of their magnitude is near flat. */
export const NEAR_FLAT = 1e-9;
/** The color axis widens the limits by this share: of each limit's magnitude for `absmax`, of
 *  their range for `minmax`. */
export const COLOR_MARGIN = 0.05;
/** Degrees to radians: the binary64 nearest pi, divided by 180 (0.017453292519943295). */
export const DEG = Math.PI / 180;

/** The words a map is refused with, each of which takes that map's place on the page. */
export type SensorFieldWord = "too_few_sensors" | "head_outside_grid" | "interpolation_failed";
/** What a drawn map says in its caption: every sensor one value, or all within a hair. */
export type SensorFieldNote = "flat_field" | "near_flat";
/** The view's `parameters.limits`; `absmax` when absent. */
export type LimitsRule = "absmax" | "minmax";

export type Pair = readonly [number, number];
export type Point = readonly [number, number];

/** EEGLAB's cartoon nose and right ear for a head of radius 0.5 (`topoplot.m`, lines 1402 to 1409
 *  of sccn/eeglab `develop` at 6c238f7), as (x, y): x to the nose, y to the right ear. */
export const NOSE: readonly Point[] = [
  [0.4954, 0.09],
  [0.57, 0.02],
  [0.575, 0],
  [0.57, -0.02],
  [0.4954, -0.09],
];
export const RIGHT_EAR: readonly Point[] = [
  [0.0955, 0.492],
  [0.1175, 0.51],
  [0.1183, 0.518],
  [0.1146, 0.5299],
  [0.0955, 0.5419],
  [-0.0055, 0.54],
  [-0.0932, 0.547],
  [-0.1313, 0.532],
  [-0.1384, 0.51],
  [-0.1199, 0.484],
];

/** The head outline over a map, in grid coordinates (x to the nose): a circle of radius
 *  `0.5 * squeezefac` about the origin and three polylines, each model point times `squeezefac`. */
export interface Head {
  readonly radius: number;
  readonly nose: readonly Point[];
  readonly rightEar: readonly Point[];
  readonly leftEar: readonly Point[];
}

export function headOutline(squeezefac: number): Head {
  const scale = (points: readonly Point[]): Point[] =>
    points.map(([x, y]) => [x * squeezefac + 0, y * squeezefac + 0] as const);
  return {
    radius: HEAD_RADIUS * squeezefac,
    nose: scale(NOSE),
    rightEar: scale(RIGHT_EAR),
    leftEar: scale(RIGHT_EAR.map(([x, y]) => [x, -y] as const)),
  };
}

/**
 * Everything about a map that depends only on the layout and on which sensors are usable. Sensor
 * indices are input rows, counted from 0.
 */
export interface SensorFieldGeometry {
  /** Input rows. */
  readonly rows: number;
  /** The layout the geometry was built from, one theta (degrees) and radius per row. */
  readonly thetaDeg: Float64Array;
  readonly radius: Float64Array;
  /** 1 for a usable row (its value, theta and radius finite), 0 otherwise. */
  readonly usable: Uint8Array;
  readonly plotrad: number;
  readonly intrad: number;
  readonly squeezefac: number;
  /** Usable rows whose radius is at most `plotrad`: each gets a marker. */
  readonly plotted: readonly number[];
  /** Kept rows inside the interpolation square, in row order. */
  readonly interpolated: readonly number[];
  /** Each kept row that absorbed others, with its group (itself first), in kept order. */
  readonly merged: readonly (readonly number[])[];
  /** For each interpolated row, its merge group (itself first, then the rows merged into it). */
  readonly groups: readonly (readonly number[])[];
  /** Grid positions of the interpolated sensors (raw layout times `squeezefac`). */
  readonly px: Float64Array;
  readonly py: Float64Array;
  /** The grid axes: `z[i * GRID_SIZE + j]` is the value at `(x[i], y[j])`. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Flat indices `i * GRID_SIZE + j` of the cells inside the head circle, in order. */
  readonly inside: Int32Array;
  readonly head: Head;
  /** The interpolation matrix G, factorized. */
  readonly factors: LuFactors;
  /** Row-major `inside.length` by `interpolated.length`: g(d) from each inside cell to each
   *  interpolated sensor. */
  readonly evaluation: Float64Array;
}

export interface SensorFieldMap {
  readonly geometry: SensorFieldGeometry;
  /** `GRID_SIZE * GRID_SIZE` cells, `z[i * GRID_SIZE + j]` at `(x[i], y[j])`; NaN where masked. */
  readonly z: Float64Array;
  /** `m`, the mean of the interpolated (merged) values. */
  readonly mean: number;
  readonly limits: { readonly absmax: Pair; readonly minmax: Pair };
  readonly colorAxis: { readonly absmax: Pair; readonly minmax: Pair };
  /** Six interior levels, none for a constant map. */
  readonly contours: readonly number[];
  readonly notes: readonly SensorFieldNote[];
  /** The usable values' `max − min`, for the near-flat caption. */
  readonly valueRange: number;
}

export type SensorFieldRefusal = {
  readonly kind: "refused";
  readonly word: SensorFieldWord;
  readonly detail: string;
};

export type GeometryResult =
  | { readonly kind: "geometry"; readonly geometry: SensorFieldGeometry }
  | SensorFieldRefusal;

export type SensorFieldResult =
  | { readonly kind: "map"; readonly map: SensorFieldMap }
  | SensorFieldRefusal;

const refused = (word: SensorFieldWord, detail: string): SensorFieldRefusal => ({
  kind: "refused",
  word,
  detail,
});

/** Which rows are usable: value, theta and radius all finite. */
export function usableMask(
  thetaDeg: ArrayLike<number>,
  radius: ArrayLike<number>,
  values: ArrayLike<number>,
): Uint8Array {
  checkLengths(thetaDeg, radius, values.length);
  const usable = new Uint8Array(values.length);
  for (let row = 0; row < values.length; row++) {
    usable[row] =
      Number.isFinite(values[row]) && Number.isFinite(thetaDeg[row]) && Number.isFinite(radius[row])
        ? 1
        : 0;
  }
  return usable;
}

function checkLengths(thetaDeg: ArrayLike<number>, radius: ArrayLike<number>, rows: number): void {
  if (thetaDeg.length !== rows || radius.length !== rows) {
    throw new RangeError(
      `sensor field: ${thetaDeg.length} theta, ${radius.length} radius and ${rows} values; one of each per sensor`,
    );
  }
}

/** `GRID_SIZE` points, `i * ((high − low) / (GRID_SIZE − 1)) + low`, the last `high` itself. */
export function gridAxis(low: number, high: number): Float64Array {
  const step = (high - low) / (GRID_SIZE - 1);
  const axis = new Float64Array(GRID_SIZE);
  for (let i = 0; i < GRID_SIZE; i++) axis[i] = i * step + low;
  axis[GRID_SIZE - 1] = high;
  return axis;
}

/**
 * The biharmonic Green's function `d * d * (ln(d) − 1)` of a squared distance `r2 = d * d`, 0 where
 * d is 0. Written as `r2 * (ln(r2) / 2 − 1)` so the evaluation matrix needs no square root; the two
 * forms differ in the last bits, which the parity bound absorbs.
 */
export function green(r2: number): number {
  return r2 === 0 ? 0 : r2 * (0.5 * Math.log(r2) - 1);
}

/** `x[0] + ((x[0] − x[0]) + (x[1] − x[0]) + ... + (x[n−1] − x[0])) / n`: the mean, computed so equal
 *  values give themselves exactly and values near the binary64 limit do not overflow. */
export function center(values: ArrayLike<number>): number {
  const first = values[0];
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i] - first;
  return first + total / values.length + 0;
}

/**
 * Build the geometry of a map whose usable rows are `usable` (from `usableMask`): steps 1 to 7 of
 * the algorithm, the interpolation matrix factorized and the evaluation matrix filled. Refuses with
 * `too_few_sensors` or `head_outside_grid`, which depend on the layout alone.
 */
export function prepareSensorField(
  thetaDeg: ArrayLike<number>,
  radius: ArrayLike<number>,
  usable: Uint8Array,
): GeometryResult {
  const rows = usable.length;
  checkLengths(thetaDeg, radius, rows);
  const usableRows: number[] = [];
  for (let row = 0; row < rows; row++) {
    if (usable[row] === 1 && !(Number.isFinite(thetaDeg[row]) && Number.isFinite(radius[row]))) {
      throw new RangeError(`sensor field: row ${row} is marked usable without a finite place`);
    }
    if (usable[row] === 1) usableRows.push(row);
  }
  if (usableRows.length === 0) return refused("too_few_sensors", "no sensor is usable");

  // 2. Planar positions, in raw layout units: x to the nose, y to the right ear.
  const x = new Float64Array(rows);
  const y = new Float64Array(rows);
  for (const row of usableRows) {
    const t = thetaDeg[row] * DEG;
    x[row] = Math.cos(t) * radius[row];
    y[row] = Math.sin(t) * radius[row];
  }

  // 4. Merge: each usable row joins the first kept row within MERGE_DISTANCE, measured to kept
  // rows only, so merges do not chain.
  const kept: number[] = [];
  const members: number[][] = [];
  for (const row of usableRows) {
    let joined = false;
    for (let g = 0; g < kept.length; g++) {
      const dx = x[row] - x[kept[g]];
      const dy = y[row] - y[kept[g]];
      if (Math.sqrt(dx * dx + dy * dy) <= MERGE_DISTANCE) {
        members[g].push(row);
        joined = true;
        break;
      }
    }
    if (!joined) {
      kept.push(row);
      members.push([row]);
    }
  }

  // 3. Radii, from every usable row, merged or not.
  let outer = Number.NEGATIVE_INFINITY;
  for (const row of usableRows) if (radius[row] > outer) outer = radius[row];
  const plotrad = Math.max(Math.min(1, outer * RADIUS_MARGIN), HEAD_RADIUS);
  const intrad = Math.min(1, outer * RADIUS_MARGIN);
  const squeezefac = HEAD_RADIUS / plotrad;

  // 5. Plotted and interpolated sensors; no absolute value in the square, as in EEGLAB.
  const plotted = usableRows.filter((row) => radius[row] <= plotrad);
  const interpolated: number[] = [];
  const groups: number[][] = [];
  for (let g = 0; g < kept.length; g++) {
    const row = kept[g];
    if (x[row] <= intrad && y[row] <= intrad) {
      interpolated.push(row);
      groups.push(members[g]);
    }
  }
  const k = interpolated.length;
  if (k < MIN_SENSORS) {
    return refused("too_few_sensors", `${k} interpolated sensor(s); a map needs ${MIN_SENSORS}`);
  }

  // 6. Squeeze, and 7. the grid.
  const px = new Float64Array(k);
  const py = new Float64Array(k);
  let pxLow = Number.POSITIVE_INFINITY;
  let pxHigh = Number.NEGATIVE_INFINITY;
  let pyLow = Number.POSITIVE_INFINITY;
  let pyHigh = Number.NEGATIVE_INFINITY;
  for (let s = 0; s < k; s++) {
    px[s] = x[interpolated[s]] * squeezefac;
    py[s] = y[interpolated[s]] * squeezefac;
    pxLow = Math.min(pxLow, px[s]);
    pxHigh = Math.max(pxHigh, px[s]);
    pyLow = Math.min(pyLow, py[s]);
    pyHigh = Math.max(pyHigh, py[s]);
  }
  const gx = gridAxis(Math.min(-HEAD_RADIUS, pxLow), Math.max(HEAD_RADIUS, pxHigh));
  const gy = gridAxis(Math.min(-HEAD_RADIUS, pyLow), Math.max(HEAD_RADIUS, pyHigh));

  // 10 (the mask, needed here for the refusal of step 7): a cell is masked when
  // sqrt(x * x + y * y) > 0.5.
  const insideCells: number[] = [];
  for (let i = 0; i < GRID_SIZE; i++) {
    for (let j = 0; j < GRID_SIZE; j++) {
      if (!(Math.sqrt(gx[i] * gx[i] + gy[j] * gy[j]) > HEAD_RADIUS)) {
        insideCells.push(i * GRID_SIZE + j);
      }
    }
  }
  if (insideCells.length === 0) {
    return refused("head_outside_grid", "no grid cell lies inside the head circle");
  }
  const inside = Int32Array.from(insideCells);

  // 8. The interpolation matrix, G[a][b] = g(|p_a − p_b|) with g(0) = 0, factorized once.
  const matrix = new Float64Array(k * k);
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) {
      const dx = px[a] - px[b];
      const dy = py[a] - py[b];
      matrix[a * k + b] = a === b ? 0 : green(dx * dx + dy * dy);
    }
  }
  const factors = luFactor(matrix, k);

  // 9. The evaluation matrix: g from every inside cell to every interpolated sensor.
  const evaluation = new Float64Array(inside.length * k);
  for (let c = 0; c < inside.length; c++) {
    const cell = inside[c];
    const qx = gx[(cell / GRID_SIZE) | 0];
    const qy = gy[cell % GRID_SIZE];
    const base = c * k;
    for (let s = 0; s < k; s++) {
      const dx = qx - px[s];
      const dy = qy - py[s];
      evaluation[base + s] = green(dx * dx + dy * dy);
    }
  }

  return {
    kind: "geometry",
    geometry: {
      rows,
      thetaDeg: Float64Array.from(thetaDeg),
      radius: Float64Array.from(radius),
      usable: Uint8Array.from(usable),
      plotrad,
      intrad,
      squeezefac,
      plotted,
      interpolated,
      merged: kept.flatMap((_, g) => (members[g].length > 1 ? [members[g]] : [])),
      groups,
      px,
      py,
      x: gx,
      y: gy,
      inside,
      head: headOutline(squeezefac),
      factors,
      evaluation,
    },
  };
}

/** What a map needs before its cells: its mean, its notes and, unless near flat, its weights. */
interface MapPlan {
  readonly mean: number;
  readonly flat: boolean;
  readonly nearFlat: boolean;
  readonly valueRange: number;
  readonly weights: Float64Array | null;
}

function planMap(geometry: SensorFieldGeometry, values: ArrayLike<number>): MapPlan {
  // Flat and near flat are decided on every usable value (step 1), interpolated or not.
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let magnitude = 0;
  for (let row = 0; row < geometry.rows; row++) {
    if (geometry.usable[row] !== 1) continue;
    const value = values[row];
    if (value < low) low = value;
    if (value > high) high = value;
    const absolute = Math.abs(value);
    if (absolute > magnitude) magnitude = absolute;
  }
  const flat = low === high;
  const valueRange = high - low + 0;
  const nearFlat = !flat && 0 < valueRange && valueRange <= NEAR_FLAT * magnitude;

  // The interpolated values: a kept sensor's value is its group's mean (step 4).
  const k = geometry.interpolated.length;
  const merged = new Float64Array(k);
  for (let s = 0; s < k; s++) {
    const group = geometry.groups[s];
    // A group of one is its value: center([v]) is v + 0 / 1 + 0, written without the array.
    merged[s] = group.length === 1 ? values[group[0]] + 0 : center(group.map((row) => values[row]));
  }
  const mean = center(merged);
  if (nearFlat) return { mean, flat, nearFlat, valueRange, weights: null };

  // 8. Solve G w = v − m: the deviations, not the values.
  const deviations = new Float64Array(k);
  for (let s = 0; s < k; s++) deviations[s] = merged[s] - mean;
  return {
    mean,
    flat,
    nearFlat,
    valueRange,
    weights: luSolveFactored(geometry.factors, deviations),
  };
}

/** Fill each map's inside cells with `mean + E · w`, four maps and two cells per pass over E. */
function evaluateCells(
  geometry: SensorFieldGeometry,
  plans: readonly MapPlan[],
  grids: readonly Float64Array[],
): void {
  const { evaluation, inside } = geometry;
  const k = geometry.interpolated.length;
  const cells = inside.length;
  const solved: number[] = [];
  for (let p = 0; p < plans.length; p++) {
    if (plans[p].weights === null) {
      const grid = grids[p];
      const mean = plans[p].mean;
      for (let c = 0; c < cells; c++) grid[inside[c]] = mean;
    } else {
      solved.push(p);
    }
  }
  let q = 0;
  for (; q + 4 <= solved.length; q += 4) {
    const [a, b, c2, d] = [solved[q], solved[q + 1], solved[q + 2], solved[q + 3]];
    const w0 = plans[a].weights!;
    const w1 = plans[b].weights!;
    const w2 = plans[c2].weights!;
    const w3 = plans[d].weights!;
    const m0 = plans[a].mean;
    const m1 = plans[b].mean;
    const m2 = plans[c2].mean;
    const m3 = plans[d].mean;
    const z0 = grids[a];
    const z1 = grids[b];
    const z2 = grids[c2];
    const z3 = grids[d];
    evaluateFour(evaluation, inside, k, cells, w0, w1, w2, w3, m0, m1, m2, m3, z0, z1, z2, z3);
  }
  for (; q < solved.length; q++) {
    const p = solved[q];
    const w = plans[p].weights!;
    const mean = plans[p].mean;
    const grid = grids[p];
    for (let c = 0; c < cells; c++) {
      const base = c * k;
      let sum = 0;
      for (let s = 0; s < k; s++) sum += evaluation[base + s] * w[s];
      grid[inside[c]] = mean + sum;
    }
  }
}

/**
 * Four maps' inside cells, two cells per pass over E: each value of E and of w is loaded once for
 * eight sums. Each sum still runs over the sensors in order, so a map's cells are the one-map
 * loop's to the bit. A function of its own, called once per four maps, so the engine optimizes it
 * after the first calls of a page's first view instead of running the whole view in the
 * interpreter until the loop is replaced on the stack.
 */
function evaluateFour(
  evaluation: Float64Array,
  inside: Int32Array,
  k: number,
  cells: number,
  w0: Float64Array,
  w1: Float64Array,
  w2: Float64Array,
  w3: Float64Array,
  m0: number,
  m1: number,
  m2: number,
  m3: number,
  z0: Float64Array,
  z1: Float64Array,
  z2: Float64Array,
  z3: Float64Array,
): void {
  let c = 0;
  for (; c + 2 <= cells; c += 2) {
    const base = c * k;
    const next = base + k;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let t0 = 0;
    let t1 = 0;
    let t2 = 0;
    let t3 = 0;
    for (let s = 0; s < k; s++) {
      const e = evaluation[base + s];
      const f = evaluation[next + s];
      const v0 = w0[s];
      const v1 = w1[s];
      const v2 = w2[s];
      const v3 = w3[s];
      s0 += e * v0;
      s1 += e * v1;
      s2 += e * v2;
      s3 += e * v3;
      t0 += f * v0;
      t1 += f * v1;
      t2 += f * v2;
      t3 += f * v3;
    }
    const cell = inside[c];
    const after = inside[c + 1];
    z0[cell] = m0 + s0;
    z1[cell] = m1 + s1;
    z2[cell] = m2 + s2;
    z3[cell] = m3 + s3;
    z0[after] = m0 + t0;
    z1[after] = m1 + t1;
    z2[after] = m2 + t2;
    z3[after] = m3 + t3;
  }
  for (; c < cells; c++) {
    const base = c * k;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (let s = 0; s < k; s++) {
      const e = evaluation[base + s];
      s0 += e * w0[s];
      s1 += e * w1[s];
      s2 += e * w2[s];
      s3 += e * w3[s];
    }
    const cell = inside[c];
    z0[cell] = m0 + s0;
    z1[cell] = m1 + s1;
    z2[cell] = m2 + s2;
    z3[cell] = m3 + s3;
  }
}

/** The color axis around the limits `pair` under `rule` (step 11). */
export function colorAxisOf(pair: Pair, rule: LimitsRule): Pair {
  const [low, high] = pair;
  if (rule === "absmax") {
    const widen = (v: number): number => v + Math.sign(v) * COLOR_MARGIN * Math.abs(v) + 0;
    return [widen(low), widen(high)];
  }
  const span = high - low;
  return [low - COLOR_MARGIN * span + 0, high + COLOR_MARGIN * span + 0];
}

/** Steps 10 to 12 for a map whose inside cells are filled. */
function finishMap(
  geometry: SensorFieldGeometry,
  plan: MapPlan,
  z: Float64Array,
): SensorFieldResult {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const cell of geometry.inside) {
    const value = z[cell];
    if (!Number.isFinite(value)) return refused("interpolation_failed", "a cell is not finite");
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const top = Math.max(Math.abs(low), Math.abs(high));
  const limits = { absmax: [-top, top] as const, minmax: [low, high] as const };
  const contours: number[] = [];
  if (low < high) {
    const step = (high - low) / (CONTOUR_COUNT + 1);
    for (let level = 1; level <= CONTOUR_COUNT; level++) contours.push(level * step + low);
  }
  return {
    kind: "map",
    map: {
      geometry,
      z,
      mean: plan.mean,
      limits,
      colorAxis: {
        absmax: colorAxisOf(limits.absmax, "absmax"),
        minmax: colorAxisOf(limits.minmax, "minmax"),
      },
      contours,
      notes: plan.flat ? ["flat_field"] : plan.nearFlat ? ["near_flat"] : [],
      valueRange: plan.valueRange,
    },
  };
}

/**
 * Draw maps on one geometry. Each entry of `maps` is one value per input row whose usable rows are
 * exactly the geometry's (group maps by `usableMask` first); a map refused here is refused with
 * `interpolation_failed`.
 */
export function drawSensorFields(
  geometry: SensorFieldGeometry,
  maps: readonly ArrayLike<number>[],
): SensorFieldResult[] {
  for (const values of maps) {
    if (values.length !== geometry.rows) {
      throw new RangeError(
        `sensor field: a map of ${values.length} values for ${geometry.rows} sensors`,
      );
    }
    for (let row = 0; row < geometry.rows; row++) {
      const usable =
        Number.isFinite(values[row]) &&
        Number.isFinite(geometry.thetaDeg[row]) &&
        Number.isFinite(geometry.radius[row]);
      if ((usable ? 1 : 0) !== geometry.usable[row]) {
        throw new RangeError(
          `sensor field: row ${row}'s value does not match the geometry's usable rows`,
        );
      }
    }
  }
  const plans = maps.map((values) => planMap(geometry, values));
  const grids = maps.map(() => new Float64Array(GRID_SIZE * GRID_SIZE).fill(Number.NaN));
  evaluateCells(geometry, plans, grids);
  return plans.map((plan, p) => finishMap(geometry, plan, grids[p]));
}

/**
 * Draw `nemar.sensor-field.v1` for one value per sensor, in the layout's row order: theta in degrees
 * (0 at the nose, 90 at the right ear) and radius (0.5 at the equator). NaN marks a number that is
 * not finite.
 */
export function sensorField(
  thetaDeg: ArrayLike<number>,
  radius: ArrayLike<number>,
  values: ArrayLike<number>,
): SensorFieldResult {
  const prepared = prepareSensorField(thetaDeg, radius, usableMask(thetaDeg, radius, values));
  if (prepared.kind === "refused") return prepared;
  return drawSensorFields(prepared.geometry, [values])[0];
}
