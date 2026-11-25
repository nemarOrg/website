/**
 * The sensor-field worker: draws `nemar.sensor-field.v1` maps off the page's main thread (website
 * ADR 0035 decision 1; the protocol is `worker-protocol.ts`).
 *
 * Every map of a view shares its layout, so the expensive part, the geometry (the merge, the grid,
 * the factorized interpolation matrix and the evaluation matrix), is built once per layout and
 * per set of usable sensors and kept in a small cache keyed by the layout file's SHA-256. The
 * maps the page shows go first; the rest follow in batches, with a pause between batches so a
 * `cancel` is read between them. Grids leave as `Float32Array`s, transferred.
 *
 * Run as a module worker (`worker-client.ts` creates it), this file binds itself to the worker's
 * scope. Imported anywhere else (the client's fallback for a browser without workers, and the
 * tests), it binds nothing: `createSensorFieldHandler` and `inThreadWorker` run the same code over
 * a `MessageChannel`.
 */

import { contourLines } from "./contours";
import {
  type GeometryResult,
  type SensorFieldGeometry,
  drawSensorFields,
  prepareSensorField,
  usableMask,
} from "./sensor-field";
import {
  type DrawRequest,
  type MapGeometryMessage,
  type MapMessage,
  type WorkerRequest,
  type WorkerResponse,
  requestProblem,
} from "./worker-protocol";

/** Geometries kept: a few views' worth. One geometry at 256 sensors holds about 7 MB. */
export const CACHE_ENTRIES = 6;

interface CacheEntry {
  readonly thetaDeg: Float64Array;
  readonly radius: Float64Array;
  readonly result: GeometryResult;
  readonly message: MapGeometryMessage | null;
}

export type Post = (message: WorkerResponse, transfer: Transferable[]) => void;

/** A worker-shaped object: what `worker-client.ts` drives, a real `Worker` or `inThreadWorker()`. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror?: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

const now = (): number => performance.now();

/** Let the event loop run (a `cancel` may be waiting) without a timer's clamped delay. */
function yieldToEvents(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
    channel.port2.close();
  });
}

/** Whether two layouts are the same numbers (NaN equal to NaN). */
function sameNumbers(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** A cache key for the rows a map can use: "all", or the rows it cannot. */
function maskKey(usable: Uint8Array): string {
  const missing: number[] = [];
  for (let row = 0; row < usable.length; row++) if (usable[row] === 0) missing.push(row);
  return missing.length === 0 ? "all" : missing.join(",");
}

function geometryMessage(geometry: SensorFieldGeometry): MapGeometryMessage {
  const points = (list: readonly (readonly [number, number])[]) =>
    list.map(([x, y]) => [x, y] as [number, number]);
  return {
    plotrad: geometry.plotrad,
    intrad: geometry.intrad,
    squeezefac: geometry.squeezefac,
    x: geometry.x,
    y: geometry.y,
    plotted: geometry.plotted,
    interpolated: geometry.interpolated,
    merged: geometry.merged,
    head: {
      radius: geometry.head.radius,
      nose: points(geometry.head.nose),
      rightEar: points(geometry.head.rightEar),
      leftEar: points(geometry.head.leftEar),
    },
  };
}

/** The order maps are drawn in: `first` (without repeats), then every other map by index. */
export function drawOrder(mapCount: number, first: readonly number[]): number[] {
  const seen = new Set<number>();
  const order: number[] = [];
  for (const index of [...first, ...Array.from({ length: mapCount }, (_, i) => i)]) {
    if (!seen.has(index)) {
      seen.add(index);
      order.push(index);
    }
  }
  return order;
}

/**
 * The worker's message handler, with its own cache. `post` sends an answer; each answer's buffers
 * are listed for transfer.
 */
export function createSensorFieldHandler(post: Post): (data: unknown) => void {
  const cache = new Map<string, CacheEntry>();
  const cancelled = new Set<number>();

  function geometryFor(
    request: DrawRequest,
    usable: Uint8Array,
    tally: { hits: number; misses: number; geometryMs: number },
  ): CacheEntry {
    const key = `${request.layoutKey}|${maskKey(usable)}`;
    const held = cache.get(key);
    if (
      held &&
      sameNumbers(held.thetaDeg, request.thetaDeg) &&
      sameNumbers(held.radius, request.radius)
    ) {
      cache.delete(key);
      cache.set(key, held);
      tally.hits++;
      return held;
    }
    const start = now();
    const result = prepareSensorField(request.thetaDeg, request.radius, usable);
    const entry: CacheEntry = {
      thetaDeg: Float64Array.from(request.thetaDeg),
      radius: Float64Array.from(request.radius),
      result,
      message: result.kind === "geometry" ? geometryMessage(result.geometry) : null,
    };
    tally.geometryMs += now() - start;
    tally.misses++;
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    return entry;
  }

  async function draw(request: DrawRequest): Promise<void> {
    const start = now();
    const sensors = request.thetaDeg.length;
    const tally = { hits: 0, misses: 0, geometryMs: 0 };
    let mapsMs = 0;
    const order = drawOrder(request.mapCount, request.first);
    for (let at = 0; at < order.length; at += request.batchSize) {
      if (cancelled.delete(request.id)) {
        post({ type: "cancelled", id: request.id }, []);
        return;
      }
      const batch = order.slice(at, at + request.batchSize);
      // Maps with the same usable sensors share a geometry; group them, keeping batch order.
      const groups = new Map<string, { usable: Uint8Array; indices: number[] }>();
      for (const index of batch) {
        const values = request.values.subarray(index * sensors, (index + 1) * sensors);
        const usable = usableMask(request.thetaDeg, request.radius, values);
        const key = maskKey(usable);
        const group = groups.get(key) ?? { usable, indices: [] };
        group.indices.push(index);
        groups.set(key, group);
      }
      const maps = new Map<number, MapMessage>();
      const transfer: Transferable[] = [];
      for (const { usable, indices } of groups.values()) {
        const entry = geometryFor(request, usable, tally);
        if (entry.result.kind === "refused") {
          for (const index of indices) {
            maps.set(index, {
              kind: "refused",
              index,
              word: entry.result.word,
              detail: entry.result.detail,
            });
          }
          continue;
        }
        const geometry = entry.result.geometry;
        const drawStart = now();
        const results = drawSensorFields(
          geometry,
          indices.map((index) => request.values.subarray(index * sensors, (index + 1) * sensors)),
        );
        indices.forEach((index, k) => {
          const result = results[k];
          if (result.kind === "refused") {
            maps.set(index, { kind: "refused", index, word: result.word, detail: result.detail });
            return;
          }
          const map = result.map;
          const grid = Float32Array.from(map.z);
          const lines = request.contours
            ? contourLines(map.z, geometry.x, geometry.y, map.contours)
            : null;
          transfer.push(grid.buffer, ...(lines ?? []).map((line) => line.buffer));
          maps.set(index, {
            kind: "map",
            index,
            grid,
            mean: map.mean,
            limits: { absmax: [...map.limits.absmax], minmax: [...map.limits.minmax] },
            colorAxis: { absmax: [...map.colorAxis.absmax], minmax: [...map.colorAxis.minmax] },
            contourLevels: [...map.contours],
            contourLines: lines,
            notes: [...map.notes],
            valueRange: map.valueRange,
            geometry: entry.message!,
          });
        });
        mapsMs += now() - drawStart;
      }
      post(
        { type: "batch", id: request.id, maps: batch.map((index) => maps.get(index)!) },
        transfer,
      );
      if (at + request.batchSize < order.length) await yieldToEvents();
    }
    cancelled.delete(request.id);
    post(
      {
        type: "done",
        id: request.id,
        stats: {
          mapCount: request.mapCount,
          geometryMs: tally.geometryMs,
          mapsMs,
          totalMs: now() - start,
          cacheHits: tally.hits,
          cacheMisses: tally.misses,
        },
      },
      [],
    );
  }

  return (data: unknown) => {
    const problem = requestProblem(data);
    const id = (data as { id?: unknown } | null)?.id;
    if (problem !== null) {
      post(
        { type: "failure", id: Number.isInteger(id) ? (id as number) : null, message: problem },
        [],
      );
      return;
    }
    const request = data as WorkerRequest;
    if (request.type === "cancel") {
      cancelled.add(request.id);
      return;
    }
    draw(request).catch((error: unknown) => {
      post(
        {
          type: "failure",
          id: request.id,
          message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
        [],
      );
    });
  };
}

/**
 * The worker's code on this thread, behind a `MessageChannel`: the same handler and the same
 * structured clone a real worker gives, for a browser without module workers and for the tests.
 */
export function inThreadWorker(): WorkerLike {
  const channel = new MessageChannel();
  const handle = createSensorFieldHandler((message, transfer) =>
    channel.port2.postMessage(message, transfer),
  );
  channel.port2.onmessage = (event) => handle(event.data);
  const port: WorkerLike = {
    postMessage: (message, transfer = []) => channel.port1.postMessage(message, transfer),
    onmessage: null,
    onerror: null,
    terminate: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
  channel.port1.onmessage = (event) => port.onmessage?.(event);
  return port;
}

// Bound only inside a dedicated worker: `WorkerGlobalScope` exists nowhere else.
const scope = globalThis as unknown as {
  WorkerGlobalScope?: abstract new () => unknown;
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
};
if (
  typeof scope.WorkerGlobalScope === "function" &&
  globalThis instanceof scope.WorkerGlobalScope
) {
  const handle = createSensorFieldHandler((message, transfer) =>
    scope.postMessage(message, transfer),
  );
  scope.onmessage = (event) => handle(event.data);
}
