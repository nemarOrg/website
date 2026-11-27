/**
 * The faster geometry stays bit-identical: the interpolation matrix G, built by the row function
 * the evaluation matrix shares, has the factors of G built entry by entry with its zero diagonal,
 * on every drawn vector case (the LU's own bit test is in `linalg.test.ts`).
 */

import { describe, expect, it } from "vitest";
import { luFactor } from "../src/lib/quality-views/linalg";
import { green, prepareSensorField, usableMask } from "../src/lib/quality-views/sensor-field";
import { loadFieldVectors, numbers } from "./quality-views-vectors";

const field = await loadFieldVectors();
const drawn = field.cases.filter((c) => c.expected && c.sensors.theta_deg);

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

describe("the interpolation matrix", () => {
  it.each(drawn.map((c) => [c.name, c] as const))(
    "%s: is G[a][b] = g(|p_a - p_b|) with a zero diagonal, to the bit, before factorizing",
    (_n, c) => {
      const theta = numbers(c.sensors.theta_deg!);
      const radius = numbers(c.sensors.radius!);
      const built = prepareSensorField(
        theta,
        radius,
        usableMask(theta, radius, numbers(c.sensors.value)),
      );
      if (built.kind !== "geometry") throw new Error(built.kind);
      const { px, py } = built.geometry;
      const k = px.length;
      const g = new Float64Array(k * k);
      for (let a = 0; a < k; a++) {
        for (let b = 0; b < k; b++) {
          const dx = px[a] - px[b];
          const dy = py[a] - py[b];
          g[a * k + b] = a === b ? 0 : green(dx * dx + dy * dy);
        }
      }
      expect(identical(built.geometry.factors.lu, luFactor(g, k).lu)).toBeNull();
    },
  );
});
