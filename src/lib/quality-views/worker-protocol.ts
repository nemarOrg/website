/**
 * What a page and the sensor-field worker say to each other (website ADR 0035 decision 1).
 *
 * **This file imports nothing at runtime** (type imports are erased): the page imports it through
 * `worker-client.ts`, and the client must stay a few kilobytes, with the numerical work only in the
 * worker's own bundle. The worker imports it too, so what one sends and the other reads is one
 * declaration.
 *
 * A page asks for the maps of one view: one layout (theta and radius per sensor, and the SHA-256
 * of the layout file it came from, which keys the worker's cache) and one value per sensor per map.
 * The worker answers in batches, the maps the page shows first, then the rest, and ends with
 * `done`; a page that no longer needs the maps sends `cancel`. Each drawn map carries its grid as a
 * `Float32Array` (67 by 67, NaN where masked), transferred, not copied.
 */

import type { SensorFieldNote, SensorFieldWord } from "./sensor-field";

/** The grid's points per axis (`nemar.sensor-field.v1` step 7), repeated here so this file needs no
 *  runtime import; `worker.test.ts` checks it against the algorithm's. */
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
  /** Maps per batch message. The maps in `first` are batched the same way. */
  readonly batchSize: number;
  /** Whether to trace the contour lines (marching squares) in the worker. */
  readonly contours: boolean;
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

export interface DrawnMapMessage {
  readonly kind: "map";
  readonly index: number;
  /** 67 by 67, `grid[i * 67 + j]` at `(x[i], y[j])`; NaN where masked. */
  readonly grid: Float32Array;
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
  /** One segment list per level (`x0, y0, x1, y1` each), or null when contours were not asked for. */
  readonly contourLines: readonly Float32Array[] | null;
  readonly notes: readonly SensorFieldNote[];
  readonly valueRange: number;
  readonly geometry: MapGeometryMessage;
}

export interface RefusedMapMessage {
  readonly kind: "refused";
  readonly index: number;
  readonly word: SensorFieldWord;
  readonly detail: string;
}

export type MapMessage = DrawnMapMessage | RefusedMapMessage;

export interface DrawStats {
  readonly mapCount: number;
  /** Milliseconds spent building geometries this request did not find in the cache. */
  readonly geometryMs: number;
  /** Milliseconds spent drawing maps on their geometries. */
  readonly mapsMs: number;
  /** From the request's arrival to the last batch posted. */
  readonly totalMs: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

export type WorkerResponse =
  | { readonly type: "batch"; readonly id: number; readonly maps: readonly MapMessage[] }
  | { readonly type: "done"; readonly id: number; readonly stats: DrawStats }
  | { readonly type: "cancelled"; readonly id: number }
  | { readonly type: "failure"; readonly id: number | null; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIndexList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((v) => Number.isInteger(v) && v >= 0);

const isPair = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number");

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
  const { layoutKey, thetaDeg, radius, values, mapCount, first, batchSize, contours } = value;
  if (typeof layoutKey !== "string" || layoutKey === "") return "layoutKey is not a string";
  if (!(thetaDeg instanceof Float64Array) || !(radius instanceof Float64Array)) {
    return "thetaDeg and radius are not Float64Arrays";
  }
  if (thetaDeg.length !== radius.length) return "thetaDeg and radius differ in length";
  if (!Number.isInteger(mapCount) || (mapCount as number) < 0) return "mapCount is not a count";
  if (
    !(values instanceof Float64Array) ||
    values.length !== thetaDeg.length * (mapCount as number)
  ) {
    return "values does not hold one value per sensor per map";
  }
  if (!isIndexList(first) || first.some((index) => index >= (mapCount as number))) {
    return "first is not a list of map indices";
  }
  if (!Number.isInteger(batchSize) || (batchSize as number) < 1) return "batchSize is not positive";
  if (typeof contours !== "boolean") return "contours is not a boolean";
  return null;
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
  const { grid, limits, colorAxis, contourLevels, contourLines, notes, geometry } = value;
  return (
    grid instanceof Float32Array &&
    grid.length === GRID_CELLS &&
    typeof value.mean === "number" &&
    typeof value.valueRange === "number" &&
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
    notes.every((n) => (SENSOR_FIELD_NOTES as readonly unknown[]).includes(n)) &&
    isRecord(geometry) &&
    geometry.x instanceof Float64Array &&
    geometry.y instanceof Float64Array &&
    isIndexList(geometry.plotted) &&
    isIndexList(geometry.interpolated) &&
    Array.isArray(geometry.merged) &&
    isRecord(geometry.head)
  );
}

/** Whether `value` is an answer in the shape `WorkerResponse` declares. */
export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "batch":
      return (
        Number.isInteger(value.id) && Array.isArray(value.maps) && value.maps.every(isMapMessage)
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
