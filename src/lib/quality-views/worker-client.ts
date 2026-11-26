/**
 * The page's side of the sensor-field worker (website ADR 0035 decision 1; the protocol is
 * `worker-protocol.ts`, the worker `worker.ts`).
 *
 * Browser-only, and small on purpose: it imports the protocol and the contour tracer, and none of
 * the interpolation, so a page that draws scalp maps loads the algorithm only in the worker's own
 * bundle. The worker is created when the first maps are asked for, and kept for the next view,
 * whose layout it may already hold.
 *
 * `draw` never rejects on what the worker does: every way it can go wrong is an outcome a panel
 * words (`unavailable`, with the reason), and a cancelled draw is `cancelled`. Only a caller's own
 * mistake (maps of the wrong length) throws, synchronously.
 *
 * **The cold first view (website#592).** The first view after a page opens used to pay for the
 * engine compiling the large loops: on CI's runner 107 to 137 ms at 128 sensors where later views
 * take about 60. So a page warms the worker as soon as it knows the layout, while the view's values
 * still download (`warm`): the worker starts, builds the layout's geometry (`prepare`) and draws a
 * full-size set of throwaway maps on it, so the view's own draw finds the geometry cached and the
 * code compiled. A real draw cancels a warm-up still running, so the warm-up never delays it by
 * more than one batch. One client serves the page (`sharedSensorFieldClient`), so the signal
 * viewer and a quality panel share one worker and its cache.
 */

import { contourLines } from "./contours";
import type { WorkerLike } from "./worker";
import {
  type DrawStats,
  type DrawnMapMessage,
  type MapGeometryMessage,
  type RefusedMapMessage,
  type WorkerRequest,
  isWorkerResponse,
} from "./worker-protocol";

/** Maps per batch while the maps on screen are drawn. */
export const DEFAULT_BATCH_SIZE = 8;
/** Maps per batch after them. */
export const DEFAULT_LATER_BATCH_SIZE = 64;

export interface DrawInput {
  /** The SHA-256 of the layout file the places came from; the worker caches by it. */
  readonly layoutKey: string;
  readonly thetaDeg: ArrayLike<number>;
  readonly radius: ArrayLike<number>;
  /** One value per sensor for each map, NaN where a value is not finite. */
  readonly maps: readonly ArrayLike<number>[];
}

export interface DrawOptions {
  /** Map indices to draw first: those on screen. */
  readonly first?: readonly number[];
  readonly batchSize?: number;
  readonly laterBatchSize?: number;
  /**
   * The maps whose contour lines the worker traces: `first` (the default, the maps on screen),
   * `all`, `none`, or a list of indices. `contoursOf` traces any other map's lines when it is shown.
   */
  readonly contours?: "first" | "all" | "none" | readonly number[];
  /** Called with each batch as it arrives, the first batch holding the maps in `first`. */
  readonly onBatch?: (maps: readonly MapResult[]) => void;
  /** Aborting tells the worker to stop and settles the draw as `cancelled`. */
  readonly signal?: AbortSignal;
}

/** A drawn map with its geometry in place. */
export type DrawnMap = Omit<DrawnMapMessage, "geometry"> & {
  readonly geometry: MapGeometryMessage;
};
export type MapResult = DrawnMap | RefusedMapMessage;

export type DrawOutcome =
  | { readonly kind: "done"; readonly maps: readonly MapResult[]; readonly stats: DrawStats }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Maps a warm-up draws: one batch of the maps on screen and one later batch, so both batch sizes
 *  the worker draws in are compiled. */
export const WARM_MAPS = DEFAULT_BATCH_SIZE + DEFAULT_LATER_BATCH_SIZE;

/** Where a view's sensors go, known before its values arrive. */
export interface LayoutInput {
  readonly layoutKey: string;
  readonly thetaDeg: ArrayLike<number>;
  readonly radius: ArrayLike<number>;
}

export type PrepareOutcome =
  | { readonly kind: "prepared"; readonly geometryMs: number; readonly cached: boolean }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface WarmOutcome {
  readonly prepared: PrepareOutcome;
  /** The throwaway draw: `done`, or `cancelled` when a real draw came first. */
  readonly draw: DrawOutcome;
  /** From the call to the end of the throwaway draw. */
  readonly ms: number;
}

/** The answer a page cannot read, worded once. */
export const UNREADABLE_ANSWER = "the map worker sent an answer this page cannot read";

/** A map's contour lines: the worker's, when it traced them, otherwise traced here. */
export function contoursOf(map: DrawnMap): readonly Float32Array[] {
  return (
    map.contourLines ?? contourLines(map.grid, map.geometry.x, map.geometry.y, map.contourLevels)
  );
}

/** The module worker, bundled by Vite from `worker.ts`. Same-origin: the page's `worker-src 'self'`
 *  allows it, so no Content Security Policy changes. */
export function createModuleWorker(): WorkerLike {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

/** A real worker where the browser has `Worker`; otherwise the same code on this thread. */
async function defaultWorker(): Promise<WorkerLike> {
  if (typeof Worker !== "undefined") return createModuleWorker();
  const { inThreadWorker } = await import("./worker");
  return inThreadWorker();
}

interface Pending {
  readonly maps: MapResult[];
  readonly geometries: Map<number, MapGeometryMessage>;
  readonly onBatch?: (maps: readonly MapResult[]) => void;
  readonly settle: (outcome: DrawOutcome) => void;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function contourIndices(
  choice: DrawOptions["contours"],
  first: readonly number[],
  mapCount: number,
): number[] {
  if (choice === undefined || choice === "first") return [...first];
  if (choice === "all") return Array.from({ length: mapCount }, (_, i) => i);
  if (choice === "none") return [];
  return [...choice];
}

/** A full-size map the warm-up draws: smooth, every value finite. */
function warmValues(sensors: number, map: number): Float64Array {
  return Float64Array.from({ length: sensors }, (_, s) => Math.sin((s + 1) * (map + 1) * 0.37));
}

export class SensorFieldClient {
  private worker: Promise<WorkerLike> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly prepares = new Map<number, (outcome: PrepareOutcome) => void>();
  /** The warm-up draw running, which a real draw cancels. */
  private warming: AbortController | null = null;

  /** `create` makes the worker; the default is a module worker (tests pass `inThreadWorker`). */
  constructor(private readonly create: () => WorkerLike | Promise<WorkerLike> = defaultWorker) {}

  /** Draw every map of one view; a warm-up still running is cancelled first. */
  draw(input: DrawInput, options: DrawOptions = {}): Promise<DrawOutcome> {
    this.warming?.abort();
    this.warming = null;
    return this.send(input, options);
  }

  /** Build a layout's geometry in the worker ahead of its maps (starting the worker if needed). */
  prepare(layout: LayoutInput): Promise<PrepareOutcome> {
    if (layout.radius.length !== layout.thetaDeg.length) {
      throw new RangeError(
        `prepare: ${layout.thetaDeg.length} theta and ${layout.radius.length} radius values`,
      );
    }
    const id = this.nextId++;
    const request: WorkerRequest = {
      type: "prepare",
      id,
      layoutKey: layout.layoutKey,
      thetaDeg: Float64Array.from(layout.thetaDeg),
      radius: Float64Array.from(layout.radius),
    };
    return new Promise<PrepareOutcome>((resolve) => {
      this.prepares.set(id, (outcome) => {
        this.prepares.delete(id);
        resolve(outcome);
      });
      this.ensureWorker().then(
        (worker) => {
          try {
            worker.postMessage(request);
          } catch (error) {
            this.prepares.get(id)?.({ kind: "unavailable", reason: describeError(error) });
          }
        },
        (error: unknown) => this.failAll(`the map worker could not start: ${describeError(error)}`),
      );
    });
  }

  /**
   * Warm the worker for a view whose layout is known and whose values are still on their way:
   * build the geometry, then draw `maps` throwaway maps at full size on it, so the view's own draw
   * meets compiled code and a cached geometry. Never rejects; a real `draw` cancels it.
   */
  async warm(layout: LayoutInput, maps = WARM_MAPS): Promise<WarmOutcome> {
    const start = performance.now();
    this.warming?.abort();
    const controller = new AbortController();
    this.warming = controller;
    const prepared = await this.prepare(layout);
    if (controller.signal.aborted || prepared.kind !== "prepared") {
      if (this.warming === controller) this.warming = null;
      const draw: DrawOutcome = prepared.kind === "unavailable" ? prepared : { kind: "cancelled" };
      return { prepared, draw, ms: performance.now() - start };
    }
    const sensors = layout.thetaDeg.length;
    const draw = await this.send(
      {
        layoutKey: layout.layoutKey,
        thetaDeg: layout.thetaDeg,
        radius: layout.radius,
        maps: Array.from({ length: maps }, (_, m) => warmValues(sensors, m)),
      },
      {
        first: Array.from({ length: Math.min(DEFAULT_BATCH_SIZE, maps) }, (_, i) => i),
        signal: controller.signal,
      },
    );
    if (this.warming === controller) this.warming = null;
    return { prepared, draw, ms: performance.now() - start };
  }

  private send(input: DrawInput, options: DrawOptions): Promise<DrawOutcome> {
    const sensors = input.thetaDeg.length;
    if (input.radius.length !== sensors) {
      throw new RangeError(`draw: ${sensors} theta and ${input.radius.length} radius values`);
    }
    const values = new Float64Array(sensors * input.maps.length);
    for (let m = 0; m < input.maps.length; m++) {
      const map = input.maps[m];
      if (map.length !== sensors) {
        throw new RangeError(`draw: map ${m} has ${map.length} values for ${sensors} sensors`);
      }
      if (map instanceof Float64Array) values.set(map, m * sensors);
      else for (let s = 0; s < sensors; s++) values[m * sensors + s] = map[s];
    }
    const first = [...(options.first ?? [])];
    const request: WorkerRequest = {
      type: "draw",
      id: this.nextId++,
      layoutKey: input.layoutKey,
      thetaDeg: Float64Array.from(input.thetaDeg),
      radius: Float64Array.from(input.radius),
      values,
      mapCount: input.maps.length,
      first,
      batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
      laterBatchSize: options.laterBatchSize ?? DEFAULT_LATER_BATCH_SIZE,
      contours: contourIndices(options.contours, first, input.maps.length),
    };
    const { signal } = options;
    return new Promise<DrawOutcome>((resolve) => {
      if (signal?.aborted) return resolve({ kind: "cancelled" });
      const id = request.id;
      const onAbort = (): void => {
        if (!this.pending.has(id)) return;
        this.pending.get(id)!.settle({ kind: "cancelled" });
        this.worker?.then(
          (worker) => worker.postMessage({ type: "cancel", id }),
          () => {},
        );
      };
      this.pending.set(id, {
        maps: [],
        geometries: new Map(),
        onBatch: options.onBatch,
        settle: (outcome) => {
          this.pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
          resolve(outcome);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.ensureWorker().then(
        (worker) => {
          if (!this.pending.has(id)) return;
          try {
            worker.postMessage(request, [request.values.buffer]);
          } catch (error) {
            this.pending.get(id)?.settle({ kind: "unavailable", reason: describeError(error) });
          }
        },
        (error: unknown) => this.failAll(`the map worker could not start: ${describeError(error)}`),
      );
    });
  }

  /** End the worker; draws still running settle as `cancelled`. The next draw starts a new one. */
  terminate(): void {
    this.warming?.abort();
    this.warming = null;
    for (const pending of [...this.pending.values()]) pending.settle({ kind: "cancelled" });
    for (const settle of [...this.prepares.values()]) settle({ kind: "cancelled" });
    const worker = this.worker;
    this.worker = null;
    worker?.then(
      (w) => w.terminate(),
      () => {},
    );
  }

  private ensureWorker(): Promise<WorkerLike> {
    if (this.worker) return this.worker;
    const started: Promise<WorkerLike> = Promise.resolve()
      .then(() => this.create())
      .then((worker) => {
        // Events from a worker this client has since dropped (terminated, or failed and replaced)
        // are ignored: they would otherwise settle the next worker's draws.
        const current = (): boolean => this.worker === started;
        worker.onmessage = (event) => {
          if (current()) this.receive(event.data);
        };
        // A message that cannot be cloned on its way here.
        worker.onmessageerror = () => {
          if (current()) this.failAll(UNREADABLE_ANSWER);
        };
        // A script that fails to load (offline, a 404, no module workers) and one that throws
        // both arrive here; the first has no message.
        worker.onerror = (event) => {
          if (!current()) return;
          const message = event.message;
          this.failAll(
            message ? `the map worker failed: ${message}` : "the map worker could not be loaded",
          );
        };
        return worker;
      });
    this.worker = started;
    return started;
  }

  /** Settle every draw as unavailable and drop the worker, so the next draw starts a new one. */
  private failAll(reason: string): void {
    for (const pending of [...this.pending.values()]) {
      pending.settle({ kind: "unavailable", reason });
    }
    for (const settle of [...this.prepares.values()]) settle({ kind: "unavailable", reason });
    const worker = this.worker;
    this.worker = null;
    worker?.then(
      (w) => w.terminate(),
      () => {},
    );
  }

  private receive(data: unknown): void {
    if (!isWorkerResponse(data)) {
      this.failAll(UNREADABLE_ANSWER);
      return;
    }
    if (data.type === "failure") {
      const reason = `the map worker failed: ${data.message}`;
      if (data.id === null) this.failAll(reason);
      else {
        this.pending.get(data.id)?.settle({ kind: "unavailable", reason });
        this.prepares.get(data.id)?.({ kind: "unavailable", reason });
      }
      return;
    }
    if (data.type === "prepared") {
      this.prepares.get(data.id)?.({
        kind: "prepared",
        geometryMs: data.geometryMs,
        cached: data.cached,
      });
      return;
    }
    const pending = this.pending.get(data.id);
    if (!pending) return; // cancelled or ended here first; the worker's late answer is dropped
    if (data.type === "batch") {
      for (const { key, geometry } of data.geometries) pending.geometries.set(key, geometry);
      const maps: MapResult[] = [];
      for (const map of data.maps) {
        if (map.kind === "refused") {
          maps.push(map);
          continue;
        }
        const geometry = pending.geometries.get(map.geometry);
        if (!geometry) {
          this.failAll(UNREADABLE_ANSWER);
          return;
        }
        maps.push({ ...map, geometry });
      }
      for (const map of maps) pending.maps[map.index] = map;
      // Batches are only shown, so a page that cannot show one does not end the draw.
      try {
        pending.onBatch?.(maps);
      } catch (error) {
        console.error("[quality-views] a batch of maps could not be shown:", error);
      }
    } else if (data.type === "done") {
      pending.settle({ kind: "done", maps: pending.maps, stats: data.stats });
    } else {
      pending.settle({ kind: "cancelled" });
    }
  }
}

let shared: SensorFieldClient | null = null;

/**
 * The page's one map client: the signal viewer and every quality panel draw through it, so a page
 * starts one worker and one geometry cache. A user of it cancels its own draws (an `AbortSignal`)
 * and never terminates it.
 */
export function sharedSensorFieldClient(): SensorFieldClient {
  shared ??= new SensorFieldClient();
  return shared;
}
