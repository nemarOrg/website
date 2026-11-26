/**
 * The sensor-field worker: draws `nemar.sensor-field.v1` maps off the page's main thread (website
 * ADR 0035 decision 1; the protocol is `worker-protocol.ts`).
 *
 * Every map of a view shares its layout, so the expensive part, the geometry (the merge, the grid,
 * the factorized interpolation matrix and the evaluation matrix), is built once per layout and
 * per set of usable sensors and kept in a small cache keyed by the layout file's SHA-256. The
 * maps the page shows go first, in small batches, and the rest follow in larger ones, with a pause
 * between batches so a `cancel` is read between them. Each grid leaves as the `Float64Array` the
 * algorithm filled, transferred; each geometry is sent once per draw; contour lines are traced
 * only for the maps the request names (those on screen).
 *
 * Run as a module worker (`worker-client.ts` creates it), this file binds itself to the worker's
 * scope. Imported anywhere else (the client's fallback for a browser with no `Worker` at all, and
 * the tests), it binds nothing: `createSensorFieldHandler` and `inThreadWorker` run the same code
 * over a `MessageChannel`.
 */

import { contourLines } from "./contours";
import type { ViewCheck } from "./checks";
import { checkContent, checkView } from "./kinds";
import {
  type GeometryResult,
  type SensorFieldGeometry,
  drawSensorFields,
  prepareSensorField,
  usableMask,
} from "./sensor-field";
import {
  type DrawRequest,
  type GeometryEntry,
  type MapGeometryMessage,
  type MapMessage,
  type PrepareRequest,
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
  onmessageerror?: ((event: MessageEvent) => void) | null;
  terminate(): void;
}

const now = (): number => performance.now();

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

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

/**
 * The batches maps are drawn in: `first` (without repeats) in batches of `batchSize`, then every
 * other map by index in batches of `laterBatchSize`.
 */
export function drawBatches(
  mapCount: number,
  first: readonly number[],
  batchSize: number,
  laterBatchSize: number,
): number[][] {
  const seen = new Set<number>();
  const leading: number[] = [];
  for (const index of first) {
    if (!seen.has(index)) {
      seen.add(index);
      leading.push(index);
    }
  }
  const rest: number[] = [];
  for (let index = 0; index < mapCount; index++) if (!seen.has(index)) rest.push(index);
  const batches: number[][] = [];
  for (let at = 0; at < leading.length; at += batchSize) {
    batches.push(leading.slice(at, at + batchSize));
  }
  for (let at = 0; at < rest.length; at += laterBatchSize) {
    batches.push(rest.slice(at, at + laterBatchSize));
  }
  return batches;
}

/**
 * A declaration's checks in the worker. The computed presets' schemas (`guards-computed.ts`) are a
 * lazy chunk of the worker's own, loaded the first time a view names one, so the worker's base
 * chunk stays within its budget and the page never loads the guards.
 */
async function checkHere(view: unknown): Promise<ViewCheck> {
  const held = checkView(view);
  if (held) return held;
  const { COMPUTED_SCHEMAS } = await import("./guards-computed");
  return checkView(view, COMPUTED_SCHEMAS)!;
}

/**
 * The worker's message handler, with its own cache. `post` sends an answer; each answer's buffers
 * are listed for transfer.
 */
export function createSensorFieldHandler(post: Post): (data: unknown) => void {
  const cache = new Map<string, CacheEntry>();
  const cancelled = new Set<number>();

  function geometryFor(
    request: DrawRequest | PrepareRequest,
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
    const traced = new Set(request.contours);
    // The geometries this draw has sent, by cache entry, with the number maps name them by.
    const sent = new Map<CacheEntry, number>();
    let mapsMs = 0;
    const batches = drawBatches(
      request.mapCount,
      request.first,
      request.batchSize,
      request.laterBatchSize,
    );
    for (let b = 0; b < batches.length; b++) {
      if (cancelled.delete(request.id)) {
        post({ type: "cancelled", id: request.id }, []);
        return;
      }
      const batch = batches[b];
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
      const geometries: GeometryEntry[] = [];
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
        let key = sent.get(entry);
        if (key === undefined) {
          key = sent.size;
          sent.set(entry, key);
          geometries.push({ key, geometry: entry.message! });
        }
        const geometry = entry.result.geometry;
        const drawStart = now();
        const results = drawSensorFields(
          geometry,
          indices.map((index) => request.values.subarray(index * sensors, (index + 1) * sensors)),
        );
        for (let k = 0; k < indices.length; k++) {
          const index = indices[k];
          const result = results[k];
          if (result.kind === "refused") {
            maps.set(index, { kind: "refused", index, word: result.word, detail: result.detail });
            continue;
          }
          const map = result.map;
          const lines = traced.has(index)
            ? contourLines(map.z, geometry.x, geometry.y, map.contours)
            : null;
          // The grid is this map's own array: sent as it is, with no copy and no narrowing.
          transfer.push(map.z.buffer);
          if (lines) for (const line of lines) transfer.push(line.buffer);
          maps.set(index, {
            kind: "map",
            index,
            grid: map.z,
            mean: map.mean,
            limits: { absmax: map.limits.absmax, minmax: map.limits.minmax },
            colorAxis: { absmax: map.colorAxis.absmax, minmax: map.colorAxis.minmax },
            contourLevels: map.contours,
            contourLines: lines,
            notes: map.notes,
            valueRange: map.valueRange,
            geometry: key,
          });
        }
        mapsMs += now() - drawStart;
      }
      post(
        {
          type: "batch",
          id: request.id,
          geometries,
          maps: batch.map((index) => maps.get(index)!),
        },
        transfer,
      );
      if (b + 1 < batches.length) await yieldToEvents();
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
          batches: batches.length,
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
    if (request.type === "check") {
      checkHere(request.view).then(
        (check) => post({ type: "checked", id: request.id, ...check }, []),
        (error: unknown) => post({ type: "failure", id: request.id, message: describe(error) }, []),
      );
      return;
    }
    if (request.type === "check-content") {
      try {
        post(
          {
            type: "content-checked",
            id: request.id,
            valid: checkContent(request.schema, request.content),
          },
          [],
        );
      } catch (error) {
        post({ type: "failure", id: request.id, message: describe(error) }, []);
      }
      return;
    }
    if (request.type === "prepare") {
      // The geometry of a map whose every value is finite: the usable rows are the placed ones.
      const usable = usableMask(
        request.thetaDeg,
        request.radius,
        new Float64Array(request.thetaDeg.length),
      );
      const tally = { hits: 0, misses: 0, geometryMs: 0 };
      try {
        geometryFor(request, usable, tally);
        post(
          {
            type: "prepared",
            id: request.id,
            geometryMs: tally.geometryMs,
            cached: tally.hits > 0,
          },
          [],
        );
      } catch (error) {
        post({ type: "failure", id: request.id, message: describe(error) }, []);
      }
      return;
    }
    draw(request).catch((error: unknown) => {
      post({ type: "failure", id: request.id, message: describe(error) }, []);
    });
  };
}

/**
 * The worker's code on this thread, behind a `MessageChannel`: the same handler and the same
 * structured clone a real worker gives. `worker-client.ts` uses it only where the browser has no
 * `Worker` at all; a browser that has workers but cannot start this module worker gets
 * `unavailable`, not this. The tests use it too.
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
    onmessageerror: null,
    terminate: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
  channel.port1.onmessage = (event) => port.onmessage?.(event);
  channel.port1.onmessageerror = (event) => port.onmessageerror?.(event);
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
