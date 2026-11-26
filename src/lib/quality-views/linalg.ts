/**
 * Lower-upper (LU) decomposition with partial pivoting: the one solver the quality-view algorithms
 * name (neuroschema 0.6.0, `src/neuroschema/views/linalg.py`; nemar-cli ADR 0137, website ADR 0035).
 *
 * `nemar.sensor-field.v1` solves its interpolation matrix with it and `nemar.sensor-layout.v1` its
 * sphere fit, so every implementation eliminates in the same order with the same pivot rule. At
 * step k the pivot is the entry of largest magnitude in column k at or below the diagonal, the
 * first such row on a tie (and, as numpy's `argmax` does, the first NaN when there is one); the
 * rows are swapped, the rows below are eliminated, and the solution follows by back substitution.
 *
 * Every pivot is used as it is: an exactly zero pivot divides by zero and gives a solution that is
 * not finite, as IEEE 754 arithmetic does in any language. The caller checks for that; nothing here
 * throws on a singular matrix.
 *
 * The factors are kept so one matrix can be solved for many right-hand sides (the sensor-field
 * worker solves every map of a view against one factorization). Replaying the factors does to each
 * right-hand side exactly the operations the one-shot elimination does, in the same order, so a
 * cached solve and a fresh one give the same bits.
 */

/** A factorized n-by-n matrix, ready to solve for any right-hand side. */
export interface LuFactors {
  readonly n: number;
  /**
   * Row-major, n by n. On and above the diagonal: U. Below it, at (i, k): the factor step k
   * multiplied row k by before subtracting it from the row then at position i. A later step swaps
   * only the columns from its own index on, so each factor stays where its step wrote it.
   */
  readonly lu: Float64Array;
  /** `pivots[k]`: the row swapped with row k at step k (k itself when none was). */
  readonly pivots: Int32Array;
}

/**
 * Eliminate column `k` below the diagonal: each row below minus its factor times the pivot row,
 * four rows per pass over the pivot row. Each entry gets the same one operation, in the same step
 * order, as row by row, so the factors are the same to the bit. A function of its own, so the
 * engine optimizes it after its first calls, within a page's first map.
 */
function eliminateBelow(lu: Float64Array, k: number, n: number, diagonal: number): void {
  const pivotRow = k * n;
  let i = k + 1;
  for (; i + 3 < n; i += 4) {
    const r0 = i * n;
    const r1 = r0 + n;
    const r2 = r1 + n;
    const r3 = r2 + n;
    const f0 = lu[r0 + k] / diagonal;
    const f1 = lu[r1 + k] / diagonal;
    const f2 = lu[r2 + k] / diagonal;
    const f3 = lu[r3 + k] / diagonal;
    lu[r0 + k] = f0;
    lu[r1 + k] = f1;
    lu[r2 + k] = f2;
    lu[r3 + k] = f3;
    for (let j = k + 1; j < n; j++) {
      const p = lu[pivotRow + j];
      lu[r0 + j] -= f0 * p;
      lu[r1 + j] -= f1 * p;
      lu[r2 + j] -= f2 * p;
      lu[r3 + j] -= f3 * p;
    }
  }
  for (; i < n; i++) {
    const row = i * n;
    const factor = lu[row + k] / diagonal;
    lu[row + k] = factor;
    for (let j = k + 1; j < n; j++) lu[row + j] -= factor * lu[pivotRow + j];
  }
}

/**
 * Factorize the n-by-n matrix `a`, given row-major (`a[i * n + j]`). `a` is not changed.
 * Throws a `RangeError` when `a` does not hold n * n numbers: a caller's mistake, not a matrix.
 */
export function luFactor(a: ArrayLike<number>, n: number): LuFactors {
  if (!Number.isInteger(n) || n < 0 || a.length !== n * n) {
    throw new RangeError(`luFactor: ${a.length} entries for a ${n}-by-${n} matrix`);
  }
  const lu = Float64Array.from(a);
  const pivots = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    let pivot = k;
    let best = Math.abs(lu[k * n + k]);
    if (!Number.isNaN(best)) {
      for (let i = k + 1; i < n; i++) {
        const magnitude = Math.abs(lu[i * n + k]);
        if (Number.isNaN(magnitude)) {
          pivot = i;
          break;
        }
        if (magnitude > best) {
          best = magnitude;
          pivot = i;
        }
      }
    }
    pivots[k] = pivot;
    if (pivot !== k) {
      const top = k * n;
      const other = pivot * n;
      for (let j = k; j < n; j++) {
        const held = lu[top + j];
        lu[top + j] = lu[other + j];
        lu[other + j] = held;
      }
    }
    eliminateBelow(lu, k, n, lu[k * n + k]);
  }
  return { n, lu, pivots };
}

/** Solve `a w = b` for a factorized `a`. `b` is not changed. */
export function luSolveFactored(factors: LuFactors, b: ArrayLike<number>): Float64Array {
  const { n, lu, pivots } = factors;
  if (b.length !== n) {
    throw new RangeError(`luSolve: ${b.length} values for a ${n}-by-${n} matrix`);
  }
  const y = Float64Array.from(b);
  for (let k = 0; k < n; k++) {
    const pivot = pivots[k];
    if (pivot !== k) {
      const held = y[k];
      y[k] = y[pivot];
      y[pivot] = held;
    }
    const yk = y[k];
    for (let i = k + 1; i < n; i++) y[i] -= lu[i * n + k] * yk;
  }
  const w = new Float64Array(n);
  for (let k = n - 1; k >= 0; k--) {
    const row = k * n;
    let dot = 0;
    for (let j = k + 1; j < n; j++) dot += lu[row + j] * w[j];
    w[k] = (y[k] - dot) / lu[row + k];
  }
  return w;
}

/** Solve `a w = b` once: `luSolveFactored(luFactor(a, n), b)`. */
export function luSolve(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  return luSolveFactored(luFactor(a, b.length), b);
}
