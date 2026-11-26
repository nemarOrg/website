/**
 * Geometries kept across visits (`src/lib/quality-views/geometry-store.ts`): a map drawn on a
 * geometry read back from storage is, bit for bit, the map drawn on one computed now, and storage
 * that fails never fails a draw.
 *
 * Node has no IndexedDB, so the visits here share a store that keeps each geometry as the bytes of
 * V8's serializer, the structured-clone format IndexedDB writes, and deserializes it on each read,
 * as IndexedDB does. The browser's own IndexedDB is exercised by `e2e/quality-views-perf.spec.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  GEOMETRY_VERSION,
  type GeometryStore,
  evictions,
  geometryKey,
} from "../src/lib/quality-views/geometry-store";
import {
  type SensorFieldGeometry,
  prepareSensorField,
  usableMask,
} from "../src/lib/quality-views/sensor-field";
import { inThreadWorker } from "../src/lib/quality-views/worker";
import { type MapResult, SensorFieldClient } from "../src/lib/quality-views/worker-client";
import { loadFieldVectors, numbers, serializedStore } from "./quality-views-vectors";

const field = await loadFieldVectors();

/** Deep equality with every number compared by `Object.is` (bit for bit, NaN equal to NaN). */
function identical(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof b === "number") return Object.is(a, b) ? null : `${path}: ${String(a)} != ${b}`;
  if (ArrayBuffer.isView(b)) {
    const x = a as unknown as ArrayLike<number>;
    const y = b as unknown as ArrayLike<number>;
    if (!ArrayBuffer.isView(a) || a.constructor !== b.constructor || x.length !== y.length) {
      return `${path}: not the same typed array`;
    }
    for (let i = 0; i < y.length; i++) if (!Object.is(x[i], y[i])) return `${path}[${i}]`;
    return null;
  }
  if (b === null || typeof b !== "object") return a === b ? null : `${path}: differs`;
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const key of keys) {
    const fault = identical(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      `${path}.${key}`,
    );
    if (fault) return fault;
  }
  return null;
}

const drawn = field.cases.filter((c) => c.expected && c.sensors.theta_deg);
const mapsOf = (c: (typeof drawn)[number]) => {
  const base = numbers(c.sensors.value);
  return [base, Float64Array.from(base, (v, s) => v * 0.5 + Math.sin(s))];
};

describe("a geometry read back from storage", () => {
  it("covers the drawn vector cases", () => expect(drawn.length).toBeGreaterThan(20));

  it.each(drawn.map((c) => [c.name, c] as const))(
    "%s: is the computed geometry, bit for bit",
    async (_n, c) => {
      const theta = numbers(c.sensors.theta_deg!);
      const radius = numbers(c.sensors.radius!);
      const usable = usableMask(theta, radius, numbers(c.sensors.value));
      const computed = prepareSensorField(theta, radius, usable);
      if (computed.kind !== "geometry") throw new Error(computed.kind);
      const store = await serializedStore();
      const key = await geometryKey("k", theta, radius, usable);
      await store.put(key, computed.geometry);
      const restored = await store.get(key);
      expect(identical(restored, computed.geometry)).toBeNull();
    },
  );

  it.each(drawn.map((c) => [c.name, c] as const))(
    "%s: draws the maps of a computed one, bit for bit, on a later visit",
    async (_n, c) => {
      const store = await serializedStore();
      const input = {
        layoutKey: c.name,
        thetaDeg: numbers(c.sensors.theta_deg!),
        radius: numbers(c.sensors.radius!),
        maps: mapsOf(c),
      };
      const first = new SensorFieldClient(() => inThreadWorker({ store }));
      const a = await first.draw(input);
      first.terminate();
      // Let the first visit's write land, then visit again with a new worker.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = new SensorFieldClient(() => inThreadWorker({ store }));
      const b = await second.draw(input);
      second.terminate();
      if (a.kind !== "done" || b.kind !== "done") throw new Error("a draw did not finish");
      expect(a.stats.storeHits).toBe(0);
      expect(b.stats.storeHits).toBeGreaterThan(0);
      expect(b.stats.cacheMisses).toBe(0);
      const grids = (maps: readonly MapResult[]) =>
        maps.map((m) => (m.kind === "map" ? m.grid : m.word));
      expect(identical(grids(b.maps), grids(a.maps))).toBeNull();
    },
  );
});

describe("storage that fails or misleads", () => {
  const c = field.cases.find((x) => x.name === "montage_64")!;
  const input = {
    layoutKey: "montage_64",
    thetaDeg: numbers(c.sensors.theta_deg!),
    radius: numbers(c.sensors.radius!),
    maps: mapsOf(c as never),
  };

  it("computes the geometry when every storage call throws", async () => {
    const broken: GeometryStore = {
      get: async () => {
        throw new Error("blocked");
      },
      put: async () => {
        throw new Error("blocked");
      },
    };
    const client = new SensorFieldClient(() => inThreadWorker({ store: broken }));
    const outcome = await client.draw(input);
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expect(outcome.stats.cacheMisses).toBe(1);
    expect(outcome.maps.every((m) => m.kind === "map")).toBe(true);
  });

  it("never uses a stored geometry of other places, whatever key it was found under", async () => {
    const store = await serializedStore();
    const other = prepareSensorField(
      Float64Array.from(input.thetaDeg, (t) => t + 1),
      input.radius,
      new Uint8Array(input.radius.length).fill(1),
    );
    if (other.kind !== "geometry") throw new Error(other.kind);
    const usable = new Uint8Array(input.radius.length).fill(1);
    await store.put(
      await geometryKey(input.layoutKey, input.thetaDeg, input.radius, usable),
      other.geometry,
    );
    const client = new SensorFieldClient(() => inThreadWorker({ store }));
    const outcome = await client.draw(input);
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expect(outcome.stats.storeHits).toBe(0);
    expect(outcome.stats.cacheMisses).toBe(1);
  });

  it("keys a geometry by the algorithm's version, the layout file and the exact places", async () => {
    const usable = new Uint8Array(input.radius.length).fill(1);
    const key = await geometryKey("a", input.thetaDeg, input.radius, usable);
    expect(key.startsWith(`${GEOMETRY_VERSION}|a|`)).toBe(true);
    const moved = Float64Array.from(input.radius);
    moved[3] += 2 ** -40;
    expect(await geometryKey("a", input.thetaDeg, moved, usable)).not.toBe(key);
    const fewer = Uint8Array.from(usable);
    fewer[0] = 0;
    expect(await geometryKey("a", input.thetaDeg, input.radius, fewer)).not.toBe(key);
    expect(await geometryKey("b", input.thetaDeg, input.radius, usable)).not.toBe(key);
  });

  it("keeps at most 16 layouts, dropping the least recently used", () => {
    const keys = Array.from({ length: 18 }, (_, i) => `k${i}`);
    const used = keys.map((_, i) => 100 - i);
    expect(evictions(keys, used, 16)).toEqual(["k17", "k16"]);
    expect(evictions(keys.slice(0, 16), used.slice(0, 16), 16)).toEqual([]);
  });
});
