/**
 * `nemar.sensor-layout.v1`: three-dimensional sensor positions to the layout `nemar.sensor-field.v1`
 * draws, one topoplot theta and radius per row (nemar-cli ADR 0137 decision 3 and its amendment of
 * 2026-11-24; website ADR 0035 decision 5).
 *
 * neuroschema 0.6.0's `docs/views/sensor-layout.md` is normative and
 * `src/neuroschema/views/sensor_layout.py` the Python reference; this module follows both step for
 * step, and `test/quality-views-sensor-layout-parity.test.ts` holds it to every case of
 * `views/vectors/sensor-layout.v1.json`. In short:
 *
 * 1. The positions are rotated into the anterior-left-superior (ALS) frame from the frame their
 *    Brain Imaging Data Structure (BIDS) coordinate system names, compared exactly; template
 *    positions name a montage instead, with the coordinate system `n/a`. Anything else is refused
 *    (`frame_unknown`): no frame is ever assumed.
 * 2. Only scalp rows with a position are laid out: rows typed EEG when any row is typed, otherwise
 *    every row but those named as another signal; never a fiducial, nor a row at (0, 0, 0).
 * 3. Template positions are centered on their montage's own center. Measured positions are centered
 *    on an algebraic least-squares sphere through the scalp rows, and refused when too flat
 *    (`positions_flat`) or covering too little of the head (`positions_partial`) to fix one.
 * 4. Each centered position becomes EEGLAB's theta and radius, as eegprep's
 *    `convertlocs(..., 'cart2topo')` gives them, with theta in (-180, 180].
 *
 * The montage centers are data of `views/montages`, which this site copies with the montages
 * themselves; the caller passes them in (`montageCenter`), so this module reads no file.
 */

import { type LuFactors, luFactor, luSolveFactored } from "./linalg";
import { FIDUCIALS, MONTAGE_NAMES, clean, excludedByName, finish, typeClass } from "./sensor-names";

export const SENSOR_LAYOUT = "nemar.sensor-layout.v1";

/** BIDS coordinate systems with ALS orientation (x anterior, y left, z superior). */
export const ALS_FRAMES: ReadonlySet<string> = new Set([
  "CTF",
  "4DBti",
  "KitYokogawa",
  "EEGLAB",
  "EEGLAB-HJ",
]);

/** BIDS coordinate systems with RAS orientation (x right, y anterior, z superior), spelled as the
 *  BIDS schema's enumerations spell them (bids-specification 147b46d7). */
export const RAS_FRAMES: ReadonlySet<string> = new Set([
  "NeuromagElektaMEGIN",
  "ElektaNeuromag",
  "ChietiItab",
  "CapTrak",
  "ACPC",
  "ScanRAS",
  "ICBM452AirSpace",
  "ICBM452Warp5Space",
  "IXI549Space",
  "fsaverage",
  "fsaverageSym",
  "fsLR",
  "MNIColin27",
  "MNI152Lin",
  "MNI152NLin2009aSym",
  "MNI152NLin2009bSym",
  "MNI152NLin2009cSym",
  "MNI152NLin2009aAsym",
  "MNI152NLin2009bAsym",
  "MNI152NLin2009cAsym",
  "MNI152NLin6Sym",
  "MNI152NLin6Asym",
  "MNI305",
  "NIHPD",
  "OASIS30AntsOASISAnts",
  "OASIS30Atropos",
  "Talairach",
  "UNCInfant",
  "fsaverage3",
  "fsaverage4",
  "fsaverage5",
  "fsaverage6",
  "fsaveragesym",
  ...["0", "1", "2"].flatMap((age) => [21, 22, 23].map((v) => `UNCInfant${age}V${v}`)),
]);

/** Other spellings BIDS uses for a frame, each read as the schema's spelling. */
export const FRAME_ALIASES: Readonly<Record<string, string>> = {
  MNI152NLin6ASym: "MNI152NLin6Asym",
};

/** Flatness bound 1: the smallest singular value below this share of the largest is flat. */
export const FLAT_RATIO = 0.05;
/** Flatness bound 2: a fitted sphere's radius above this many times the positions' scale. */
export const RADIUS_RATIO = 3;
/** The coverage bound: the dilution of the fitted center above this is partial. */
export const PARTIAL_DILUTION = 4.5;
/** The stability bound: leaving one position out moves the center by more than this share of the
 *  radius. */
export const PARTIAL_SHIFT = 0.12;
/** The whole-head bound: some quadrant's lowest position is more than this many degrees above the
 *  equator (or below it). */
export const COVERAGE_ELEVATION = 38;
/** The whole-head bound: two neighbors in azimuth more than this many degrees apart. */
export const GAP_AZIMUTH = 120;
/** Radians to degrees: 180 divided by the binary64 nearest pi (57.29577951308232). */
export const RAD = 180 / Math.PI;

export type Vec3 = readonly [number, number, number];
export type SensorLayoutWord = "frame_unknown" | "positions_flat" | "positions_partial";

/** The six measures step 3 bounds, for measured positions; each null where it was not reached,
 *  and all null for template positions. */
export interface LayoutBounds {
  readonly singularRatio: number | null;
  readonly radiusRatio: number | null;
  readonly dilution: number | null;
  readonly stability: number | null;
  readonly coverage: number | null;
  readonly gap: number | null;
}

export interface SensorLayout {
  /** One per input row: theta in degrees, NaN for a row with no layout. */
  readonly thetaDeg: Float64Array;
  /** One per input row: the radius, NaN for a row with no layout. */
  readonly radius: Float64Array;
  /** The ALS point the positions were centered on. */
  readonly center: Vec3;
  /** `montage` for template positions, `sphere` for measured ones. */
  readonly centerMethod: "montage" | "sphere";
  readonly bounds: LayoutBounds;
}

export type SensorLayoutResult =
  | { readonly kind: "layout"; readonly layout: SensorLayout }
  | {
      readonly kind: "refused";
      readonly word: SensorLayoutWord;
      readonly detail: string;
      readonly bounds: LayoutBounds;
    };

/** Positions as three columns, one entry per row, in the frame's unit (any unit); NaN where a
 *  number is not finite. */
export interface Positions {
  readonly x: ArrayLike<number>;
  readonly y: ArrayLike<number>;
  readonly z: ArrayLike<number>;
}

export interface SensorLayoutOptions {
  /** For template positions: the montage they came from, with the coordinate system `n/a`. */
  readonly montage?: string | null;
  /** The role's `name` column, one per row. */
  readonly names?: readonly string[] | null;
  /** The role's `sensor_type` column, one per row, when the file has one. */
  readonly sensorTypes?: readonly (string | null)[] | null;
  /** A montage's own center, right-anterior-superior meters, as its `views/montages` file stores
   *  it. Needed only for template positions. */
  readonly montageCenter?: (montage: string) => Vec3 | undefined;
}

/**
 * The caller gave no center for a montage `orientation` accepted: the site has not loaded
 * `views/montages`, which is the site's fault, not the positions'. It is thrown, not returned as a
 * word, because no word of the specification says it; a renderer catches it by this type and leaves
 * the map undrawn with its own sentence, so it never ends a view.
 */
export class MontageCenterUnavailable extends Error {
  constructor(readonly montage: string) {
    super(
      `sensor layout: no center was given for the montage ${JSON.stringify(montage)}; load views/montages first`,
    );
    this.name = "MontageCenterUnavailable";
  }
}

const NO_BOUNDS: LayoutBounds = {
  singularRatio: null,
  radiusRatio: null,
  dilution: null,
  stability: null,
  coverage: null,
  gap: null,
};

class Refusal {
  constructor(
    readonly word: SensorLayoutWord,
    readonly detail: string,
    readonly bounds: LayoutBounds = NO_BOUNDS,
  ) {}
}

/** `ALS` or `RAS` for positions in `coordinateSystem` (or from `montage`), or the refusal. */
export function orientation(
  coordinateSystem: string,
  montage: string | null = null,
): "ALS" | "RAS" | { readonly word: "frame_unknown"; readonly detail: string } {
  if (montage === null) {
    const frame = FRAME_ALIASES[coordinateSystem] ?? coordinateSystem;
    if (ALS_FRAMES.has(frame)) return "ALS";
    if (RAS_FRAMES.has(frame)) return "RAS";
    return {
      word: "frame_unknown",
      detail: `${JSON.stringify(coordinateSystem)} is not a BIDS coordinate system of known orientation`,
    };
  }
  if (coordinateSystem !== "n/a") {
    return {
      word: "frame_unknown",
      detail: `template positions from montage ${JSON.stringify(montage)} name the coordinate system ${JSON.stringify(coordinateSystem)}, not n/a`,
    };
  }
  if (MONTAGE_NAMES.includes(montage)) return "RAS";
  return {
    word: "frame_unknown",
    detail: `${JSON.stringify(montage)} is not a montage of nemar.sensor-labels.v1`,
  };
}

/** A point rotated into ALS: kept for ALS, `(x, y, z) -> (y, -x, z)` for RAS. */
function toAls(point: Vec3, frame: "ALS" | "RAS"): Vec3 {
  return frame === "ALS" ? point : [point[1], -point[0], point[2]];
}

/** Which rows are scalp rows: typed EEG when any row is typed, otherwise not named as another
 *  signal; never a fiducial. */
export function scalpRows(
  count: number,
  names: readonly string[] | null,
  sensorTypes: readonly (string | null)[] | null,
): boolean[] {
  const keep = new Array<boolean>(count).fill(true);
  const classes = sensorTypes && sensorTypes.length > 0 ? sensorTypes.map(typeClass) : [];
  if (classes.some((kind) => kind !== "untyped")) {
    for (let row = 0; row < count; row++) keep[row] = classes[row] === "eeg";
  } else if (names) {
    for (let row = 0; row < count; row++) keep[row] = !excludedByName(clean(names[row]));
  }
  if (names) {
    for (let row = 0; row < count; row++) {
      if (FIDUCIALS.has(finish(clean(names[row])))) keep[row] = false;
    }
  }
  return keep;
}

/** A row with a position: x, y and z finite, and not all three exactly zero. */
function hasPosition(point: Vec3): boolean {
  return (
    point.every((v) => Number.isFinite(v)) && !(point[0] === 0 && point[1] === 0 && point[2] === 0)
  );
}

/** The eigenvalues of a symmetric 3-by-3 matrix, ascending, by cyclic Jacobi rotations. */
export function symmetricEigenvalues3(matrix: ArrayLike<number>): [number, number, number] {
  const a = [
    [matrix[0], matrix[1], matrix[2]],
    [matrix[3], matrix[4], matrix[5]],
    [matrix[6], matrix[7], matrix[8]],
  ];
  const pairs: readonly (readonly [number, number])[] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  for (let sweep = 0; sweep < 100; sweep++) {
    if (a[0][1] === 0 && a[0][2] === 0 && a[1][2] === 0) break;
    for (const [p, q] of pairs) {
      const apq = a[p][q];
      if (apq === 0) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      const r = 3 - p - q;
      const arp = a[r][p];
      const arq = a[r][q];
      a[p][p] -= t * apq;
      a[q][q] += t * apq;
      a[p][q] = 0;
      a[q][p] = 0;
      a[r][p] = c * arp - s * arq;
      a[p][r] = a[r][p];
      a[r][q] = s * arp + c * arq;
      a[q][r] = a[r][q];
    }
  }
  const values = [a[0][0], a[1][1], a[2][2]].sort((u, v) => u - v);
  return [values[0], values[1], values[2]];
}

/** Rows of `count` columns, row-major: the product `Aᵀ A` of an n-by-count matrix. */
function gram(rows: readonly (readonly number[])[], count: number): Float64Array {
  const out = new Float64Array(count * count);
  for (let p = 0; p < count; p++) {
    for (let q = 0; q < count; q++) {
      let sum = 0;
      for (const row of rows) sum += row[p] * row[q];
      out[p * count + q] = sum;
    }
  }
  return out;
}

/** The dilution of a fitted center, from the unit vectors to the positions. */
export function dilution(spokes: readonly Vec3[]): number {
  const n = spokes.length;
  const moments = gram(
    spokes.map((e) => [e[0], e[1], e[2], 1]),
    4,
  ).map((v) => v / n);
  const factors = luFactor(moments, 4);
  let total = 0;
  for (let k = 0; k < 3; k++) {
    const unit = [0, 0, 0, 0];
    unit[k] = 1;
    total += luSolveFactored(factors, unit)[k];
  }
  return Math.sqrt(total);
}

/** The largest move of the fitted center, as a share of `radius`, when one position is left out. */
function stability(
  design: readonly (readonly number[])[],
  target: readonly number[],
  solution: Float64Array,
  radius: number,
): number {
  const normal = gram(design, 4);
  const right = [0, 0, 0, 0];
  for (let p = 0; p < 4; p++) {
    let sum = 0;
    for (let i = 0; i < design.length; i++) sum += design[i][p] * target[i];
    right[p] = sum;
  }
  let largest = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < design.length; k++) {
    const row = design[k];
    const reduced = new Float64Array(16);
    for (let p = 0; p < 4; p++) {
      for (let q = 0; q < 4; q++) reduced[p * 4 + q] = normal[p * 4 + q] - row[p] * row[q];
    }
    const rhs = right.map((v, p) => v - row[p] * target[k]);
    const leftOut = luSolveFactored(luFactor(reduced, 4), rhs);
    let squares = 0;
    for (let p = 0; p < 3; p++) {
      const d = leftOut[p] - solution[p];
      squares += d * d;
    }
    const move = Math.sqrt(squares) / radius;
    if (Number.isNaN(move)) return Number.NaN;
    if (move > largest) largest = move;
  }
  return largest;
}

/** 0 front, 1 left, 2 back, 3 right, or -1 for a vector on the vertical axis (ALS). */
function quadrant(spoke: Vec3): number {
  const [x, y] = spoke;
  if (x > Math.abs(y)) return 0;
  if (-x > Math.abs(y)) return 2;
  if (y >= Math.abs(x) && y > 0) return 1;
  if (-y >= Math.abs(x) && y < 0) return 3;
  return -1;
}

/** How low the positions reach on every side of the head, in degrees. */
export function coverage(spokes: readonly Vec3[]): number {
  const lowest = [90, 90, 90, 90];
  const seen = [false, false, false, false];
  for (const spoke of spokes) {
    const side = quadrant(spoke);
    if (side < 0) continue;
    const elevation = Math.atan2(spoke[2], Math.hypot(spoke[0], spoke[1])) * RAD;
    if (!seen[side] || elevation < lowest[side]) lowest[side] = elevation;
    seen[side] = true;
  }
  return Math.max(...lowest);
}

/** The widest azimuth between neighboring positions about the vertical axis, in degrees. */
export function azimuthGap(spokes: readonly Vec3[]): number {
  const azimuths = spokes
    .filter((s) => Math.hypot(s[0], s[1]) > 0)
    .map((s) => Math.atan2(s[1], s[0]) * RAD)
    .sort((u, v) => u - v);
  if (azimuths.length < 2) return 360;
  let widest = 360 - (azimuths[azimuths.length - 1] - azimuths[0]);
  for (let i = 1; i < azimuths.length; i++) {
    widest = Math.max(widest, azimuths[i] - azimuths[i - 1]);
  }
  return widest;
}

interface Fit {
  readonly center: Vec3;
  readonly bounds: LayoutBounds;
}

/** The center of measured ALS positions: step 3's sphere and its six bounds. */
function sphereCenter(points: readonly Vec3[]): Fit {
  const n = points.length;
  const centroid = [0, 0, 0];
  for (const p of points) for (let a = 0; a < 3; a++) centroid[a] += p[a];
  for (let a = 0; a < 3; a++) centroid[a] /= Math.max(n, 1);
  const centered = points.map((p) => [p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]]);
  let scale = 0;
  for (const q of centered)
    scale = Math.max(scale, Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]));
  if (scale === 0) throw new Refusal("positions_flat", "the positions coincide, or there are none");
  const u = centered.map((q) => [q[0] / scale, q[1] / scale, q[2] / scale] as const);

  const eigen = symmetricEigenvalues3(gram(u, 3)).map((v) => Math.max(v, 0));
  const singularRatio = Math.sqrt(eigen[0] / eigen[2]);
  if (!(singularRatio >= FLAT_RATIO)) {
    throw new Refusal(
      "positions_flat",
      `the positions are flat: their singular ratio ${singularRatio.toPrecision(3)} is below ${FLAT_RATIO}`,
      { ...NO_BOUNDS, singularRatio },
    );
  }

  const design = u.map((p) => [2 * p[0], 2 * p[1], 2 * p[2], 1]);
  const target = u.map((p) => p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
  const rhs = [0, 0, 0, 0];
  for (let p = 0; p < 4; p++) {
    for (let i = 0; i < n; i++) rhs[p] += design[i][p] * target[i];
  }
  const factors: LuFactors = luFactor(gram(design, 4), 4);
  const solution = luSolveFactored(factors, rhs);
  const [a, b, c, d] = solution;
  const radiusRatio = Math.sqrt(a * a + b * b + c * c + d);
  if (!(radiusRatio <= RADIUS_RATIO)) {
    throw new Refusal(
      "positions_flat",
      `the positions are too flat: their sphere's radius is ${radiusRatio.toPrecision(3)} times their scale, above ${RADIUS_RATIO}`,
      { ...NO_BOUNDS, singularRatio, radiusRatio },
    );
  }

  const spokes = u.map((p): Vec3 => {
    const e = [p[0] - a, p[1] - b, p[2] - c];
    const length = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
    return [e[0] / length, e[1] / length, e[2] / length];
  });
  const spread = dilution(spokes);
  if (!(spread <= PARTIAL_DILUTION)) {
    throw new Refusal(
      "positions_partial",
      `the positions cover too little of the head: the dilution of their center is ${spread.toPrecision(3)}, above ${PARTIAL_DILUTION}`,
      { ...NO_BOUNDS, singularRatio, radiusRatio, dilution: spread },
    );
  }
  const shift = stability(design, target, solution, radiusRatio);
  if (!(shift <= PARTIAL_SHIFT)) {
    throw new Refusal(
      "positions_partial",
      `the positions do not fix the head's center: leaving one out moves it ${shift.toPrecision(3)} of the radius, above ${PARTIAL_SHIFT}`,
      { ...NO_BOUNDS, singularRatio, radiusRatio, dilution: spread, stability: shift },
    );
  }
  const reach = coverage(spokes);
  if (!(reach <= COVERAGE_ELEVATION)) {
    throw new Refusal(
      "positions_partial",
      `the positions do not cover the whole head: some quadrant's lowest position is ${reach.toPrecision(3)} degrees above the equator, above ${COVERAGE_ELEVATION}`,
      {
        singularRatio,
        radiusRatio,
        dilution: spread,
        stability: shift,
        coverage: reach,
        gap: null,
      },
    );
  }
  const widest = azimuthGap(spokes);
  const bounds = {
    singularRatio,
    radiusRatio,
    dilution: spread,
    stability: shift,
    coverage: reach,
    gap: widest,
  };
  if (!(widest <= GAP_AZIMUTH)) {
    throw new Refusal(
      "positions_partial",
      `the positions do not go around the head: two neighbors are ${widest.toPrecision(3)} degrees apart in azimuth, above ${GAP_AZIMUTH}`,
      bounds,
    );
  }
  return {
    center: [centroid[0] + scale * a, centroid[1] + scale * b, centroid[2] + scale * c],
    bounds,
  };
}

/** A centered ALS point to topoplot theta (degrees, in (-180, 180]) and radius. */
export function cart2topo(point: Vec3): { readonly thetaDeg: number; readonly radius: number } {
  const [x, y, z] = point;
  let thetaDeg = -(Math.atan2(y, x) * RAD);
  if (thetaDeg <= -180) thetaDeg += 360;
  const radius = 0.5 - (Math.atan2(z, Math.hypot(x, y)) * RAD) / 180;
  return { thetaDeg, radius };
}

/**
 * Apply `nemar.sensor-layout.v1` to positions in the BIDS frame `coordinateSystem` names (or, for
 * template positions, `n/a` with `options.montage`). Rows that are not scalp rows, and rows without
 * a position, get no layout (NaN).
 */
export function sensorLayout(
  positions: Positions,
  coordinateSystem: string,
  options: SensorLayoutOptions = {},
): SensorLayoutResult {
  const count = positions.x.length;
  if (positions.y.length !== count || positions.z.length !== count) {
    throw new RangeError("sensor layout: x, y and z need one entry per row");
  }
  const names = options.names ?? null;
  const sensorTypes = options.sensorTypes ?? null;
  for (const [column, values] of [
    ["names", names],
    ["sensorTypes", sensorTypes],
  ] as const) {
    if (values !== null && values.length !== count) {
      throw new RangeError(
        `sensor layout: ${column} has ${values.length} entries for ${count} rows`,
      );
    }
  }
  const montage = options.montage ?? null;
  const frame = orientation(coordinateSystem, montage);
  if (typeof frame !== "string") {
    return { kind: "refused", word: frame.word, detail: frame.detail, bounds: NO_BOUNDS };
  }
  const als: Vec3[] = [];
  for (let row = 0; row < count; row++) {
    als.push(toAls([positions.x[row], positions.y[row], positions.z[row]], frame));
  }
  const scalp = scalpRows(count, names, sensorTypes);
  const rows: number[] = [];
  for (let row = 0; row < count; row++) if (scalp[row] && hasPosition(als[row])) rows.push(row);

  let center: Vec3;
  let centerMethod: "montage" | "sphere";
  let bounds: LayoutBounds = NO_BOUNDS;
  if (montage !== null) {
    const stored = options.montageCenter?.(montage);
    if (!stored) throw new MontageCenterUnavailable(montage);
    center = toAls(stored, frame);
    centerMethod = "montage";
  } else {
    try {
      const fit = sphereCenter(rows.map((row) => als[row]));
      center = fit.center;
      bounds = fit.bounds;
    } catch (error) {
      if (error instanceof Refusal) {
        return { kind: "refused", word: error.word, detail: error.detail, bounds: error.bounds };
      }
      throw error;
    }
    centerMethod = "sphere";
  }

  const thetaDeg = new Float64Array(count).fill(Number.NaN);
  const radius = new Float64Array(count).fill(Number.NaN);
  for (const row of rows) {
    const p = als[row];
    const topo = cart2topo([p[0] - center[0], p[1] - center[1], p[2] - center[2]]);
    thetaDeg[row] = topo.thetaDeg;
    radius[row] = topo.radius;
  }
  return { kind: "layout", layout: { thetaDeg, radius, center, centerMethod, bounds } };
}
