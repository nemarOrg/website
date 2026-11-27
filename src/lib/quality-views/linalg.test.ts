import { describe, expect, it } from "vitest";
import { luFactor, luSolve, luSolveFactored } from "./linalg";

describe("luSolve", () => {
  it("solves a system that needs a row swap", () => {
    // A zero on the diagonal: without pivoting this divides by zero.
    expect(Array.from(luSolve([0, 1, 1, 1], [4, 5]))).toEqual([1, 4]);
    expect(Array.from(luFactor([0, 1, 1, 1], 2).pivots)).toEqual([1, 1]);
  });

  it("pivots on the largest magnitude, the first row on a tie", () => {
    // Column 0 holds 1, -3 and 3: row 1 wins the tie. Then 1/3 against 1 in column 1: row 2.
    expect(Array.from(luFactor([1, 0, 0, -3, 1, 0, 3, 0, 1], 3).pivots)).toEqual([1, 2, 2]);
  });

  it("matches the exact solution of a well-conditioned system", () => {
    const a = [4, -2, 1, -2, 4, -2, 1, -2, 4];
    const x = [1, -2, 3];
    const b = [0, 1, 2].map((i) => a[i * 3] * x[0] + a[i * 3 + 1] * x[1] + a[i * 3 + 2] * x[2]);
    const w = luSolve(a, b);
    for (let i = 0; i < 3; i++) expect(w[i]).toBeCloseTo(x[i], 14);
  });

  it("solves many right-hand sides on one factorization bit for bit as a fresh solve", () => {
    const n = 12;
    const a = Array.from(
      { length: n * n },
      (_, k) => Math.sin(k * 1.7) + (k % (n + 1) === 0 ? 3 : 0),
    );
    const factors = luFactor(a, n);
    for (let r = 0; r < 4; r++) {
      const b = Array.from({ length: n }, (_, i) => Math.cos(i + r));
      expect(Array.from(luSolveFactored(factors, b))).toEqual(Array.from(luSolve(a, b)));
    }
  });

  it("lets an exactly zero pivot divide: the weights are not finite, and nothing throws", () => {
    const w = luSolve([1, 2, 2, 4], [1, 1]);
    expect(w.some((v) => !Number.isFinite(v))).toBe(true);
  });

  it("leaves its inputs unchanged", () => {
    const a = [2, 1, 1, 3];
    const b = [1, 2];
    luSolve(a, b);
    expect(a).toEqual([2, 1, 1, 3]);
    expect(b).toEqual([1, 2]);
  });

  it("refuses shapes that do not fit, as a caller's mistake", () => {
    expect(() => luFactor([1, 2, 3], 2)).toThrow(RangeError);
    expect(() => luSolve([1, 0, 0, 1], [1, 2, 3])).toThrow(RangeError);
  });
});

describe("the LU factorization, four rows per pass", () => {
  /** The row-by-row elimination it replaced. */
  function reference(a: Float64Array, n: number): Float64Array {
    const lu = Float64Array.from(a);
    for (let k = 0; k < n; k++) {
      let pivot = k;
      let best = Math.abs(lu[k * n + k]);
      for (let i = k + 1; i < n; i++) {
        const m = Math.abs(lu[i * n + k]);
        if (m > best) {
          best = m;
          pivot = i;
        }
      }
      if (pivot !== k) {
        for (let j = k; j < n; j++) {
          const t = lu[k * n + j];
          lu[k * n + j] = lu[pivot * n + j];
          lu[pivot * n + j] = t;
        }
      }
      const d = lu[k * n + k];
      for (let i = k + 1; i < n; i++) {
        const f = lu[i * n + k] / d;
        lu[i * n + k] = f;
        for (let j = k + 1; j < n; j++) lu[i * n + j] -= f * lu[k * n + j];
      }
    }
    return lu;
  }

  it.each([1, 2, 3, 7, 8, 33, 128, 257])("n = %i: the same factors to the bit", (n) => {
    const a = Float64Array.from(
      { length: n * n },
      (_, i) => Math.sin(i * 1.7 + n) * 10 ** ((i % 7) - 3),
    );
    const got = luFactor(a, n).lu;
    const want = reference(a, n);
    expect(got.length).toBe(want.length);
    for (let i = 0; i < want.length; i++)
      expect(Object.is(got[i], want[i]), `entry ${i}`).toBe(true);
  });
});
