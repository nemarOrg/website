/**
 * The live half of the Activity overlay's "At cursor" measure: per contact, a short-window value
 * around the cursor, recolored at mouse speed from the samples the last read kept.
 *
 * Pure and allocation-free once built. `createLiveActivity` binds one retained matrix
 * (`ActivityMatrix`), the contacts' channel rows and one fixed color scale; `update(centerS)`
 * refills three preallocated arrays (channel values, contact values, color-table indexes) and says
 * whether any contact's color changed. Nothing here touches the DOM, the layout or the network.
 */

import { viridisColor } from "../eeg-viewer/topo";
import {
  type ActivityMatrix,
  type ActivityScale,
  type CursorMetric,
  shortWindowValues,
} from "./activity";

/** Entries in the color table: one per 8-bit step, so a table color is within one step of the exact one. */
export const LUT_SIZE = 256;

/** Channel `c` (0 red, 1 green, 2 blue) of the viridis color of table entry `i`, 0..255. */
let lut: Uint8Array | null = null;
export function lutChannel(i: number, c: number): number {
  if (!lut) {
    lut = new Uint8Array(LUT_SIZE * 3);
    for (let k = 0; k < LUT_SIZE; k++) {
      lut.set(viridisColor((2 * k) / (LUT_SIZE - 1) - 1), k * 3);
    }
  }
  return lut[i * 3 + c];
}

/** Table entry for a value on a sequential scale, or -1 for no value. Allocates nothing. */
export function lutIndex(scale: ActivityScale, value: number): number {
  if (!Number.isFinite(value)) return -1;
  if (scale.degenerate) return Math.round((LUT_SIZE - 1) / 2);
  const t = (value - scale.lo) / (scale.hi - scale.lo);
  return Math.round(Math.max(0, Math.min(1, t)) * (LUT_SIZE - 1));
}

export interface LiveActivityInput {
  matrix: ActivityMatrix;
  /** Channel rows to measure, ascending and distinct (the located ones). */
  rows: readonly number[];
  /** Per drawn contact, the channel rows that feed it (one, or two for a bipolar pair). */
  contactRows: readonly (readonly number[])[];
  metric: CursorMetric;
  widthMs: number;
  scale: ActivityScale;
}

export interface LiveActivity {
  /** Measure the window centered at `centerS`; false (nothing changed) when it cannot be measured. */
  update(centerS: number): boolean;
  /** The last successful window was clipped by the edge of the read. */
  readonly clipped: boolean;
  /** Per contact: the mean of its channels' finite values, NaN for none. */
  readonly contactValues: Float64Array;
  /** Per contact: the color-table entry, -1 for no value, -2 before the first paint. */
  readonly indexes: Int16Array;
  /** Per contact: whether the last `update` changed its entry. */
  readonly changed: Uint8Array;
  /** Whether the last `update` changed any entry. */
  readonly anyChanged: boolean;
  /** Force every entry to count as changed at the next `update` (after an outside repaint). */
  invalidate(): void;
  readonly scale: ActivityScale;
}

export function createLiveActivity(input: LiveActivityInput): LiveActivity {
  const { matrix, rows, contactRows, metric, widthMs, scale } = input;
  const slotOf = new Map<number, number>();
  rows.forEach((row, k) => slotOf.set(row, k));
  const nContacts = contactRows.length;
  // Flat slots per contact: `start[i] .. start[i + 1]` index `slots`.
  const start = new Int32Array(nContacts + 1);
  const flat: number[] = [];
  contactRows.forEach((own, i) => {
    for (const row of own) {
      const k = slotOf.get(row);
      if (k !== undefined) flat.push(k);
    }
    start[i + 1] = flat.length;
  });
  const slots = Int32Array.from(flat);
  const rowList = Int32Array.from(rows);
  const channelValues = new Float64Array(rows.length);
  const contactValues = new Float64Array(nContacts).fill(Number.NaN);
  const indexes = new Int16Array(nContacts).fill(-2);
  const changed = new Uint8Array(nContacts);
  const self: LiveActivity = {
    clipped: false,
    anyChanged: false,
    contactValues,
    indexes,
    changed,
    scale,
    invalidate() {
      indexes.fill(-2);
    },
    update(centerS) {
      const b = shortWindowValues(matrix, centerS, widthMs, metric, rowList, channelValues);
      if (!b) return false;
      (self as { clipped: boolean }).clipped = b.clipped;
      let any = false;
      for (let i = 0; i < nContacts; i++) {
        let sum = 0;
        let count = 0;
        for (let j = start[i]; j < start[i + 1]; j++) {
          const v = channelValues[slots[j]];
          if (Number.isFinite(v)) {
            sum += v;
            count++;
          }
        }
        const value = count > 0 ? sum / count : Number.NaN;
        contactValues[i] = value;
        const idx = lutIndex(scale, value);
        if (idx !== indexes[i]) {
          indexes[i] = idx;
          changed[i] = 1;
          any = true;
        } else {
          changed[i] = 0;
        }
      }
      (self as { anyChanged: boolean }).anyChanged = any;
      return true;
    },
  };
  return self;
}
