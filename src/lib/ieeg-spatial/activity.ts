/**
 * Per-channel activity metrics for the iEEG spatial view's "Activity" overlay.
 *
 * Pure, dependency-free. The panel reads the visible window's level-0 samples
 * (`readLevel0` in the signal viewer's store), hands them here, and gets one
 * value per channel for a chosen metric, its unit, and a color scale. View
 * levels are display decimations (a min/max envelope), never samples, so
 * `activityChannelsFromWindow` refuses them.
 *
 * Definitions (all per channel, over exactly the samples given; nothing is
 * claimed beyond that window):
 *  - `rms`: root mean square of the mean-removed samples, in the channel unit
 *    (the window's standard deviation, population form).
 *  - `line_length`: mean absolute first difference times the sampling rate, in
 *    the channel unit per second.
 *  - `band_power`: Welch's method (Hann window, periodic form; segment of 1 s
 *    rounded to a power of two in samples; 50 percent overlap; mean removed per
 *    segment; trailing partial segment dropped), one-sided density integrated
 *    over the band with bins `lo <= f < hi`, in the channel unit squared. With
 *    `relative`, decibels of the band's power against the channel's own power
 *    from 1 Hz up to the lesser of 150 Hz and 0.45 times the rate.
 *
 * The converter serves iEEG at 1000 Hz in level 0 (nemar-cli
 * `scripts/zarr/generate_zarr.py`, `MODALITY_RATES`).
 */

import { unitToSI } from "../eeg-viewer/dsp";
import type { WindowData } from "../eeg-viewer/store";
import { VIRIDIS_CSS, viridisColor } from "../eeg-viewer/topo";

// --- Closed lists and constants ---------------------------------------------

export type ActivityMetric = "rms" | "line_length" | "band_power";

export const ACTIVITY_METRICS: readonly ActivityMetric[] = ["rms", "line_length", "band_power"];

/** Bands in Hz; edges inclusive below and exclusive above. A closed list. */
export const BANDS = {
  delta: [1, 4],
  theta: [4, 8],
  alpha: [8, 13],
  beta: [13, 30],
  low_gamma: [30, 70],
  high_gamma: [70, 150],
} as const satisfies Record<string, readonly [number, number]>;

export type BandName = keyof typeof BANDS;

/** A band whose upper edge exceeds this fraction of the rate is refused. */
export const BAND_NYQUIST_FRACTION = 0.45;

/** Lower edge and upper cap (Hz) of the broadband reference for `relative`. */
const BROADBAND_LO_HZ = 1;
const BROADBAND_HI_HZ = 150;

// --- Inputs and outcomes -----------------------------------------------------

export interface ActivityChannel {
  label: string;
  /** Level-0 samples in `ActivityRequest.unit`. */
  samples: ArrayLike<number>;
}

export interface ActivityRequest {
  channels: readonly ActivityChannel[];
  /** Sampling rate of `samples`, in Hz (level 0). */
  rateHz: number;
  /** Unit of `samples` (`"V"` for a `WindowData`, which the store converts to SI). */
  unit: string;
  metric: ActivityMetric;
  /** Required for `band_power`. */
  band?: BandName;
  /** `band_power` only: decibels against the channel's own broadband power. */
  relative?: boolean;
  /** Report in this unit instead (for example `"µV"`); both must be known voltage units. */
  displayUnit?: string;
}

export type ActivityRefusal =
  | "band_above_nyquist"
  | "window_too_short"
  | "not_level0"
  | "bad_input";

export interface ActivityRefused {
  ok: false;
  reason: ActivityRefusal;
  /** A short technical detail for logs and tests; user-facing sentences belong to the panel. */
  detail: string;
}

export interface ChannelActivity {
  label: string;
  /** `null` when the channel's samples are not all finite or the value is undefined. */
  value: number | null;
}

export interface ActivityResult {
  ok: true;
  metric: ActivityMetric;
  band: BandName | null;
  relative: boolean;
  /** Unit of every value: `µV`, `µV/s`, `µV²` or `dB`. */
  unit: string;
  rateHz: number;
  /** Samples per channel the values were computed from. */
  nSamples: number;
  /** Seconds of signal the values describe (`nSamples / rateHz`). */
  windowS: number;
  /** Welch segment length in samples, `band_power` only. */
  segmentSamples: number | null;
  /** Number of Welch segments averaged, `band_power` only. */
  segments: number | null;
  /** Broadband reference range in Hz, `band_power` with `relative` only. */
  referenceHz: [number, number] | null;
  channels: ChannelActivity[];
}

export type ActivityOutcome = ActivityResult | ActivityRefused;

function refuse(reason: ActivityRefusal, detail: string): ActivityRefused {
  return { ok: false, reason, detail };
}

// --- Units -------------------------------------------------------------------

function isKnownUnit(unit: string): boolean {
  const u = unit.trim().toLowerCase();
  return u === "v" || u === "t" || unitToSI(unit) !== 1;
}

/** `uV` to `µV`; anything else unchanged. */
function prettyUnit(unit: string): string {
  const u = unit.trim();
  return /^u[A-Za-z]/.test(u) ? `µ${u.slice(1)}` : u;
}

// --- Window adapter ----------------------------------------------------------

/**
 * Turn a signal viewer window into activity channels. Only level-0 line data
 * qualifies: a view level is a min/max envelope and says nothing about
 * spectra, so it is refused.
 */
export function activityChannelsFromWindow(
  win: WindowData,
  labels: readonly string[],
): { ok: true; channels: ActivityChannel[] } | ActivityRefused {
  if (win.level !== 0) {
    return refuse("not_level0", `window is view level ${win.level}, not level 0`);
  }
  if (labels.length !== win.channels.length) {
    return refuse("bad_input", `${labels.length} labels for ${win.channels.length} channels`);
  }
  const channels: ActivityChannel[] = [];
  for (let i = 0; i < win.channels.length; i++) {
    const ch = win.channels[i];
    if (ch.kind !== "line") return refuse("not_level0", `channel ${labels[i]} is a min/max band`);
    channels.push({ label: labels[i], samples: ch.line });
  }
  return { ok: true, channels };
}

// --- FFT ---------------------------------------------------------------------

interface FftPlan {
  n: number;
  rev: Uint32Array;
  cos: Float64Array;
  sin: Float64Array;
  hann: Float64Array;
  /** Sum of squared window samples. */
  hannSq: number;
}

const planCache = new Map<number, FftPlan>();

function planFor(n: number): FftPlan {
  const hit = planCache.get(n);
  if (hit) return hit;
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = -Math.sin((2 * Math.PI * k) / n);
  }
  const hann = new Float64Array(n);
  let hannSq = 0;
  for (let i = 0; i < n; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    hannSq += hann[i] * hann[i];
  }
  const plan = { n, rev, cos, sin, hann, hannSq };
  planCache.set(n, plan);
  return plan;
}

/** In-place iterative radix-2 forward FFT of `re + i im`. */
function fft(plan: FftPlan, re: Float64Array, im: Float64Array): void {
  const { n, rev, cos, sin } = plan;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const stride = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * stride];
        const wi = sin[k * stride];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

// --- Welch -------------------------------------------------------------------

/** Welch segment length for a rate: 1 s in samples, rounded to a power of two (nearest in log2). */
export function welchSegmentSamples(rateHz: number): number {
  return 2 ** Math.round(Math.log2(rateHz));
}

/** Smallest window, in samples, that holds two Welch segments at 50 percent overlap. */
export function minWindowSamples(rateHz: number): number {
  const nper = welchSegmentSamples(rateHz);
  return nper + nper / 2;
}

/**
 * One-sided Welch power spectral density (density scaling, mean-removed
 * segments, Hann window) of one channel, in input-unit squared per Hz.
 * Returns `null` when a sample is not finite. `x.length` must hold at least
 * two segments (checked by the caller).
 */
function welchDensity(x: ArrayLike<number>, rateHz: number, nper: number): Float64Array | null {
  const plan = planFor(nper);
  const step = nper / 2;
  const nSeg = Math.floor((x.length - nper) / step) + 1;
  const bins = nper / 2 + 1;
  const acc = new Float64Array(bins);
  const re = new Float64Array(nper);
  const im = new Float64Array(nper);

  // Two real segments ride in one complex FFT: for z = a + i b,
  // |A[k]|^2 + |B[k]|^2 = (|Z[k]|^2 + |Z[N-k]|^2) / 2, and only the sum is needed.
  const fillSegment = (target: Float64Array, s: number): boolean => {
    const off = s * step;
    let sum = 0;
    for (let i = 0; i < nper; i++) sum += x[off + i];
    if (!Number.isFinite(sum)) return false;
    const mean = sum / nper;
    for (let i = 0; i < nper; i++) target[i] = (x[off + i] - mean) * plan.hann[i];
    return true;
  };

  for (let s = 0; s < nSeg; s += 2) {
    if (!fillSegment(re, s)) return null;
    if (s + 1 < nSeg) {
      if (!fillSegment(im, s + 1)) return null;
    } else {
      im.fill(0);
    }
    fft(plan, re, im);
    for (let k = 0; k < bins; k++) {
      const m = (nper - k) % nper;
      acc[k] += 0.5 * (re[k] * re[k] + im[k] * im[k] + re[m] * re[m] + im[m] * im[m]);
    }
  }

  const scale = 1 / (rateHz * plan.hannSq * nSeg);
  for (let k = 0; k < bins; k++) {
    // One-sided: double every bin except DC and the Nyquist bin.
    acc[k] *= scale * (k === 0 || k === bins - 1 ? 1 : 2);
  }
  return acc;
}

function integrateBand(psd: Float64Array, rateHz: number, nper: number, lo: number, hi: number) {
  const df = rateHz / nper;
  let sum = 0;
  for (let k = 0; k < psd.length; k++) {
    const f = k * df;
    if (f >= lo && f < hi) sum += psd[k];
  }
  return sum * df;
}

// --- Metrics -----------------------------------------------------------------

function rmsOf(x: ArrayLike<number>): number | null {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i];
  const mean = sum / x.length;
  let sq = 0;
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - mean;
    sq += d * d;
  }
  const v = Math.sqrt(sq / x.length);
  return Number.isFinite(v) ? v : null;
}

function lineLengthOf(x: ArrayLike<number>, rateHz: number): number | null {
  let sum = 0;
  for (let i = 1; i < x.length; i++) sum += Math.abs(x[i] - x[i - 1]);
  const v = (sum / (x.length - 1)) * rateHz;
  return Number.isFinite(v) ? v : null;
}

/**
 * Compute one value per channel for the requested metric, or refuse with a
 * reason word the panel turns into a sentence.
 */
export function computeActivity(req: ActivityRequest): ActivityOutcome {
  const { channels, rateHz, metric } = req;
  if (!Number.isFinite(rateHz) || rateHz <= 0) {
    return refuse("bad_input", `sampling rate ${rateHz} is not a positive number`);
  }
  if (!ACTIVITY_METRICS.includes(metric)) return refuse("bad_input", `unknown metric ${metric}`);
  if (channels.length === 0) return refuse("bad_input", "no channels");
  const n = channels[0].samples.length;
  if (channels.some((c) => c.samples.length !== n)) {
    return refuse("bad_input", "channels have different lengths");
  }

  let displayUnit = req.unit;
  let factor = 1;
  if (req.displayUnit !== undefined && req.displayUnit !== req.unit) {
    if (!isKnownUnit(req.unit) || !isKnownUnit(req.displayUnit)) {
      return refuse("bad_input", `cannot convert ${req.unit} to ${req.displayUnit}`);
    }
    factor = unitToSI(req.unit) / unitToSI(req.displayUnit);
    displayUnit = req.displayUnit;
  }
  const base = prettyUnit(displayUnit);

  let band: readonly [number, number] | null = null;
  let nper: number | null = null;
  let relative = false;
  if (metric === "band_power") {
    if (!req.band || !(req.band in BANDS)) {
      return refuse("bad_input", `unknown band ${String(req.band)}`);
    }
    band = BANDS[req.band];
    relative = req.relative === true;
    if (band[1] > BAND_NYQUIST_FRACTION * rateHz) {
      return refuse(
        "band_above_nyquist",
        `band ${req.band} reaches ${band[1]} Hz, above ${BAND_NYQUIST_FRACTION} times ${rateHz} Hz`,
      );
    }
    nper = welchSegmentSamples(rateHz);
    const need = minWindowSamples(rateHz);
    if (n < need) {
      return refuse("window_too_short", `${n} samples, band power needs ${need} at ${rateHz} Hz`);
    }
  } else if (n < (metric === "rms" ? 1 : 2)) {
    return refuse("window_too_short", `${n} samples is too few for ${metric}`);
  }

  const out: ChannelActivity[] = [];
  const referenceHi = Math.min(BROADBAND_HI_HZ, BAND_NYQUIST_FRACTION * rateHz);
  for (const ch of channels) {
    let value: number | null;
    if (metric === "rms") {
      value = rmsOf(ch.samples);
      if (value !== null) value *= factor;
    } else if (metric === "line_length") {
      value = lineLengthOf(ch.samples, rateHz);
      if (value !== null) value *= factor;
    } else {
      const psd = welchDensity(ch.samples, rateHz, nper as number);
      if (psd === null || band === null) {
        value = null;
      } else {
        const power = integrateBand(psd, rateHz, nper as number, band[0], band[1]);
        if (relative) {
          const total = integrateBand(psd, rateHz, nper as number, BROADBAND_LO_HZ, referenceHi);
          value = power > 0 && total > 0 ? 10 * Math.log10(power / total) : null;
        } else {
          value = power * factor * factor;
        }
      }
    }
    out.push({ label: ch.label, value });
  }

  const unit =
    metric === "rms" ? base : metric === "line_length" ? `${base}/s` : relative ? "dB" : `${base}²`;
  const segments = nper === null ? null : Math.floor((n - nper) / (nper / 2)) + 1;
  return {
    ok: true,
    metric,
    band: metric === "band_power" ? (req.band as BandName) : null,
    relative,
    unit,
    rateHz,
    nSamples: n,
    windowS: n / rateHz,
    segmentSamples: nper,
    segments,
    referenceHz: relative ? [BROADBAND_LO_HZ, referenceHi] : null,
    channels: out,
  };
}

// --- Color scales ------------------------------------------------------------

export type ScaleKind = "sequential" | "zscore";

type Rgb = [number, number, number];

/** Diverging map (blue, near-white, red; ColorBrewer RdBu, 7 classes), low to high. */
const DIVERGING: readonly Rgb[] = [
  [33, 102, 172],
  [103, 169, 207],
  [209, 229, 240],
  [247, 247, 247],
  [253, 219, 199],
  [239, 138, 98],
  [178, 24, 43],
];

/** CSS-gradient stops for the diverging colorbar (left = low). */
export const DIVERGING_CSS = DIVERGING.map(
  ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
).join(", ");

/** Map t in [-1, 1] to the diverging map; 0 lands on the near-white middle. */
export function divergingColor(t: number): Rgb {
  const u = ((Math.max(-1, Math.min(1, t)) + 1) / 2) * (DIVERGING.length - 1);
  const i = Math.min(DIVERGING.length - 2, Math.floor(u));
  const f = u - i;
  const a = DIVERGING[i];
  const b = DIVERGING[i + 1];
  return [
    Math.round(a[0] + f * (b[0] - a[0])),
    Math.round(a[1] + f * (b[1] - a[1])),
    Math.round(a[2] + f * (b[2] - a[2])),
  ];
}

export interface ActivityScale {
  kind: ScaleKind;
  /** Numeric limits for the colorbar, in `unit`. Symmetric about zero for `zscore`. */
  lo: number;
  hi: number;
  /** The value unit for `sequential`; `"z"` for `zscore`. */
  unit: string;
  /** `zscore` only: the located channels' mean and standard deviation (population form). */
  mean: number | null;
  sd: number | null;
  /** Located channels with a finite value that the limits came from. */
  nLocated: number;
  /** True when the limits cannot spread colors (one value, or all equal). */
  degenerate: boolean;
  /** CSS gradient stops for the colorbar, low to high. */
  css: string;
}

/** Linear-interpolation percentile (NumPy's default method) of an ascending array. */
function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (q / 100) * (sorted.length - 1);
  const i = Math.floor(pos);
  const j = Math.min(sorted.length - 1, i + 1);
  return sorted[i] + (pos - i) * (sorted[j] - sorted[i]);
}

/**
 * Build a color scale from the located channels' values.
 *  - `sequential`: limits are the 2nd and 98th percentiles of the located
 *    values; values outside are clipped to the end colors.
 *  - `zscore`: values become z against the located mean and standard
 *    deviation; limits are plus and minus the 98th percentile of |z|.
 * `located[i]` says whether channel `i` has a contact position; omit it to use
 * every channel. Non-finite and `null` values are never part of the limits.
 */
export function buildScale(
  values: ArrayLike<number | null>,
  kind: ScaleKind,
  unit: string,
  located?: ArrayLike<boolean>,
): ActivityScale {
  const used: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null && Number.isFinite(v) && (located ? located[i] : true)) used.push(v);
  }
  const css = kind === "sequential" ? VIRIDIS_CSS : DIVERGING_CSS;
  const empty: ActivityScale = {
    kind,
    lo: kind === "zscore" ? -1 : 0,
    hi: 1,
    unit: kind === "zscore" ? "z" : unit,
    mean: null,
    sd: null,
    nLocated: used.length,
    degenerate: true,
    css,
  };
  if (used.length === 0) return empty;

  if (kind === "sequential") {
    const sorted = [...used].sort((a, b) => a - b);
    const lo = percentile(sorted, 2);
    const hi = percentile(sorted, 98);
    return { ...empty, lo, hi, degenerate: !(hi > lo) };
  }

  const mean = used.reduce((s, v) => s + v, 0) / used.length;
  const sd = Math.sqrt(used.reduce((s, v) => s + (v - mean) ** 2, 0) / used.length);
  if (!(sd > 0)) return { ...empty, mean, sd };
  const absZ = used.map((v) => Math.abs((v - mean) / sd)).sort((a, b) => a - b);
  const limit = percentile(absZ, 98);
  return { ...empty, lo: -limit, hi: limit, mean, sd, degenerate: !(limit > 0) };
}

/**
 * The color of one value on a scale, or `null` for "no data" (a non-finite or
 * missing value). Degenerate scales paint the middle color.
 */
export function colorFor(scale: ActivityScale, value: number | null): Rgb | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (scale.kind === "sequential") {
    if (scale.degenerate) return viridisColor(0);
    const t = (value - scale.lo) / (scale.hi - scale.lo);
    return viridisColor(2 * Math.max(0, Math.min(1, t)) - 1);
  }
  if (scale.degenerate || scale.sd === null || scale.mean === null) return divergingColor(0);
  const z = (value - scale.mean) / scale.sd;
  return divergingColor(z / scale.hi);
}
