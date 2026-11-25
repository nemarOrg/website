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
