/**
 * The sensor-field worker and its client (website ADR 0035 decision 1; website#588 phase W2).
 *
 * The client drives the real worker handler on this thread through `inThreadWorker()`: a real
 * `MessageChannel`, so every request and answer is structured-cloned and every grid transferred, as
 * between a page and a module worker. The grid a page receives is held to the parity vectors after
 * that transfer. The client's error paths are driven by stub transports (a worker that fails to
 * start, errors, answers a failure or an unreadable message), as an HTTP fixture drives a client's
 * error path; nothing in the drawing is stubbed.
 */

import { describe, expect, it } from "vitest";
import { GRID_SIZE, type SensorFieldMap, sensorField } from "../src/lib/quality-views/sensor-field";
import {
  type WorkerLike,
  createSensorFieldHandler,
  drawBatches,
  inThreadWorker,
} from "../src/lib/quality-views/worker";
import {
  type DrawInput,
  type DrawnMap,
  type MapResult,
  SensorFieldClient,
  UNREADABLE_ANSWER,
  WARM_MAPS,
  contoursOf,
  sharedSensorFieldClient,
} from "../src/lib/quality-views/worker-client";
import {
  type DrawRequest,
  GRID_CELLS,
  type WorkerRequest,
  type WorkerResponse,
  isWorkerResponse,
} from "../src/lib/quality-views/worker-protocol";
import { requestProblem } from "../src/lib/quality-views/worker-requests";
import {
  caseLayout,
  compareCells,
  loadFieldVectors,
  loadLayoutVectors,
  montageCentersFromFiles,
  numbers,
} from "./quality-views-vectors";

const field = await loadFieldVectors();
const layoutVectors = await loadLayoutVectors();
const centers = await montageCentersFromFiles();
const cap = field.cases.find((c) => c.name === "montage_64")!;
const THETA = numbers(cap.sensors.theta_deg!);
const RADIUS = numbers(cap.sensors.radius!);
const VALUES = numbers(cap.sensors.value);
const LAYOUT_KEY = "a".repeat(64);

/** `count` maps on the 64-sensor cap: the vector's values, scaled and shifted per map. */
function mapsOf(count: number): Float64Array[] {
  return Array.from({ length: count }, (_, m) =>
    Float64Array.from(VALUES, (v, s) => v * Math.cos(m + 1) + Math.sin(s * (m + 1))),
  );
}

function input(maps: readonly ArrayLike<number>[], layoutKey = LAYOUT_KEY): DrawInput {
  return { layoutKey, thetaDeg: THETA, radius: RADIUS, maps };
}

function core(values: ArrayLike<number>, theta = THETA, radius = RADIUS): SensorFieldMap {
  const result = sensorField(theta, radius, values);
  if (result.kind !== "map") throw new Error(`refused: ${result.word}`);
  return result.map;
}

function drawn(result: MapResult): DrawnMap {
  if (result.kind !== "map") throw new Error(`refused: ${result.word}`);
  return result;
}

function expectSameMap(result: MapResult, map: SensorFieldMap): void {
  const message = drawn(result);
  expect(message.grid).toBeInstanceOf(Float64Array);
  expect(Array.from(message.grid)).toEqual(Array.from(map.z));
  expect(message.limits).toEqual(map.limits);
  expect(message.contourLevels).toEqual(map.contours);
  expect(message.notes).toEqual(map.notes);
  expect(message.mean).toBe(map.mean);
  expect(message.geometry.plotted).toEqual(map.geometry.plotted);
  expect(message.geometry.interpolated).toEqual(map.geometry.interpolated);
  expect(Array.from(message.geometry.x)).toEqual(Array.from(map.geometry.x));
}

describe("the protocol", () => {
  it("repeats the algorithm's grid size", () => {
    expect(GRID_CELLS).toBe(GRID_SIZE * GRID_SIZE);
  });

  it("batches the maps on screen first, then the rest in larger batches, each map once", () => {
    expect(drawBatches(6, [5, 2, 5], 1, 4)).toEqual([[5], [2], [0, 1, 3, 4]]);
    expect(drawBatches(5, [], 2, 3)).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
    expect(drawBatches(0, [], 8, 64)).toEqual([]);
  });
});

describe("the grid a page receives, after transfer, holds to every drawn vector", () => {
  const drawable = field.cases.filter((c) => c.expected !== undefined);

  it("covers every drawn case of the vectors", () => {
    expect(drawable.length).toBe(33);
  });

  it.each(drawable.map((c) => [c.name, c] as const))("%s", async (_name, vectorCase) => {
    const layout = caseLayout(vectorCase, centers);
    if (layout === null) throw new Error("the projection refused a drawn case");
    const client = new SensorFieldClient(inThreadWorker);
    const outcome = await client.draw({
      layoutKey: vectorCase.name,
      thetaDeg: layout.thetaDeg,
      radius: layout.radius,
      maps: [numbers(vectorCase.sensors.value)],
    });
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    const map = drawn(outcome.maps[0]);
    const expected = vectorCase.expected!;
    const cells = compareCells(field, expected, map.grid)!;
    expect(cells.maskDiffers).toBe(false);
    expect(cells.worst).toBeLessThanOrEqual(cells.bound);
    for (const rule of ["absmax", "minmax"] as const) {
      for (let i = 0; i < 2; i++) {
        expect(Math.abs(map.limits[rule][i] - expected.limits[rule][i])).toBeLessThanOrEqual(
          cells.bound,
        );
        expect(Math.abs(map.colorAxis[rule][i] - expected.color_axis[rule][i])).toBeLessThanOrEqual(
          cells.bound,
        );
      }
    }
    expect(map.notes).toEqual(expected.notes);
    expect(map.contourLevels).toHaveLength(expected.contours.length);
  });
});

describe("drawing through the worker", () => {
  it("draws every map as the core does, its grid the core's own numbers", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const maps = mapsOf(6);
    const outcome = await client.draw(input(maps), { contours: "all" });
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expect(outcome.maps).toHaveLength(6);
    maps.forEach((values, m) => expectSameMap(outcome.maps[m], core(values)));
    const lines = drawn(outcome.maps[0]).contourLines!;
    expect(lines).toHaveLength(6);
    expect(lines[0].length % 4).toBe(0);
  });

  it("sends the maps on screen in the first batches, then the rest in larger ones", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const batches: number[][] = [];
    const outcome = await client.draw(input(mapsOf(7)), {
      first: [5, 2],
      batchSize: 2,
      laterBatchSize: 3,
      onBatch: (maps) => batches.push(maps.map((m) => m.index)),
    });
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expect(batches).toEqual([
      [5, 2],
      [0, 1, 3],
      [4, 6],
    ]);
    expect(outcome.stats.batches).toBe(3);
  });

  it("traces contour lines only for the maps on screen, and the page traces the rest the same", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const outcome = await client.draw(input(mapsOf(4)), { first: [2] });
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expect(outcome.maps.map((m) => drawn(m).contourLines !== null)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    const traced = drawn(outcome.maps[2]).contourLines!;
    const byPage = contoursOf({ ...drawn(outcome.maps[2]), contourLines: null });
    expect(byPage.map((l) => Array.from(l))).toEqual(traced.map((l) => Array.from(l)));
    expect(contoursOf(drawn(outcome.maps[0]))).toHaveLength(6);
  });

  it("sends each geometry once per draw, and every map of that geometry names it", async () => {
    const sent: WorkerResponse[] = [];
    const channel = new MessageChannel();
    const handle = createSensorFieldHandler((message, transfer) => {
      sent.push(message);
      channel.port2.postMessage(message, transfer);
    });
    channel.port2.onmessage = (event) => handle(event.data);
    const port: WorkerLike = {
      postMessage: (message, transfer = []) => channel.port1.postMessage(message, transfer),
      onmessage: null,
      terminate: () => {
        channel.port1.close();
        channel.port2.close();
      },
    };
    channel.port1.onmessage = (event) => port.onmessage?.(event);
    const client = new SensorFieldClient(() => port);
    const [a, b, c] = mapsOf(3);
    const holed = Float64Array.from(c);
    holed[5] = Number.NaN;
    const outcome = await client.draw(input([a, b, holed, c]), {
      batchSize: 1,
      laterBatchSize: 1,
    });
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    const geometries = sent.flatMap((m) => (m.type === "batch" ? m.geometries : []));
    expect(geometries.map((g) => g.key)).toEqual([0, 1]);
    expect(sent.filter((m) => m.type === "batch")).toHaveLength(4);
    expect(outcome.maps.map((m) => drawn(m).geometry.plotted.length)).toEqual([64, 64, 63, 64]);
    expect(drawn(outcome.maps[0]).geometry).toBe(drawn(outcome.maps[3]).geometry);
  });

  it("keeps a layout's geometry for the next view of the same layout file", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const cold = await client.draw(input(mapsOf(4)));
    const warm = await client.draw(input(mapsOf(2)));
    const other = await client.draw(input(mapsOf(2), "b".repeat(64)));
    client.terminate();
    if (cold.kind !== "done" || warm.kind !== "done" || other.kind !== "done") {
      throw new Error("a draw did not finish");
    }
    expect([cold.stats.cacheMisses, cold.stats.cacheHits]).toEqual([1, 0]);
    expect([warm.stats.cacheMisses, warm.stats.cacheHits]).toEqual([0, 1]);
    expect(other.stats.cacheMisses).toBe(1);
  });

  it("never reuses a geometry for other places under the same key", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    await client.draw(input(mapsOf(1)));
    const moved = Float64Array.from(THETA, (t) => t + 10);
    const values = mapsOf(1)[0];
    const outcome = await client.draw({
      layoutKey: LAYOUT_KEY,
      thetaDeg: moved,
      radius: RADIUS,
      maps: [values],
    });
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expect(outcome.stats.cacheMisses).toBe(1);
    expectSameMap(outcome.maps[0], core(values, moved));
  });

  it("draws maps with different unusable sensors on their own geometries, and refuses by word", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const [whole, holed] = mapsOf(2);
    holed[3] = Number.NaN;
    holed[40] = Number.NaN;
    // A map with values at 7 sensors only: refused, while the others draw.
    const sparse = Float64Array.from(VALUES, (v, s) => (s < 7 ? v : Number.NaN));
    const outcome = await client.draw(input([whole, holed, sparse]));
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expectSameMap(outcome.maps[0], core(whole));
    expectSameMap(outcome.maps[1], core(holed));
    expect(outcome.maps[2]).toMatchObject({ kind: "refused", index: 2, word: "too_few_sensors" });
    expect(outcome.stats.cacheMisses).toBe(3);
  });

  it("refuses every map of a layout with too few sensors", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const outcome = await client.draw({
      layoutKey: "c".repeat(64),
      thetaDeg: THETA.slice(0, 7),
      radius: RADIUS.slice(0, 7),
      maps: [VALUES.slice(0, 7), VALUES.slice(0, 7)],
    });
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expect(outcome.maps.map((m) => (m.kind === "refused" ? m.word : m.kind))).toEqual([
      "too_few_sensors",
      "too_few_sensors",
    ]);
  });

  it("keeps drawing when the page cannot show a batch", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const outcome = await client.draw(input(mapsOf(3)), {
        laterBatchSize: 1,
        onBatch: () => {
          throw new Error("the panel is gone");
        },
      });
      expect(outcome.kind).toBe("done");
      expect(errors).toHaveLength(3);
    } finally {
      console.error = original;
      client.terminate();
    }
  });

  it("settles a draw aborted by the page as cancelled, and the worker serves the next view", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const controller = new AbortController();
    const outcome = await client.draw(input(mapsOf(6)), {
      laterBatchSize: 1,
      signal: controller.signal,
      onBatch: () => controller.abort(),
    });
    expect(outcome).toEqual({ kind: "cancelled" });
    const next = await client.draw(input(mapsOf(1)));
    client.terminate();
    expect(next.kind).toBe("done");
  });

  it("settles an already-aborted draw without sending it", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const controller = new AbortController();
    controller.abort();
    expect(await client.draw(input(mapsOf(1)), { signal: controller.signal })).toEqual({
      kind: "cancelled",
    });
    client.terminate();
  });

  it("refuses maps of the wrong length synchronously, as a caller's mistake", () => {
    const client = new SensorFieldClient(inThreadWorker);
    expect(() => client.draw(input([VALUES.slice(0, 10)]))).toThrow(RangeError);
    client.terminate();
  });
});

describe("the worker handler", () => {
  function request(id: number, mapCount: number, laterBatchSize: number): DrawRequest {
    const values = new Float64Array(THETA.length * mapCount);
    mapsOf(mapCount).forEach((map, m) => values.set(map, m * THETA.length));
    return {
      type: "draw",
      id,
      layoutKey: LAYOUT_KEY,
      thetaDeg: Float64Array.from(THETA),
      radius: Float64Array.from(RADIUS),
      values,
      mapCount,
      first: [],
      batchSize: 1,
      laterBatchSize,
      contours: [],
    };
  }

  it("stops at the next batch after a cancel and says so", async () => {
    const posted: WorkerResponse[] = [];
    const handle = createSensorFieldHandler((message) => posted.push(message));
    handle(request(7, 4, 1));
    // The first batch was drawn before the handler returned; the cancel is read before the next.
    expect(posted.map((m) => m.type)).toEqual(["batch"]);
    handle({ type: "cancel", id: 7 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted.map((m) => m.type)).toEqual(["batch", "cancelled"]);
  });

  it("answers a malformed request with a failure naming the problem", () => {
    const posted: WorkerResponse[] = [];
    const handle = createSensorFieldHandler((message) => posted.push(message));
    handle({ type: "draw", id: 3, layoutKey: LAYOUT_KEY });
    handle("not a request");
    handle({ ...request(4, 2, 1), values: new Float64Array(5) });
    handle({ ...request(5, 2, 1), contours: [2] });
    handle({ ...request(6, 2, 1), laterBatchSize: 0 });
    expect(posted).toEqual([
      { type: "failure", id: 3, message: "thetaDeg and radius are not Float64Arrays" },
      { type: "failure", id: null, message: "the message is not an object" },
      { type: "failure", id: 4, message: "values does not hold one value per sensor per map" },
      { type: "failure", id: 5, message: "contours is not a list of map indices" },
      { type: "failure", id: 6, message: "batchSize and laterBatchSize are not positive" },
    ]);
  });
});

interface StubWorker extends WorkerLike {
  readonly requests: WorkerRequest[];
  terminated: boolean;
  answer(data: unknown): void;
}

/**
 * A stub transport: a worker-shaped object whose answers the test writes. `respond` is called with
 * each request, after the client has finished sending it; it may post an answer, raise an error
 * event, or do nothing.
 */
function stubWorker(respond: (request: WorkerRequest, stub: StubWorker) => void): StubWorker {
  const stub: StubWorker = {
    requests: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message) {
      stub.requests.push(message);
      queueMicrotask(() => respond(message, stub));
    },
    terminate() {
      stub.terminated = true;
    },
    answer(data) {
      stub.onmessage?.(new MessageEvent("message", { data }));
    },
  };
  return stub;
}

/**
 * An `error` event with a message, as a worker raises one. Node has no global `ErrorEvent` before
 * version 23 (CI's runner has none), so it is an `Event` carrying the one field the client reads.
 */
function errorEvent(message: string): ErrorEvent {
  return Object.assign(new Event("error"), { message }) as ErrorEvent;
}

describe("the client's error paths", () => {
  it("settles as unavailable when the worker cannot be created, and tries a new one next time", async () => {
    let attempts = 0;
    const client = new SensorFieldClient(() => {
      attempts++;
      if (attempts === 1) throw new Error("module workers are off");
      return inThreadWorker();
    });
    expect(await client.draw(input(mapsOf(1)))).toEqual({
      kind: "unavailable",
      reason: "the map worker could not start: Error: module workers are off",
    });
    const next = await client.draw(input(mapsOf(1)));
    client.terminate();
    expect(next.kind).toBe("done");
    expect(attempts).toBe(2);
  });

  it("settles as unavailable when the worker's script fails to load or throws, and drops it", async () => {
    const stubs: StubWorker[] = [];
    const client = new SensorFieldClient(() => {
      const message = stubs.length === 0 ? "" : "boom";
      const stub = stubWorker((_request, self) => self.onerror?.(errorEvent(message)));
      stubs.push(stub);
      return stub;
    });
    expect(await client.draw(input(mapsOf(1)))).toEqual({
      kind: "unavailable",
      reason: "the map worker could not be loaded",
    });
    // The failed worker is terminated as soon as its promise settles, one turn later.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stubs[0].terminated).toBe(true);
    expect(await client.draw(input(mapsOf(1)))).toEqual({
      kind: "unavailable",
      reason: "the map worker failed: boom",
    });
    expect(stubs).toHaveLength(2);
    client.terminate();
  });

  it("settles one draw on its failure message, and every draw on an unaddressed one", async () => {
    const client = new SensorFieldClient(() =>
      stubWorker((request, self) => {
        if (request.type !== "draw") return;
        self.answer({
          type: "failure",
          id: request.id === 1 ? 1 : null,
          message: "RangeError: out of memory",
        });
      }),
    );
    const reason = "the map worker failed: RangeError: out of memory";
    expect(await client.draw(input(mapsOf(1)))).toEqual({ kind: "unavailable", reason });
    expect(await client.draw(input(mapsOf(1)))).toEqual({ kind: "unavailable", reason });
    client.terminate();
  });

  it("settles as unavailable on a message that could not be read (messageerror)", async () => {
    const client = new SensorFieldClient(() =>
      stubWorker((_request, self) => self.onmessageerror?.(new MessageEvent("messageerror"))),
    );
    expect(await client.draw(input(mapsOf(1)))).toEqual({
      kind: "unavailable",
      reason: UNREADABLE_ANSWER,
    });
    client.terminate();
  });

  it("settles as unavailable on an answer in a shape it cannot read", async () => {
    const client = new SensorFieldClient(() =>
      stubWorker((request, self) => {
        if (request.type !== "draw") return;
        self.answer({
          type: "batch",
          id: request.id,
          geometries: [],
          maps: [{ kind: "map", index: 0, grid: new Float64Array(3) }],
        });
      }),
    );
    expect(await client.draw(input(mapsOf(1)))).toEqual({
      kind: "unavailable",
      reason: UNREADABLE_ANSWER,
    });
    client.terminate();
  });

  it("settles a running draw as cancelled on terminate, and ignores the dropped worker after", async () => {
    const stubs: StubWorker[] = [];
    const client = new SensorFieldClient(() => {
      if (stubs.length > 0) return inThreadWorker();
      // The first worker never answers.
      const stub = stubWorker(() => {});
      stubs.push(stub);
      return stub;
    });
    const running = client.draw(input(mapsOf(1)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stubs[0].requests).toHaveLength(1);
    client.terminate();
    expect(await running).toEqual({ kind: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stubs[0].terminated).toBe(true);
    const next = client.draw(input(mapsOf(1)));
    // A late error from the dropped worker settles nothing of the new one's.
    stubs[0].onerror?.(errorEvent("late"));
    const outcome = await next;
    client.terminate();
    expect(outcome.kind).toBe("done");
  });
});

describe("late events from a dropped worker (website#592)", () => {
  it("ignore a failure with no id and a messageerror, and the new worker's draws are unaffected", async () => {
    const stubs: StubWorker[] = [];
    const client = new SensorFieldClient(() => {
      if (stubs.length > 0) return inThreadWorker();
      const stub = stubWorker(() => {});
      stubs.push(stub);
      return stub;
    });
    const running = client.draw(input(mapsOf(1)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    client.terminate();
    expect(await running).toEqual({ kind: "cancelled" });
    const next = client.draw(input(mapsOf(3)));
    // Both arrive while the new worker draws: an unaddressed failure would settle every draw, and
    // a messageerror would end the worker, if the dropped worker's handlers still acted.
    stubs[0].answer({ type: "failure", id: null, message: "late" });
    stubs[0].onmessageerror?.(new MessageEvent("messageerror"));
    const outcome = await next;
    const again = await client.draw(input(mapsOf(1)));
    client.terminate();
    if (outcome.kind !== "done" || again.kind !== "done") throw new Error("a draw did not finish");
    expect(outcome.maps.map((m) => m.kind)).toEqual(["map", "map", "map"]);
    // The new worker kept its cache: the second draw found the layout's geometry.
    expect(again.stats.cacheHits).toBe(1);
  });
});

describe("warming the worker for the cold first view (website#592)", () => {
  it("prepares a layout's geometry so the view's draw finds it cached", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const layout = { layoutKey: LAYOUT_KEY, thetaDeg: THETA, radius: RADIUS };
    const first = await client.prepare(layout);
    const second = await client.prepare(layout);
    const drawn = await client.draw(input(mapsOf(2)));
    client.terminate();
    expect(first).toMatchObject({ kind: "prepared", cached: false });
    expect(second).toEqual({ kind: "prepared", geometryMs: 0, cached: true });
    if (drawn.kind !== "done") throw new Error(drawn.kind);
    expect([drawn.stats.cacheMisses, drawn.stats.cacheHits]).toEqual([0, 1]);
  });

  it("warms with a full-size throwaway draw on the layout, and the view draws as without it", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const warm = await client.warm({ layoutKey: LAYOUT_KEY, thetaDeg: THETA, radius: RADIUS });
    expect(warm.prepared.kind).toBe("prepared");
    if (warm.draw.kind !== "done") throw new Error(warm.draw.kind);
    expect(warm.draw.maps).toHaveLength(WARM_MAPS);
    expect(warm.draw.stats.cacheMisses).toBe(0);
    const maps = mapsOf(3);
    const outcome = await client.draw(input(maps));
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    maps.forEach((values, m) => {
      const map = outcome.maps[m];
      const core = sensorField(THETA, RADIUS, values);
      if (map.kind !== "map" || core.kind !== "map") throw new Error("a map was refused");
      expect(map.grid).toEqual(core.map.z);
    });
  });

  it("cancels a warm-up still running when the view's draw comes", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const warming = client.warm({ layoutKey: LAYOUT_KEY, thetaDeg: THETA, radius: RADIUS }, { maps: 512 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const outcome = await client.draw(input(mapsOf(2)));
    const warm = await warming;
    client.terminate();
    expect(outcome.kind).toBe("done");
    expect(warm.draw.kind).toBe("cancelled");
  });

  it("settles a warm-up as unavailable when the worker cannot start, and never rejects", async () => {
    const client = new SensorFieldClient(() => {
      throw new Error("no workers");
    });
    const warm = await client.warm({ layoutKey: LAYOUT_KEY, thetaDeg: THETA, radius: RADIUS });
    expect(warm.prepared).toEqual({
      kind: "unavailable",
      reason: "the map worker could not start: Error: no workers",
    });
    expect(warm.draw.kind).toBe("unavailable");
  });

  it("speaks the prepare request and its answer in the protocol", () => {
    const prepare = { type: "prepare", id: 1, layoutKey: "k", thetaDeg: THETA, radius: RADIUS };
    expect(requestProblem(prepare)).toBeNull();
    expect(requestProblem({ ...prepare, radius: new Float64Array(1) })).toBe(
      "thetaDeg and radius differ in length",
    );
    expect(isWorkerResponse({ type: "prepared", id: 1, geometryMs: 2, cached: false })).toBe(true);
    expect(isWorkerResponse({ type: "prepared", id: 1, geometryMs: 2 })).toBe(false);
  });

  it("gives a page one client, so the viewer and a panel share one worker", () => {
    expect(sharedSensorFieldClient()).toBe(sharedSensorFieldClient());
  });
});
