/**
 * The page's side of the sensor-field worker (website ADR 0035 decision 1; the protocol is
 * `worker-protocol.ts`, the worker `worker.ts`).
 *
 * Browser-only, and small on purpose: it imports the protocol and nothing numerical, so a page that
 * draws scalp maps loads the algorithm only in the worker's own bundle. The worker is created when
 * the first maps are asked for, and kept for the next view, whose layout it may already hold.
 *
 * `draw` never rejects on what the worker does: every way it can go wrong is an outcome a panel
 * words (`unavailable`, with the reason), and a cancelled draw is `cancelled`. Only a caller's own
 * mistake (maps of the wrong length) throws, synchronously.
 */

import type { WorkerLike } from "./worker";
import {
  type DrawStats,
  type MapMessage,
  type WorkerRequest,
  isWorkerResponse,
} from "./worker-protocol";

/** Maps per batch message after the ones on screen. */
export const DEFAULT_BATCH_SIZE = 16;

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
  /** Trace contour lines in the worker (default true). */
  readonly contours?: boolean;
  /** Called with each batch as it arrives, the first batch holding the maps in `first`. */
  readonly onBatch?: (maps: readonly MapMessage[]) => void;
  /** Aborting tells the worker to stop and settles the draw as `cancelled`. */
  readonly signal?: AbortSignal;
}

export type DrawOutcome =
  | { readonly kind: "done"; readonly maps: readonly MapMessage[]; readonly stats: DrawStats }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unavailable"; readonly reason: string };

/** The module worker, bundled by Vite from `worker.ts`. Same-origin: the page's `worker-src 'self'`
 *  allows it, so no Content Security Policy changes. */
export function createModuleWorker(): WorkerLike {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

/** A real worker where the browser has them; otherwise the same code on this thread. */
async function defaultWorker(): Promise<WorkerLike> {
  if (typeof Worker !== "undefined") return createModuleWorker();
  const { inThreadWorker } = await import("./worker");
  return inThreadWorker();
}

interface Pending {
  readonly maps: MapMessage[];
  readonly onBatch?: (maps: readonly MapMessage[]) => void;
  readonly settle: (outcome: DrawOutcome) => void;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class SensorFieldClient {
  private worker: Promise<WorkerLike> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  /** `create` makes the worker; the default is a module worker (tests pass `inThreadWorker`). */
  constructor(private readonly create: () => WorkerLike | Promise<WorkerLike> = defaultWorker) {}

  /** Draw every map of one view. */
  draw(input: DrawInput, options: DrawOptions = {}): Promise<DrawOutcome> {
    const sensors = input.thetaDeg.length;
    if (input.radius.length !== sensors) {
      throw new RangeError(`draw: ${sensors} theta and ${input.radius.length} radius values`);
    }
    const values = new Float64Array(sensors * input.maps.length);
    input.maps.forEach((map, m) => {
      if (map.length !== sensors) {
        throw new RangeError(`draw: map ${m} has ${map.length} values for ${sensors} sensors`);
      }
      for (let s = 0; s < sensors; s++) values[m * sensors + s] = map[s];
    });
    const request: WorkerRequest = {
      type: "draw",
      id: this.nextId++,
      layoutKey: input.layoutKey,
      thetaDeg: Float64Array.from(input.thetaDeg),
      radius: Float64Array.from(input.radius),
      values,
      mapCount: input.maps.length,
      first: [...(options.first ?? [])],
      batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
      contours: options.contours ?? true,
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

  /** End the worker; draws still running settle as `cancelled`. */
  terminate(): void {
    for (const pending of [...this.pending.values()]) pending.settle({ kind: "cancelled" });
    const worker = this.worker;
    this.worker = null;
    worker?.then(
      (w) => w.terminate(),
      () => {},
    );
  }

  private ensureWorker(): Promise<WorkerLike> {
    if (this.worker) return this.worker;
    const started = Promise.resolve()
      .then(() => this.create())
      .then((worker) => {
        worker.onmessage = (event) => this.receive(event.data);
        // A script that fails to load (offline, a 404, no module workers) and one that throws
        // both arrive here; the first has no message.
        worker.onerror = (event) => {
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
    for (const pending of [...this.pending.values()])
      pending.settle({ kind: "unavailable", reason });
    const worker = this.worker;
    this.worker = null;
    worker?.then(
      (w) => w.terminate(),
      () => {},
    );
  }

  private receive(data: unknown): void {
    if (!isWorkerResponse(data)) {
      this.failAll("the map worker sent an answer this page cannot read");
      return;
    }
    if (data.type === "failure") {
      const reason = `the map worker failed: ${data.message}`;
      if (data.id === null) this.failAll(reason);
      else this.pending.get(data.id)?.settle({ kind: "unavailable", reason });
      return;
    }
    const pending = this.pending.get(data.id);
    if (!pending) return; // cancelled or ended here first; the worker's late answer is dropped
    if (data.type === "batch") {
      for (const map of data.maps) pending.maps[map.index] = map;
      // Batches are only shown, so a page that cannot show one does not end the draw.
      try {
        pending.onBatch?.(data.maps);
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
