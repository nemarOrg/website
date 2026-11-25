/**
 * What a page and the sensor-field worker say to each other (website ADR 0035 decision 1).
 *
 * **This file imports nothing at runtime** (type imports are erased): the page imports it through
 * `worker-client.ts`, and the client must stay a few kilobytes, with the interpolation only in the
 * worker's own bundle. The worker imports it too, so what one sends and the other reads is one
 * declaration.
 *
 * A page asks for the maps of one view: one layout (theta and radius per sensor, and the SHA-256
 * of the layout file it came from, which keys the worker's cache) and one value per sensor per map.
 * The worker answers in batches, the maps the page shows first, then the rest in larger batches,
 * and ends with `done`; a page that no longer needs the maps sends `cancel`.
 *
 * Each drawn map carries its grid as the `Float64Array` the algorithm computed (67 by 67, NaN where
 * masked), transferred, not copied: a narrower type would round a near-flat map's cells onto one
 * value and break parity. A map's geometry (radii, grid axes, sensors, head) is sent once per draw,
 * in the batch that first needs it, and each map names it by number.
 */

import type { SensorFieldNote, SensorFieldWord } from "./sensor-field";

/** The grid's points per axis (`nemar.sensor-field.v1` step 7), repeated here so this file needs no
 *  runtime import; `test/quality-views-worker.test.ts` checks it against the algorithm's. */
export const GRID_CELLS = 67 * 67;

/** Every word a map can be refused with. */
export const SENSOR_FIELD_WORDS = [
  "too_few_sensors",
  "head_outside_grid",
  "interpolation_failed",
] as const satisfies readonly SensorFieldWord[];

/** Every note a drawn map can carry. */
export const SENSOR_FIELD_NOTES = [
  "flat_field",
  "near_flat",
] as const satisfies readonly SensorFieldNote[];

// Compile-time completeness: a word or note the algorithm gains fails the typecheck here.
type Missing<All, Listed> = Exclude<All, Listed> extends never ? true : never;
const wordsComplete: Missing<SensorFieldWord, (typeof SENSOR_FIELD_WORDS)[number]> = true;
const notesComplete: Missing<SensorFieldNote, (typeof SENSOR_FIELD_NOTES)[number]> = true;
void wordsComplete;
void notesComplete;

export interface DrawRequest {
  readonly type: "draw";
  /** The page's number for this request; every answer names it. */
  readonly id: number;
  /** The SHA-256 of the layout file the theta and radius came from: the worker's cache key. */
  readonly layoutKey: string;
  readonly thetaDeg: Float64Array;
  readonly radius: Float64Array;
  /** One value per sensor per map, map after map: map m's sensor s is `values[m * sensors + s]`. */
  readonly values: Float64Array;
  readonly mapCount: number;
  /** The maps to draw first (those on screen), in order; the rest follow in index order. */
  readonly first: readonly number[];
  /** Maps per batch while the maps in `first` are drawn. */
  readonly batchSize: number;
  /** Maps per batch after them: larger, so fewer messages carry the rest. */
  readonly laterBatchSize: number;
  /** The maps whose contour lines the worker traces (usually those on screen); the page traces any
   *  other map's lines itself when it shows it (`contoursOf` in `worker-client.ts`). */
  readonly contours: readonly number[];
}

export interface CancelRequest {
  readonly type: "cancel";
  readonly id: number;
}

export type WorkerRequest = DrawRequest | CancelRequest;

/** Everything about a map that its layout and usable sensors decide, shared by maps alike. */
export interface MapGeometryMessage {
  readonly plotrad: number;
  readonly intrad: number;
  readonly squeezefac: number;
  /** The grid axes: cell `i * 67 + j` is at `(x[i], y[j])`, x to the nose, y to the right ear. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Input rows that get a marker. */
  readonly plotted: readonly number[];
  readonly interpolated: readonly number[];
  /** Each merge group, its kept row first. */
  readonly merged: readonly (readonly number[])[];
  readonly head: {
    readonly radius: number;
    readonly nose: readonly (readonly [number, number])[];
    readonly rightEar: readonly (readonly [number, number])[];
    readonly leftEar: readonly (readonly [number, number])[];
  };
}

/** A drawn map with its geometry named by number; `worker-client.ts` puts the geometry in its place. */
export interface DrawnMapMessage {
  readonly kind: "map";
  readonly index: number;
  /** 67 by 67, `grid[i * 67 + j]` at `(x[i], y[j])`; NaN where masked. */
  readonly grid: Float64Array;
  readonly mean: number;
  readonly limits: {
    readonly absmax: readonly [number, number];
    readonly minmax: readonly [number, number];
  };
  readonly colorAxis: {
    readonly absmax: readonly [number, number];
    readonly minmax: readonly [number, number];
  };
  readonly contourLevels: readonly number[];
  /** One segment list per level (`x0, y0, x1, y1` each), or null when this map's lines were not
   *  asked for. */
  readonly contourLines: readonly Float32Array[] | null;
  readonly notes: readonly SensorFieldNote[];
  readonly valueRange: number;
  /** The number of this map's geometry among the draw's `geometries`. */
  readonly geometry: number;
}

export interface RefusedMapMessage {
  readonly kind: "refused";
  readonly index: number;
  readonly word: SensorFieldWord;
  readonly detail: string;
}

export type MapMessage = DrawnMapMessage | RefusedMapMessage;

/** A geometry first needed in this batch, with the number later maps name it by. */
export interface GeometryEntry {
  readonly key: number;
  readonly geometry: MapGeometryMessage;
}

export interface DrawStats {
  readonly mapCount: number;
  /** Milliseconds spent building geometries this request did not find in the cache. */
  readonly geometryMs: number;
  /** Milliseconds spent drawing maps on their geometries, contours included. */
  readonly mapsMs: number;
  /** From the request's arrival to the last batch posted. */
  readonly totalMs: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly batches: number;
}

export type WorkerResponse =
  | {
      readonly type: "batch";
      readonly id: number;
      readonly geometries: readonly GeometryEntry[];
      readonly maps: readonly MapMessage[];
    }
  | { readonly type: "done"; readonly id: number; readonly stats: DrawStats }
  | { readonly type: "cancelled"; readonly id: number }
  | { readonly type: "failure"; readonly id: number | null; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIndexList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((v) => Number.isInteger(v) && v >= 0);

const isPair = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number");

const isCount = (value: unknown, least: number): boolean =>
  Number.isInteger(value) && (value as number) >= least;

/**
 * Why `value` is not a draw or cancel request the worker can run, or null when it is one. A
 * message crosses from another script, so the type says what it should be and this says what it
 * is.
 */
export function requestProblem(value: unknown): string | null {
  if (!isRecord(value)) return "the message is not an object";
  if (!Number.isInteger(value.id)) return "the message has no integer id";
  if (value.type === "cancel") return null;
  if (value.type !== "draw") return `the message type ${JSON.stringify(value.type)} is unknown`;
  const { layoutKey, thetaDeg, radius, values, mapCount, first, contours } = value;
  if (typeof layoutKey !== "string" || layoutKey === "") return "layoutKey is not a string";
  if (!(thetaDeg instanceof Float64Array) || !(radius instanceof Float64Array)) {
    return "thetaDeg and radius are not Float64Arrays";
  }
  if (thetaDeg.length !== radius.length) return "thetaDeg and radius differ in length";
  if (!isCount(mapCount, 0)) return "mapCount is not a count";
  const maps = mapCount as number;
  if (!(values instanceof Float64Array) || values.length !== thetaDeg.length * maps) {
    return "values does not hold one value per sensor per map";
  }
  if (!isIndexList(first) || first.some((index) => index >= maps)) {
    return "first is not a list of map indices";
  }
  if (!isCount(value.batchSize, 1) || !isCount(value.laterBatchSize, 1)) {
    return "batchSize and laterBatchSize are not positive";
  }
  if (!isIndexList(contours) || contours.some((index) => index >= maps)) {
    return "contours is not a list of map indices";
  }
  return null;
}

function isGeometry(value: unknown): value is MapGeometryMessage {
  if (!isRecord(value)) return false;
  const { x, y, plotted, interpolated, merged, head } = value;
  return (
    typeof value.plotrad === "number" &&
    typeof value.intrad === "number" &&
    typeof value.squeezefac === "number" &&
    x instanceof Float64Array &&
    y instanceof Float64Array &&
    x.length * y.length === GRID_CELLS &&
    isIndexList(plotted) &&
    isIndexList(interpolated) &&
    Array.isArray(merged) &&
    merged.every(isIndexList) &&
    isRecord(head) &&
    typeof head.radius === "number" &&
    ["nose", "rightEar", "leftEar"].every(
      (part) => Array.isArray(head[part]) && (head[part] as unknown[]).every(isPair),
    )
  );
}

function isMapMessage(value: unknown): value is MapMessage {
  if (!isRecord(value) || !Number.isInteger(value.index)) return false;
  if (value.kind === "refused") {
    return (
      (SENSOR_FIELD_WORDS as readonly unknown[]).includes(value.word) &&
      typeof value.detail === "string"
    );
  }
  if (value.kind !== "map") return false;
  const { grid, limits, colorAxis, contourLevels, contourLines, notes } = value;
  return (
    grid instanceof Float64Array &&
    grid.length === GRID_CELLS &&
    typeof value.mean === "number" &&
    typeof value.valueRange === "number" &&
    Number.isInteger(value.geometry) &&
    isRecord(limits) &&
    isPair(limits.absmax) &&
    isPair(limits.minmax) &&
    isRecord(colorAxis) &&
    isPair(colorAxis.absmax) &&
    isPair(colorAxis.minmax) &&
    Array.isArray(contourLevels) &&
    contourLevels.every((v) => typeof v === "number") &&
    (contourLines === null ||
      (Array.isArray(contourLines) && contourLines.every((l) => l instanceof Float32Array))) &&
    Array.isArray(notes) &&
    notes.every((n) => (SENSOR_FIELD_NOTES as readonly unknown[]).includes(n))
  );
}

const isGeometryEntry = (value: unknown): value is GeometryEntry =>
  isRecord(value) && Number.isInteger(value.key) && isGeometry(value.geometry);

/** Whether `value` is an answer in the shape `WorkerResponse` declares. */
export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "batch":
      return (
        Number.isInteger(value.id) &&
        Array.isArray(value.geometries) &&
        value.geometries.every(isGeometryEntry) &&
        Array.isArray(value.maps) &&
        value.maps.every(isMapMessage)
      );
    case "done":
      return Number.isInteger(value.id) && isRecord(value.stats);
    case "cancelled":
      return Number.isInteger(value.id);
    case "failure":
      return (value.id === null || Number.isInteger(value.id)) && typeof value.message === "string";
    default:
      return false;
  }
}
