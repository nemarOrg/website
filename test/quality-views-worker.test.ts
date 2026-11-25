/**
 * The sensor-field worker and its client (website ADR 0035 decision 1; website#588 phase W2).
 *
 * The client drives the real worker handler on this thread through `inThreadWorker()`: a real
 * `MessageChannel`, so every request and answer is structured-cloned and every grid transferred, as
 * between a page and a module worker. Nothing is stubbed but the one malformed answer below, which
 * tests the client's guard as an HTTP fixture tests a client's error path.
 */

import { describe, expect, it } from "vitest";
import { GRID_SIZE, type SensorFieldMap, sensorField } from "../src/lib/quality-views/sensor-field";
import {
  type WorkerLike,
  createSensorFieldHandler,
  drawOrder,
  inThreadWorker,
} from "../src/lib/quality-views/worker";
import { type DrawInput, SensorFieldClient } from "../src/lib/quality-views/worker-client";
import {
  type DrawRequest,
  GRID_CELLS,
  type MapMessage,
  type WorkerResponse,
} from "../src/lib/quality-views/worker-protocol";
import { loadFieldVectors, numbers } from "./quality-views-vectors";

const field = await loadFieldVectors();
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

function expectSameMap(message: MapMessage, map: SensorFieldMap): void {
  if (message.kind !== "map") throw new Error(`refused: ${message.word}`);
  expect(Array.from(message.grid)).toEqual(Array.from(Float32Array.from(map.z)));
  expect(message.limits).toEqual({
    absmax: [...map.limits.absmax],
    minmax: [...map.limits.minmax],
  });
  expect(message.contourLevels).toEqual(map.contours);
  expect(message.notes).toEqual(map.notes);
  expect(message.geometry.plotted).toEqual(map.geometry.plotted);
  expect(message.geometry.interpolated).toEqual(map.geometry.interpolated);
  expect(Array.from(message.geometry.x)).toEqual(Array.from(map.geometry.x));
}

describe("the protocol", () => {
  it("repeats the algorithm's grid size", () => {
    expect(GRID_CELLS).toBe(GRID_SIZE * GRID_SIZE);
  });

  it("draws the maps asked for first, then the rest by index, each once", () => {
    expect(drawOrder(6, [5, 2, 5])).toEqual([5, 2, 0, 1, 3, 4]);
    expect(drawOrder(3, [])).toEqual([0, 1, 2]);
  });
});

describe("drawing through the worker", () => {
  it("draws every map as the core does, the grids as Float32 with the same mask", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const maps = mapsOf(6);
    const outcome = await client.draw(input(maps));
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expect(outcome.maps).toHaveLength(6);
    maps.forEach((values, m) => expectSameMap(outcome.maps[m], core(values)));
    const first = outcome.maps[0];
    if (first.kind !== "map") throw new Error("refused");
    expect(first.contourLines).toHaveLength(6);
    expect(first.contourLines![0].length % 4).toBe(0);
  });

  it("sends the maps on screen in the first batch, then the rest in batches", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const batches: number[][] = [];
    const outcome = await client.draw(input(mapsOf(6)), {
      first: [5, 2],
      batchSize: 2,
      onBatch: (maps) => batches.push(maps.map((m) => m.index)),
    });
    client.terminate();
    expect(outcome.kind).toBe("done");
    expect(batches).toEqual([
      [5, 2],
      [0, 1],
      [3, 4],
    ]);
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
        batchSize: 1,
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

  it("settles a draw aborted by the page as cancelled", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const controller = new AbortController();
    const outcome = await client.draw(input(mapsOf(6)), {
      batchSize: 1,
      signal: controller.signal,
      onBatch: () => controller.abort(),
    });
    expect(outcome).toEqual({ kind: "cancelled" });
    // The worker is still usable for the next view.
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
  function request(id: number, mapCount: number, batchSize: number): DrawRequest {
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
      batchSize,
      contours: false,
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
    expect(posted).toEqual([
      { type: "failure", id: 3, message: "thetaDeg and radius are not Float64Arrays" },
      { type: "failure", id: null, message: "the message is not an object" },
      { type: "failure", id: 4, message: "values does not hold one value per sensor per map" },
    ]);
  });
});

describe("the client's guard", () => {
  it("settles as unavailable when the worker answers in a shape it cannot read", async () => {
    // A worker end that answers every request with a batch whose grid is the wrong size.
    const channel = new MessageChannel();
    channel.port2.onmessage = (event) =>
      channel.port2.postMessage({
        type: "batch",
        id: (event.data as { id: number }).id,
        maps: [{ kind: "map", index: 0, grid: new Float32Array(3) }],
      });
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
    const outcome = await client.draw(input(mapsOf(1)));
    client.terminate();
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: "the map worker sent an answer this page cannot read",
    });
  });
});
