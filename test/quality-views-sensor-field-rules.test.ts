/**
 * The rules of `nemar.sensor-field.v1` that neuroschema 0.6.0 and nemar-cli ADR 0137's amendment of
 * 2026-11-24 add to eegprep's map, each checked on its own beside the vector replay: the mean is
 * removed before interpolation and added back, merged sensors take their exact mean, a near-flat
 * field is one color at its mean, a map needs 8 interpolated sensors, and the `minmax` axis widens
 * by 5% of the range. The layout is the 64-sensor cap of the vectors (`montage_64`), real-shape
 * input; the values are built per rule.
 */

import { describe, expect, it } from "vitest";
import {
  COLOR_MARGIN,
  GRID_SIZE,
  MIN_SENSORS,
  NEAR_FLAT,
  type SensorFieldMap,
  type SensorFieldResult,
  center,
  green,
  gridAxis,
  headOutline,
  sensorField,
} from "../src/lib/quality-views/sensor-field";
import { loadFieldVectors, numbers } from "./quality-views-vectors";

const field = await loadFieldVectors();
const cap = field.cases.find((c) => c.name === "montage_64")!;
const THETA = numbers(cap.sensors.theta_deg!);
const RADIUS = numbers(cap.sensors.radius!);
const VALUES = numbers(cap.sensors.value);

function drawn(result: SensorFieldResult): SensorFieldMap {
  if (result.kind !== "map") throw new Error(`refused: ${result.word} (${result.detail})`);
  return result.map;
}

/** The largest difference between two maps' unmasked cells, and their mask agreement. */
function compareCells(a: SensorFieldMap, b: SensorFieldMap, shift = 0): number {
  let worst = 0;
  for (let cell = 0; cell < GRID_SIZE * GRID_SIZE; cell++) {
    expect(Number.isNaN(a.z[cell])).toBe(Number.isNaN(b.z[cell]));
    if (!Number.isNaN(a.z[cell])) worst = Math.max(worst, Math.abs(a.z[cell] - shift - b.z[cell]));
  }
  return worst;
}

function range(map: SensorFieldMap): number {
  return map.limits.minmax[1] - map.limits.minmax[0];
}

describe("the mean is removed before interpolation and added back", () => {
  const plain = drawn(sensorField(THETA, RADIUS, VALUES));

  it.each([1e3, -110, 1e6])("a shared offset of %s moves the map and nothing else", (offset) => {
    const moved = drawn(
      sensorField(
        THETA,
        RADIUS,
        VALUES.map((v) => v + offset),
      ),
    );
    expect(compareCells(moved, plain, offset)).toBeLessThanOrEqual(
      1e-6 * range(plain) + 1e-12 * Math.abs(offset),
    );
    expect(moved.contours.map((level) => level - offset)).toEqual(
      plain.contours.map((level) => expect.closeTo(level, 6)),
    );
  });

  it("draws a flat field at its value, exactly, in every cell, with no contours", () => {
    for (const value of [42, -1.5e300, 0]) {
      const map = drawn(
        sensorField(
          THETA,
          RADIUS,
          VALUES.map(() => value),
        ),
      );
      for (const cell of map.geometry.inside) expect(map.z[cell]).toBe(value);
      expect(map.notes).toEqual(["flat_field"]);
      expect(map.contours).toEqual([]);
    }
  });
});

describe("merged sensors take their exact mean", () => {
  // Two sensors added at sensor 0's place: 0, 64 and 65 merge, in row order, at their mean.
  const theta = Float64Array.from([...THETA, THETA[0], THETA[0]]);
  const radius = Float64Array.from([...RADIUS, RADIUS[0], RADIUS[0] + 5e-4]);

  it("draws the map of the merged mean, bit for bit", () => {
    const members = [VALUES[0], VALUES[0] + 3, VALUES[0] - 7.5];
    const merged = drawn(
      sensorField(theta, radius, Float64Array.from([...VALUES, ...members.slice(1)])),
    );
    expect(merged.geometry.merged).toEqual([[0, 64, 65]]);
    const alone = Float64Array.from(VALUES);
    alone[0] = center(members);
    const single = drawn(sensorField(THETA, RADIUS, alone));
    expect(Array.from(merged.z)).toEqual(Array.from(single.z));
  });

  it("computes the mean as first + sum(x - first) / k, so equal values give themselves", () => {
    expect(center([0.1, 0.1, 0.1])).toBe(0.1);
    expect(center([1.5e308, 1.5e308])).toBe(1.5e308);
    expect(center([1, 2, 4])).toBe(1 + (0 + 1 + 3) / 3);
    expect(Object.is(center([-0, -0]), 0)).toBe(true);
  });

  it("does not overflow on a duplicate pair near the binary64 limit", () => {
    const values = Float64Array.from([...VALUES.map(() => 1.5e308), 1.5e308, 1.5e308]);
    const map = drawn(sensorField(theta, radius, values));
    expect(map.notes).toEqual(["flat_field"]);
    for (const cell of map.geometry.inside) expect(map.z[cell]).toBe(1.5e308);
  });
});

describe("a near-flat field is one color at its mean", () => {
  // Values 1024 and 1024 - r: the range r against 1e-9 of the magnitude, 1024.
  const at = (r: number) =>
    drawn(
      sensorField(
        THETA,
        RADIUS,
        VALUES.map((v) => (v > 0 ? 1024 : 1024 - r)),
      ),
    );

  it("at a range of at most 1e-9 of the magnitude", () => {
    const r = 2 ** -20;
    expect(r).toBeLessThanOrEqual(NEAR_FLAT * 1024);
    const map = at(r);
    expect(map.notes).toEqual(["near_flat"]);
    expect(map.valueRange).toBe(r);
    for (const cell of map.geometry.inside) expect(map.z[cell]).toBe(map.mean);
    expect(map.contours).toEqual([]);
  });

  it("at a range of exactly 1e-9 of the magnitude, the bound itself", () => {
    // 976562.5 and 976562.4990234375 differ by 2^-10, which is NEAR_FLAT * 976562.5 to the bit.
    const high = 976562.5;
    const low = 976562.4990234375;
    expect(high - low).toBe(NEAR_FLAT * high);
    const map = drawn(
      sensorField(
        THETA,
        RADIUS,
        VALUES.map((v) => (v > 0 ? high : low)),
      ),
    );
    expect(map.notes).toEqual(["near_flat"]);
  });

  it("but drawn as any map just above it", () => {
    const r = 2 ** -19;
    expect(r).toBeGreaterThan(NEAR_FLAT * 1024);
    const map = at(r);
    expect(map.notes).toEqual([]);
    expect(map.contours).toHaveLength(6);
  });
});

describe("a map needs 8 interpolated sensors", () => {
  it("draws 8 and refuses 7 with too_few_sensors", () => {
    expect(MIN_SENSORS).toBe(8);
    expect(sensorField(THETA.slice(0, 8), RADIUS.slice(0, 8), VALUES.slice(0, 8)).kind).toBe("map");
    expect(sensorField(THETA.slice(0, 7), RADIUS.slice(0, 7), VALUES.slice(0, 7))).toMatchObject({
      kind: "refused",
      word: "too_few_sensors",
    });
  });

  it("counts after the merge: 8 rows that merge to 7 are refused", () => {
    const theta = Float64Array.from([...THETA.slice(0, 7), THETA[0]]);
    const radius = Float64Array.from([...RADIUS.slice(0, 7), RADIUS[0]]);
    expect(sensorField(theta, radius, VALUES.slice(0, 8))).toMatchObject({
      word: "too_few_sensors",
    });
  });

  it("counts after dropping values that are not finite", () => {
    const values = Float64Array.from(VALUES.slice(0, 8));
    values[2] = Number.NaN;
    expect(sensorField(THETA.slice(0, 8), RADIUS.slice(0, 8), values)).toMatchObject({
      word: "too_few_sensors",
    });
  });
});

describe("the color axis", () => {
  // A map of one sign, as a spectrum's decibels are.
  const decibels = drawn(
    sensorField(
      THETA,
      RADIUS,
      VALUES.map((v) => 30 + v / 2),
    ),
  );

  it("widens minmax by 5% of the range on each side, so no cell of a one-sign map is clipped", () => {
    const [low, high] = decibels.limits.minmax;
    expect(low).toBeGreaterThan(0);
    const span = high - low;
    expect(decibels.colorAxis.minmax).toEqual([
      low - COLOR_MARGIN * span,
      high + COLOR_MARGIN * span,
    ]);
    for (const cell of decibels.geometry.inside) {
      expect(decibels.z[cell]).toBeGreaterThan(decibels.colorAxis.minmax[0]);
      expect(decibels.z[cell]).toBeLessThan(decibels.colorAxis.minmax[1]);
    }
  });

  it("widens absmax by 5% of each limit's magnitude, as EEGLAB's caxis does", () => {
    const top = decibels.limits.absmax[1];
    expect(decibels.limits.absmax).toEqual([-top, top]);
    expect(decibels.colorAxis.absmax[0]).toBeCloseTo(-1.05 * top, 12);
    expect(decibels.colorAxis.absmax[1]).toBeCloseTo(1.05 * top, 12);
  });

  it("puts six contour levels evenly inside the cells' range", () => {
    const [low, high] = decibels.limits.minmax;
    const step = (high - low) / 7;
    expect(decibels.contours).toEqual([1, 2, 3, 4, 5, 6].map((k) => k * step + low));
  });
});

describe("the grid and the head", () => {
  it("ends each axis on its upper limit exactly", () => {
    const axis = gridAxis(-0.5, 0.7);
    expect(axis).toHaveLength(GRID_SIZE);
    expect(axis[0]).toBe(-0.5);
    expect(axis[GRID_SIZE - 1]).toBe(0.7);
  });

  it("has g(0) = 0 and d^2 (ln d - 1) elsewhere", () => {
    expect(green(0)).toBe(0);
    expect(green(4)).toBeCloseTo(4 * (Math.log(2) - 1), 14);
  });

  it("draws EEGLAB's head on the equator, squeezed as the sensors are", () => {
    const head = headOutline(0.5);
    expect(head.radius).toBe(0.25);
    expect(head.nose[2]).toEqual([0.2875, 0]);
    expect(head.leftEar[0]).toEqual([0.0955 * 0.5, -0.492 * 0.5]);
  });
});
