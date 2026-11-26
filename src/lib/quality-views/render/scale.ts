/**
 * Where a stored value sits between two others, without overflow: the difference of two finite
 * binary64 values can be infinite (1e308 and -1e308), which would put a NaN into an SVG coordinate.
 * Computed on halved operands, as the color maps' `entryFor` is, and 0.5 when the span is empty.
 */

/** `(v - low) / (high - low)`, finite for finite operands. */
export function fraction(v: number, low: number, high: number): number {
  const span = high / 2 - low / 2;
  if (!(span > 0)) return 0.5;
  const t = (v / 2 - low / 2) / span;
  return Number.isFinite(t) ? t : 0.5;
}

/** The value at fraction `t` of the way from `low` to `high`, finite for finite operands. */
export function lerp(t: number, low: number, high: number): number {
  const v = 2 * (low / 2 + t * (high / 2 - low / 2));
  return Number.isFinite(v) ? v : t < 0.5 ? low : high;
}
