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

/**
 * How a number is printed on a drawing (an axis tick, a legend, a map's range): a stored text
 * carried at the full precision of binary64 (`-29.811042743271745`) is unreadable there and does
 * not fit the axis margin, so such a text is rounded to the precision the drawing's span warrants.
 * The readouts, the data tables and the downloads print the stored texts unchanged.
 */

/** Significant digits of the span a label keeps, and that a stored text may carry as stored. */
export const LABEL_DIGITS = 3;

/** Significant digits a stored decimal text carries (`-0.0120` carries 3, `8.8E1` carries 2). */
export function significantDigits(text: string): number {
  const mantissa = text.replace(/^[+-]/, "").replace(/[eE].*$/, "");
  const digits = mantissa.replace(".", "").replace(/^0+/, "");
  return digits === "" ? 1 : digits.length;
}

/** Significant digits a rounded label never exceeds: a span far smaller than the value (a map
 *  that is nearly flat) prints the value's shortest form at this precision instead. */
const MAX_LABEL_DIGITS = 6;

/**
 * `value` rounded to `LABEL_DIGITS` significant digits of `span` (the width of the axis or of the
 * range printed beside it; the value's own magnitude when the span is empty): `-29.8` on a span of
 * 48.6, `3.48` on a span of 6.95. Very large and very small magnitudes print in exponent form, and
 * no label carries more than `MAX_LABEL_DIGITS` significant digits. Never `-0`.
 */
export function roundedText(value: number, span: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const scale = Number.isFinite(span) && span > 0 ? span : Math.abs(value);
  const own = Math.floor(Math.log10(Math.abs(value)));
  const magnitude = Math.floor(Math.log10(scale));
  const digits = own - magnitude + LABEL_DIGITS;
  if (digits > MAX_LABEL_DIGITS) return String(Number(value.toPrecision(MAX_LABEL_DIGITS)) + 0);
  const top = Math.max(own, magnitude);
  const text =
    top >= 6 || magnitude <= -4
      ? value.toExponential(Math.max(digits - 1, 0))
      : value.toFixed(Math.max(LABEL_DIGITS - 1 - magnitude, 0));
  return Number(text) === 0 ? text.replace(/^-/, "") : text;
}

/** A stored text as a drawing prints it: as stored when it carries no more than `LABEL_DIGITS`
 *  significant digits plus one, else `roundedText` of its value on `span`. */
export function labelText(stored: string, value: number, span: number): string {
  return significantDigits(stored) <= LABEL_DIGITS + 1 ? stored : roundedText(value, span);
}
