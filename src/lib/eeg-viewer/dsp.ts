/**
 * Pure DSP + display helpers for the signal viewer (website#99). No zarr / DOM
 * dependency, so these are unit-tested directly. The store reader and canvas
 * renderer build on top of them.
 *
 * Discipline (MNE semantics): every transform here is DISPLAY-ONLY. Dequant maps
 * the stored int16 back to physical units; DC removal and scaling never touch the
 * stored data.
 */

/** Coarse recording modalities the viewer styles/scales by. */
export type Modality = "EEG" | "EMG" | "IEEG" | "MEG" | "MISC";

/**
 * Dequantize a stored digital sample to physical units: `physical = digital *
 * scale + offset`. biosigIO stores int16 with per-channel scale/offset; a
 * float32 store uses scale=1, offset=0, so this is a safe identity there.
 */
export function dequantize(digital: number, scale: number, offset: number): number {
  return digital * scale + offset;
}

/**
 * Subtract a channel row's mean over the visible window, in place (EEGLAB
 * `submean` / MNE DC removal, on by default). Display-only: operates on the
 * already-dequantized window copy, never the store.
 */
export function removeDcInPlace(row: Float32Array): Float32Array {
  if (row.length === 0) return row;
  let sum = 0;
  for (let i = 0; i < row.length; i++) sum += row[i];
  const mean = sum / row.length;
  for (let i = 0; i < row.length; i++) row[i] -= mean;
  return row;
}

/**
 * Per-modality default full-scale amplitude (the "div" the µV scale bar shows),
 * in the channel's physical unit. These mirror MNE-Python's `raw.plot()`
 * defaults so EEG researchers see familiar gain out of the box.
 */
export const DEFAULT_SCALINGS: Record<Modality, number> = {
  EEG: 20e-6, // 20 µV
  IEEG: 100e-6, // 100 µV (sEEG/ECoG)
  EMG: 1e-3, // 1 mV
  MEG: 1e-12, // 1 pT (magnetometer)
  MISC: 100e-6,
};

/** Default full-scale for a channel type, falling back to the group modality. */
export function defaultScaling(modality: Modality): number {
  return DEFAULT_SCALINGS[modality] ?? DEFAULT_SCALINGS.MISC;
}

/**
 * Okabe-Ito colorblind-safe palette (the eegdash / MNE channel-type convention).
 * Stable order so a given channel type always renders the same hue.
 */
export const OKABE_ITO = [
  "#0072B2", // blue
  "#D55E00", // vermillion
  "#009E73", // green
  "#CC79A7", // pink
  "#E69F00", // orange
  "#56B4E9", // sky
  "#F0E442", // yellow
  "#000000", // black
] as const;

const CHANNEL_TYPE_COLOR: Record<string, string> = {
  EEG: "#0072B2",
  SEEG: "#0072B2",
  ECOG: "#0072B2",
  EMG: "#D55E00",
  EOG: "#009E73",
  VEOG: "#009E73",
  HEOG: "#009E73",
  ECG: "#CC79A7",
  EKG: "#CC79A7",
  TRIG: "#E69F00",
  REF: "#56B4E9",
  MISC: "#666666",
};

/** Color a trace by its BIDS channel type (Okabe-Ito), with a neutral fallback. */
export function channelColor(channelType: string | undefined): string {
  if (!channelType) return CHANNEL_TYPE_COLOR.MISC;
  return CHANNEL_TYPE_COLOR[channelType.toUpperCase()] ?? CHANNEL_TYPE_COLOR.MISC;
}

/**
 * Pick the view-pyramid level whose envelope is closest to 1 sample/pixel for
 * the visible window, so we transfer ~viewport-sized chunks regardless of how
 * long the recording is. `levelSamples[L]` is the number of time samples a level
 * holds for the FULL recording; we scale by the visible fraction.
 *
 * Returns the chosen level index (0 = full-rate level-0). Picking the coarsest
 * level that still has >= pixelWidth samples in the window keeps detail without
 * over-fetching; if even the coarsest is denser than the viewport we still use
 * it (it is the smallest available).
 */
export function pickViewLevel(
  levelSamples: number[],
  visibleFraction: number,
  pixelWidth: number,
): number {
  if (levelSamples.length === 0) return 0;
  const frac = Math.min(1, Math.max(0, visibleFraction));
  const target = Math.max(1, pixelWidth);
  // Levels are ordered fine -> coarse (index 0 = level-0). Walk coarse -> fine,
  // take the first (coarsest) level whose visible sample count still covers the
  // viewport; fall back to the finest if none do.
  for (let level = levelSamples.length - 1; level >= 0; level--) {
    const visibleSamples = levelSamples[level] * frac;
    if (visibleSamples >= target) return level;
  }
  return 0;
}

/**
 * Factor converting a stored physical unit to SI base (Volts or Tesla), so the
 * whole viewer works in SI and per-modality scalings/scale-bar are unit-correct
 * regardless of whether a store quantized in µV, mV, fT, ... Unknown units pass
 * through as 1 (already SI / dimensionless).
 */
const UNIT_TO_SI: Record<string, number> = {
  v: 1,
  mv: 1e-3,
  uv: 1e-6,
  µv: 1e-6,
  nv: 1e-9,
  t: 1,
  mt: 1e-3,
  ut: 1e-6,
  µt: 1e-6,
  nt: 1e-9,
  pt: 1e-12,
  ft: 1e-15,
};

export function unitToSI(unit: string | undefined): number {
  if (!unit) return 1;
  return UNIT_TO_SI[unit.trim().toLowerCase()] ?? 1;
}

const SI_PREFIXES: Array<[number, string]> = [
  [1, ""],
  [1e-3, "m"],
  [1e-6, "µ"],
  [1e-9, "n"],
  [1e-12, "p"],
  [1e-15, "f"],
];

/**
 * Format an SI amplitude with the natural metric prefix for its magnitude, e.g.
 * `formatSi(20e-6, "V") -> "20 µV"`, `formatSi(1e-12, "T") -> "1 pT"`. `base` is
 * the dimension symbol (V for electric, T for magnetic / MEG).
 */
export function formatSi(value: number, base: "V" | "T"): string {
  const a = Math.abs(value);
  if (a === 0) return `0 ${base}`;
  for (const [factor, prefix] of SI_PREFIXES) {
    if (a >= factor) {
      const n = value / factor;
      const digits = Math.abs(n) >= 10 ? 0 : 1;
      return `${n.toFixed(digits)} ${prefix}${base}`;
    }
  }
  const [factor, prefix] = SI_PREFIXES[SI_PREFIXES.length - 1];
  return `${(value / factor).toPrecision(2)} ${prefix}${base}`;
}

/** Format seconds as `HH:MM:SS` (clock axis toggle). */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

/**
 * A "nice" amplitude for the scale bar: round `value` down to 1/2/5 x 10^n so
 * the µV/div label reads cleanly (10, 20, 50, 100, ...). Returns the rounded
 * value in the same unit as the input.
 */
export function niceScale(value: number): number {
  if (!(value > 0)) return 1;
  const exp = Math.floor(Math.log10(value));
  const pow = 10 ** exp;
  const frac = value / pow;
  const nice = frac >= 5 ? 5 : frac >= 2 ? 2 : 1;
  return nice * pow;
}
