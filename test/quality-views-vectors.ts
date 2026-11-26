/**
 * neuroschema's parity vectors for `nemar.sensor-field.v1` and `nemar.sensor-layout.v1`, read from
 * `test/fixtures/quality-views/vectors/` (copied by digest from nemar-cli, website ADR 0035), and
 * the comparisons their specifications define (neuroschema 0.6.0 `docs/views/sensor-field.md` and
 * `docs/views/sensor-layout.md`, "Parity"; the same rules as neuroschema's
 * `tests/test_views_reference.py`).
 *
 * The vectors are read from disk and parsed, not imported: `astro check` would otherwise infer a
 * type for several megabytes of JSON literal. The interfaces below say what is read of them.
 *
 * Not a `.test.ts` file: the parity tests, the performance test and the mutation script share it.
 */

import { parseMontage } from "../src/lib/quality-views/montages";
import {
  GRID_SIZE,
  type SensorFieldResult,
  sensorField,
} from "../src/lib/quality-views/sensor-field";
import {
  type LayoutBounds,
  type SensorLayoutResult,
  type Vec3,
  sensorLayout,
} from "../src/lib/quality-views/sensor-layout";
import { nodeFs, repoPath } from "./node";

/** A number the vectors write `null` because it is not finite. */
type Num = number | null;

export interface FieldSensors {
  readonly name: readonly string[];
  readonly theta_deg?: readonly Num[];
  readonly radius?: readonly Num[];
  readonly x?: readonly Num[];
  readonly y?: readonly Num[];
  readonly z?: readonly Num[];
  readonly value: readonly Num[];
}

export interface FieldExpected {
  readonly plotrad: number;
  readonly intrad: number;
  readonly squeezefac: number;
  readonly plotted: readonly number[];
  readonly interpolated: readonly number[];
  readonly merged: readonly (readonly number[])[];
  readonly x: readonly number[];
  readonly y: readonly number[];
  readonly z: readonly (readonly Num[])[];
  readonly limits: { readonly absmax: readonly number[]; readonly minmax: readonly number[] };
  readonly color_axis: { readonly absmax: readonly number[]; readonly minmax: readonly number[] };
  readonly contours: readonly number[];
  readonly head: {
    readonly radius: number;
    readonly nose: readonly (readonly number[])[];
    readonly right_ear: readonly (readonly number[])[];
    readonly left_ear: readonly (readonly number[])[];
  };
  readonly notes: readonly string[];
  readonly value_range: number;
  readonly layout?: LayoutExpected;
}

export interface FieldCase {
  readonly name: string;
  readonly description: string;
  readonly coordinate_system?: string;
  readonly montage?: string;
  readonly sensors: FieldSensors;
  readonly bounds?: VectorBounds;
  readonly expected?: FieldExpected;
  readonly refused?: string;
}

export interface FieldVectors {
  readonly format: string;
  readonly grid_size: number;
  readonly tolerance: {
    readonly cells_relative_to_range: number;
    readonly cells_relative_to_magnitude: number;
    readonly geometry_relative: number;
  };
  readonly cases: readonly FieldCase[];
}

export interface VectorBounds {
  readonly singular_ratio: Num;
  readonly radius_ratio: Num;
  readonly dilution: Num;
  readonly stability: Num;
  readonly coverage: Num;
  readonly gap: Num;
}

export interface LayoutExpected {
  readonly center: readonly number[];
  readonly center_method: "montage" | "sphere";
  readonly theta_deg: readonly Num[];
  readonly radius: readonly Num[];
}

export interface LayoutCase {
  readonly name: string;
  readonly description: string;
  readonly coordinate_system: string;
  readonly montage?: string;
  readonly positions: {
    readonly name: readonly string[];
    readonly x: readonly Num[];
    readonly y: readonly Num[];
    readonly z: readonly Num[];
    readonly sensor_type?: readonly (string | null)[];
  };
  readonly bounds?: VectorBounds;
  readonly expected?: LayoutExpected;
  readonly refused?: string;
}

export interface LayoutVectors {
  readonly format: string;
  readonly tolerance: {
    readonly planar: number;
    readonly radius: number;
    readonly center_relative_to_scale: number;
    readonly cart2topo_theta_deg: number;
    readonly bounds_absolute: number;
  };
  readonly frames: {
    readonly ALS: readonly string[];
    readonly RAS: readonly string[];
    readonly aliases: Readonly<Record<string, string>>;
  };
  readonly cart2topo: readonly {
    readonly point: readonly [number, number, number];
    readonly theta_deg: number;
    readonly radius: number;
  }[];
  readonly cases: readonly LayoutCase[];
}

const VECTORS = "test/fixtures/quality-views/vectors";

async function readVectors<T>(file: string): Promise<T> {
  const fs = await nodeFs();
  return JSON.parse(fs.readFileSync(repoPath(`${VECTORS}/${file}`), "utf8")) as T;
}

export const loadFieldVectors = (): Promise<FieldVectors> =>
  readVectors<FieldVectors>("sensor-field.v1.json");
export const loadLayoutVectors = (): Promise<LayoutVectors> =>
  readVectors<LayoutVectors>("sensor-layout.v1.json");

/** `null` (not finite) as NaN. */
export const numbers = (values: readonly Num[]): Float64Array =>
  Float64Array.from(values, (v) => (v === null ? Number.NaN : v));

/** `|a − b| <= rel * max(|a|, |b|)`, as neuroschema's `close`. */
export function close(a: number, b: number, rel: number): boolean {
  return Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));
}

/** Where the montages are copied (website ADR 0035 decision 2). */
export const MONTAGES_DIR = "src/lib/quality-views/vocabulary/montages";

/**
 * The center of every montage, right-anterior-superior meters, read from the montage files this
 * site copies by digest from nemar-cli (`views/montages`), never from a vector: the template cases'
 * expected centers are then checked against data the vectors do not supply.
 */
export async function montageCentersFromFiles(): Promise<Map<string, Vec3>> {
  const fs = await nodeFs();
  const centers = new Map<string, Vec3>();
  for (const file of fs.readdirSync(repoPath(MONTAGES_DIR))) {
    if (!file.endsWith(".json") || file === "PROVENANCE.json") continue;
    const name = file.slice(0, -".json".length);
    const montage = parseMontage(
      JSON.parse(fs.readFileSync(repoPath(`${MONTAGES_DIR}/${file}`), "utf8")),
      name,
    );
    centers.set(name, montage.center);
  }
  return centers;
}

/** Run one sensor-field case through this site's implementation: by theta and radius, or by
 *  positions projected with `nemar.sensor-layout.v1` first. */
export function runFieldCase(
  vectorCase: FieldCase,
  montageCenters: ReadonlyMap<string, Vec3>,
): { readonly layout: SensorLayoutResult | null; readonly field: SensorFieldResult | null } {
  const sensors = vectorCase.sensors;
  const values = numbers(sensors.value);
  if (sensors.x) {
    const layout = sensorLayout(
      { x: numbers(sensors.x), y: numbers(sensors.y!), z: numbers(sensors.z!) },
      vectorCase.coordinate_system!,
      {
        montage: vectorCase.montage ?? null,
        names: sensors.name,
        montageCenter: (name) => montageCenters.get(name),
      },
    );
    if (layout.kind === "refused") return { layout, field: null };
    return {
      layout,
      field: sensorField(layout.layout.thetaDeg, layout.layout.radius, values),
    };
  }
  return {
    layout: null,
    field: sensorField(numbers(sensors.theta_deg!), numbers(sensors.radius!), values),
  };
}

/**
 * A grid against a case's expected cells: whether the masks differ, the worst unmasked cell error,
 * and the bound `1e-6 * range + 1e-12 * magnitude` of the reference cells. Null when the vector's
 * grid is not 67 by 67.
 */
export function compareCells(
  vectors: FieldVectors,
  expected: FieldExpected,
  grid: ArrayLike<number>,
): { readonly maskDiffers: boolean; readonly worst: number; readonly bound: number } | null {
  const size = vectors.grid_size;
  if (
    size !== GRID_SIZE ||
    grid.length !== size * size ||
    expected.z.length !== size ||
    expected.z.some((row) => row.length !== size)
  ) {
    return null;
  }
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let magnitude = 0;
  for (const row of expected.z) {
    for (const cell of row) {
      if (cell === null) continue;
      low = Math.min(low, cell);
      high = Math.max(high, cell);
      magnitude = Math.max(magnitude, Math.abs(cell));
    }
  }
  const bound =
    vectors.tolerance.cells_relative_to_range * (high - low) +
    vectors.tolerance.cells_relative_to_magnitude * magnitude;
  let maskDiffers = false;
  let worst = 0;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const want = expected.z[i][j];
      const got = grid[i * size + j];
      if ((want === null) !== Number.isNaN(got)) {
        maskDiffers = true;
        continue;
      }
      if (want !== null) worst = Math.max(worst, Math.abs(got - want));
    }
  }
  return { maskDiffers, worst, bound };
}

/** The layout a case draws on: its own theta and radius, or its positions projected by
 *  `nemar.sensor-layout.v1`; null when the projection refuses. */
export function caseLayout(
  vectorCase: FieldCase,
  montageCenters: ReadonlyMap<string, Vec3>,
): { readonly thetaDeg: Float64Array; readonly radius: Float64Array } | null {
  const sensors = vectorCase.sensors;
  if (!sensors.x) {
    return { thetaDeg: numbers(sensors.theta_deg!), radius: numbers(sensors.radius!) };
  }
  const layout = sensorLayout(
    { x: numbers(sensors.x), y: numbers(sensors.y!), z: numbers(sensors.z!) },
    vectorCase.coordinate_system!,
    {
      montage: vectorCase.montage ?? null,
      names: sensors.name,
      montageCenter: (name) => montageCenters.get(name),
    },
  );
  return layout.kind === "layout"
    ? { thetaDeg: layout.layout.thetaDeg, radius: layout.layout.radius }
    : null;
}

/** How far one drawn case is from its vector: the worst cell error as a share of the bound, and
 *  every rule it misses (empty when it matches). */
export interface FieldComparison {
  readonly problems: string[];
  readonly maxCellError: number;
  readonly cellBound: number;
}

/** Compare a case with its vector by `sensor-field.md`'s parity rules. */
export function compareFieldCase(
  vectors: FieldVectors,
  vectorCase: FieldCase,
  montageCenters: ReadonlyMap<string, Vec3>,
  layoutVectors: LayoutVectors,
): FieldComparison {
  const { layout, field } = runFieldCase(vectorCase, montageCenters);
  const word =
    layout?.kind === "refused" ? layout.word : field?.kind === "refused" ? field.word : null;
  if (word !== null) {
    return {
      problems: vectorCase.refused === word ? [] : [`refused ${word}`],
      maxCellError: 0,
      cellBound: 0,
    };
  }
  if (vectorCase.refused !== undefined) {
    return {
      problems: [`drew a map; the vector refuses it (${vectorCase.refused})`],
      maxCellError: 0,
      cellBound: 0,
    };
  }
  const expected = vectorCase.expected!;
  const map = field!.kind === "map" ? field!.map : null;
  if (map === null) throw new Error("unreachable: a refusal was handled above");
  const problems: string[] = [];
  if (expected.layout && layout?.kind === "layout") {
    const positions = vectorCase.sensors;
    problems.push(
      ...compareLayout(
        layoutVectors,
        {
          name: vectorCase.name,
          description: vectorCase.description,
          coordinate_system: vectorCase.coordinate_system!,
          montage: vectorCase.montage,
          positions: { name: positions.name, x: positions.x!, y: positions.y!, z: positions.z! },
          bounds: vectorCase.bounds,
          expected: expected.layout,
        },
        layout,
      ).map((p) => `layout ${p}`),
    );
  }
  const tolerance = vectors.tolerance;
  const cells = compareCells(vectors, expected, map.z);
  if (cells === null) return { problems: ["grid size"], maxCellError: 0, cellBound: 0 };
  const { maskDiffers, worst, bound } = cells;
  if (maskDiffers) problems.push("mask");
  if (!(worst <= bound)) problems.push("cells");
  const geometry = tolerance.geometry_relative;
  const g = map.geometry;
  for (const [name, got, want] of [
    ["plotrad", g.plotrad, expected.plotrad],
    ["intrad", g.intrad, expected.intrad],
    ["squeezefac", g.squeezefac, expected.squeezefac],
    ["value range", map.valueRange, expected.value_range],
    ["head radius", g.head.radius, expected.head.radius],
  ] as const) {
    if (!close(got, want, geometry)) problems.push(name);
  }
  for (const [axis, got, want] of [
    ["x", g.x, expected.x],
    ["y", g.y, expected.y],
  ] as const) {
    if (got.length !== want.length || want.some((v, i) => !close(got[i], v, geometry))) {
      problems.push(`grid ${axis}`);
    }
  }
  for (const name of ["limits", "colorAxis"] as const) {
    const wanted = name === "limits" ? expected.limits : expected.color_axis;
    for (const rule of ["absmax", "minmax"] as const) {
      const got = map[name][rule];
      if (wanted[rule].some((v, i) => !(Math.abs(got[i] - v) <= bound))) {
        problems.push(`${name} ${rule}`);
      }
    }
  }
  if (
    map.contours.length !== expected.contours.length ||
    expected.contours.some((v, i) => !(Math.abs(map.contours[i] - v) <= bound))
  ) {
    problems.push("contours");
  }
  if (JSON.stringify(map.notes) !== JSON.stringify(expected.notes)) problems.push("notes");
  for (const [part, got, want] of [
    ["nose", g.head.nose, expected.head.nose],
    ["right_ear", g.head.rightEar, expected.head.right_ear],
    ["left_ear", g.head.leftEar, expected.head.left_ear],
  ] as const) {
    if (
      got.length !== want.length ||
      want.some((point, i) => point.some((v, a) => !close(got[i][a], v, geometry)))
    ) {
      problems.push(`head ${part}`);
    }
  }
  for (const [name, got, want] of [
    ["plotted", g.plotted, expected.plotted],
    ["interpolated", g.interpolated, expected.interpolated],
    ["merged", g.merged, expected.merged],
  ] as const) {
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(name);
  }
  return { problems, maxCellError: worst, cellBound: bound };
}

const BOUND_NAMES: readonly (readonly [keyof VectorBounds, keyof LayoutBounds])[] = [
  ["singular_ratio", "singularRatio"],
  ["radius_ratio", "radiusRatio"],
  ["dilution", "dilution"],
  ["stability", "stability"],
  ["coverage", "coverage"],
  ["gap", "gap"],
];

/** A measured case's six measures, within `tolerance.bounds_absolute`; a template case has none. */
export function compareBounds(
  vectors: LayoutVectors,
  vectorCase: { readonly bounds?: VectorBounds },
  got: LayoutBounds,
): string[] {
  if (vectorCase.bounds === undefined) {
    return Object.values(got).every((v) => v === null) ? [] : ["bounds"];
  }
  const problems: string[] = [];
  for (const [vectorName, ownName] of BOUND_NAMES) {
    const want = vectorCase.bounds[vectorName];
    const value = got[ownName];
    if (
      (want === null) !== (value === null) ||
      (want !== null &&
        value !== null &&
        !(Math.abs(value - want) <= vectors.tolerance.bounds_absolute))
    ) {
      problems.push(`bounds ${vectorName}`);
    }
  }
  return problems;
}

/** Compare a sensor-layout case with its vector by `sensor-layout.md`'s parity rules. */
export function compareLayout(
  vectors: LayoutVectors,
  vectorCase: LayoutCase,
  result: SensorLayoutResult,
  frame: string = vectorCase.coordinate_system,
): string[] {
  if (result.kind === "refused") {
    if (vectorCase.refused !== result.word) return [`refused ${result.word}`];
    return compareBounds(vectors, vectorCase, result.bounds);
  }
  if (vectorCase.refused !== undefined) {
    return [`gave a layout; the vector refuses it (${vectorCase.refused})`];
  }
  const expected = vectorCase.expected!;
  const layout = result.layout;
  const problems = compareBounds(vectors, vectorCase, layout.bounds);
  const wantRadius = numbers(expected.radius);
  const wantTheta = numbers(expected.theta_deg);
  if (wantRadius.some((v, i) => Number.isNaN(v) !== Number.isNaN(layout.radius[i]))) {
    return [...problems, "rows without a position"];
  }
  if (layout.centerMethod !== expected.center_method) problems.push("center method");

  // The scale s of step 3, over every row with finite numbers, in ALS (the reference's own rule).
  const p = vectorCase.positions;
  const ras = !vectors.frames.ALS.includes(vectors.frames.aliases[frame] ?? frame);
  const finite: Vec3[] = [];
  for (let i = 0; i < p.name.length; i++) {
    const x = p.x[i];
    const y = p.y[i];
    const z = p.z[i];
    if (x === null || y === null || z === null) continue;
    finite.push(ras ? [y, -x, z] : [x, y, z]);
  }
  const centroid = [0, 1, 2].map((a) => finite.reduce((s, q) => s + q[a], 0) / finite.length);
  const scale = Math.max(
    ...finite.map((q) => Math.hypot(q[0] - centroid[0], q[1] - centroid[1], q[2] - centroid[2])),
  );
  const centerBound = vectors.tolerance.center_relative_to_scale * scale;
  if (expected.center.some((v, a) => !(Math.abs(layout.center[a] - v) <= centerBound))) {
    problems.push("center");
  }
  let radiusOff = false;
  let planarOff = false;
  for (let i = 0; i < wantRadius.length; i++) {
    if (Number.isNaN(wantRadius[i])) continue;
    if (!(Math.abs(layout.radius[i] - wantRadius[i]) <= vectors.tolerance.radius)) radiusOff = true;
    const got = (layout.thetaDeg[i] * Math.PI) / 180;
    const want = (wantTheta[i] * Math.PI) / 180;
    const gap = Math.hypot(
      Math.cos(got) * layout.radius[i] - Math.cos(want) * wantRadius[i],
      Math.sin(got) * layout.radius[i] - Math.sin(want) * wantRadius[i],
    );
    if (!(gap <= vectors.tolerance.planar)) planarOff = true;
  }
  if (radiusOff) problems.push("radius");
  if (planarOff) problems.push("planar");
  return problems;
}

/** Each map's word and notes by the site's `nemar.sensor-field.v1`, as the model vectors hold them. */
export function mapOutcome(thetaDeg: number[], radius: number[], values: number[]) {
  const result = sensorField(thetaDeg, radius, values);
  return result.kind === "refused"
    ? { word: result.word, notes: [] }
    : { word: null, notes: [...result.map.notes] };
}
