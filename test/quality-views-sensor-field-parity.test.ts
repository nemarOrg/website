/**
 * `nemar.sensor-field.v1` parity: this site's scalp map against every case of neuroschema 0.6.0's
 * `views/vectors/sensor-field.v1.json` (nemar-cli ADR 0137 decision 3 and its amendment of
 * 2026-11-24; website ADR 0035 decisions 1 and 5; website#588 phase W2).
 *
 * A case matches when, by `docs/views/sensor-field.md`'s "Parity" section: a refused case is
 * refused with the same word, and a drawn one has the same mask, every unmasked cell within
 * `1e-6 * range + 1e-12 * magnitude` of the reference (a map of zeros compared exactly), the radii,
 * grid axes, value range and head within a relative 1e-12, the limits, color axes and contour
 * levels within the cells' bound, and the same plotted, interpolated and merged sensors and notes.
 * Cases placed by 3D positions are projected by `nemar.sensor-layout.v1` first and their layout is
 * compared too.
 */

import { describe, expect, it } from "vitest";
import {
  type SensorFieldGeometry,
  drawSensorFields,
  prepareSensorField,
  sensorField,
  usableMask,
} from "../src/lib/quality-views/sensor-field";
import {
  compareFieldCase,
  loadFieldVectors,
  loadLayoutVectors,
  montageCentersFromFiles,
  numbers,
} from "./quality-views-vectors";

const field = await loadFieldVectors();
const layoutVectors = await loadLayoutVectors();
const centers = await montageCentersFromFiles();
const byName = new Map(field.cases.map((c) => [c.name, c]));

describe("the sensor-field vectors", () => {
  it("are the format, grid and tolerance this implementation reads", () => {
    expect(field.format).toBe("nemar.sensor-field.v1");
    expect(field.grid_size).toBe(67);
    expect(field.tolerance).toEqual({
      cells_relative_to_range: 1e-6,
      cells_relative_to_magnitude: 1e-12,
      geometry_relative: 1e-12,
    });
  });

  it("refuse with exactly the words the specification names", () => {
    const words = new Set(field.cases.flatMap((c) => (c.refused ? [c.refused] : [])));
    expect([...words].sort()).toEqual([
      "frame_unknown",
      "head_outside_grid",
      "interpolation_failed",
      "positions_flat",
      "too_few_sensors",
    ]);
  });

  it("cover 32, 64, 128 and 256 sensors", () => {
    const counts = new Set(field.cases.map((c) => c.sensors.name.length));
    for (const count of [32, 64, 128, 256]) expect(counts.has(count), String(count)).toBe(true);
  });
});

describe("nemar.sensor-field.v1 parity", () => {
  it.each(field.cases.map((c) => [c.name, c] as const))("%s", (_name, vectorCase) => {
    const comparison = compareFieldCase(field, vectorCase, centers, layoutVectors);
    expect(comparison.problems).toEqual([]);
  });
});

describe("one geometry, many maps", () => {
  const vectorCase = byName.get("montage_64")!;
  const theta = numbers(vectorCase.sensors.theta_deg!);
  const radius = numbers(vectorCase.sensors.radius!);
  const base = numbers(vectorCase.sensors.value);
  // Six maps: one pass of four and two on their own, so both evaluation paths run.
  const maps = [1, -2, 0.5, 3, -7, 11].map((scale, m) =>
    Float64Array.from(base, (v, row) => scale * v + ((row * (m + 1)) % 5)),
  );

  it("draws each map bit for bit as the one-shot form does", () => {
    const prepared = prepareSensorField(theta, radius, usableMask(theta, radius, maps[0]));
    expect(prepared.kind).toBe("geometry");
    const geometry = (prepared as { geometry: SensorFieldGeometry }).geometry;
    const batch = drawSensorFields(geometry, maps);
    maps.forEach((values, m) => {
      const single = sensorField(theta, radius, values);
      const drawn = batch[m];
      if (single.kind !== "map" || drawn.kind !== "map") {
        throw new Error(`map ${m} was refused: ${JSON.stringify([single.kind, drawn.kind])}`);
      }
      expect(Array.from(drawn.map.z)).toEqual(Array.from(single.map.z));
      expect(drawn.map.contours).toEqual(single.map.contours);
    });
  });

  it("refuses a map whose usable sensors are not the geometry's: the caller groups by mask", () => {
    const prepared = prepareSensorField(theta, radius, usableMask(theta, radius, base));
    if (prepared.kind !== "geometry") throw new Error("expected a geometry");
    const withNaN = Float64Array.from(base);
    withNaN[3] = Number.NaN;
    expect(() => drawSensorFields(prepared.geometry, [withNaN])).toThrow(RangeError);
  });
});
