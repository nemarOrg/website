/**
 * Client-side display filters (website#99, P1). Zero-phase biquad `filtfilt`
 * high-pass / low-pass / notch, adapted from the RBJ audio-EQ cookbook and the
 * eegdash viewer. Display-only (MNE discipline): filters never touch the stored
 * data, only the level-0 samples we render. Pure + unit-tested.
 *
 * Filters must be applied to the actual samples (level-0), not the min/max view
 * envelope (which is a nonlinear summary), so the viewer reads level-0 for the
 * visible window when any filter is on.
 */

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface FilterSpec {
  /** High-pass cutoff in Hz (removes drift/DC), or null/0 for off. */
  hp?: number | null;
  /** Low-pass cutoff in Hz (smooths high-frequency), or null/0 for off. */
  lp?: number | null;
  /** Notch center in Hz (line noise, 50/60), or null/0 for off. */
  notch?: number | null;
}

const Q = Math.SQRT1_2; // Butterworth-ish for HP/LP
const NOTCH_Q = 30; // narrow line-noise notch

function lowpass(fc: number, fs: number): Biquad {
  const w = (2 * Math.PI * fc) / fs;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cw) / 2 / a0,
    b1: (1 - cw) / a0,
    b2: (1 - cw) / 2 / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

function highpass(fc: number, fs: number): Biquad {
  const w = (2 * Math.PI * fc) / fs;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cw) / 2 / a0,
    b1: -(1 + cw) / a0,
    b2: (1 + cw) / 2 / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

function notchFilter(fc: number, fs: number): Biquad {
  const w = (2 * Math.PI * fc) / fs;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * NOTCH_Q);
  const a0 = 1 + alpha;
  return {
    b0: 1 / a0,
    b1: (-2 * cw) / a0,
    b2: 1 / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** True when the spec requests at least one filter. */
export function hasFilters(spec: FilterSpec): boolean {
  return (spec.hp ?? 0) > 0 || (spec.lp ?? 0) > 0 || (spec.notch ?? 0) > 0;
}

/** Build the biquad cascade for a spec at sample rate `fs` (cutoffs above the
 *  Nyquist are dropped). */
export function designFilters(spec: FilterSpec, fs: number): Biquad[] {
  const nyq = fs / 2;
  const out: Biquad[] = [];
  if ((spec.hp ?? 0) > 0 && (spec.hp as number) < nyq) out.push(highpass(spec.hp as number, fs));
  if ((spec.lp ?? 0) > 0 && (spec.lp as number) < nyq) out.push(lowpass(spec.lp as number, fs));
  if ((spec.notch ?? 0) > 0 && (spec.notch as number) < nyq)
    out.push(notchFilter(spec.notch as number, fs));
  return out;
}

/** One forward Direct-Form-I biquad pass. */
function forward(x: Float32Array, bq: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xn = x[i];
    const yn = bq.b0 * xn + bq.b1 * x1 + bq.b2 * x2 - bq.a1 * y1 - bq.a2 * y2;
    x2 = x1;
    x1 = xn;
    y2 = y1;
    y1 = yn;
    y[i] = yn;
  }
  return y;
}

function reversed(x: Float32Array): Float32Array {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[x.length - 1 - i];
  return y;
}

/**
 * Zero-phase filtering: apply each biquad forward then backward (filtfilt), so
 * there is no phase distortion of the displayed waveform. Returns a new array;
 * the input is untouched. With no biquads it returns a copy of the input.
 */
export function filtfilt(x: Float32Array, biquads: Biquad[]): Float32Array {
  let y: Float32Array = Float32Array.from(x);
  for (const bq of biquads) {
    y = reversed(forward(reversed(forward(y, bq)), bq));
  }
  return y;
}
