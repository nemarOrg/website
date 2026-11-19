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
  contactMeans,
  contactSlots,
  shortWindowValues,
} from "./activity";

/** Entries in the color table: one per 8-bit step, so a table color is within one step of the exact one. */
export const LUT_SIZE = 256;

/** The table's 8-bit rgb triples, built on first use. */
let lut: Uint8Array | null = null;

/** Channel `c` (0 red, 1 green, 2 blue) of the viridis color of table entry `i`, 0..255. */
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
  /**
   * Measure the window centered at `centerS`; false (nothing changed) when it cannot be measured.
   * Repeating a call with the same center changes nothing: `changed` is relative to the last
   * `commit`, so a call that does not paint never consumes it.
   */
  update(centerS: number): boolean;
  /** Record that the entries now in `indexes` are on screen: `changed` clears. */
  commit(): void;
  /** Make every entry count as changed until the next `commit` (after an outside repaint). */
  invalidate(): void;
  /** The last successful window was clipped by the edge of the read. */
  readonly clipped: boolean;
  /** Per contact: the mean of its channels' finite values, NaN for none. */
  readonly contactValues: Float64Array;
  /** Per contact with no value: why (`REASON_*` of activity.ts); 0 otherwise. */
  readonly contactReasons: Uint8Array;
  /** Per contact: the color-table entry, -1 for no value. */
  readonly indexes: Int16Array;
  /** Per contact: whether its entry differs from the last committed one. */
  readonly changed: Uint8Array;
  /** Whether any entry differs from the last committed ones. */
  readonly anyChanged: boolean;
  readonly scale: ActivityScale;
}

export function createLiveActivity(input: LiveActivityInput): LiveActivity {
  const { matrix, rows, contactRows, metric, widthMs, scale } = input;
  const map = contactSlots(rows, contactRows);
  const nContacts = contactRows.length;
  const rowList = Int32Array.from(rows);
  const channelValues = new Float64Array(rows.length);
  const contactValues = new Float64Array(nContacts).fill(Number.NaN);
  const contactReasons = new Uint8Array(nContacts);
  const indexes = new Int16Array(nContacts).fill(-1);
  /** What is on screen: -2 before the first paint, so everything counts as changed. */
  const painted = new Int16Array(nContacts).fill(-2);
  const changed = new Uint8Array(nContacts).fill(1);
  let clipped = false;
  let anyChanged = nContacts > 0;
  return {
    get clipped() {
      return clipped;
    },
    get anyChanged() {
      return anyChanged;
    },
    contactValues,
    contactReasons,
    indexes,
    changed,
    scale,
    invalidate() {
      painted.fill(-2);
      changed.fill(1);
      anyChanged = nContacts > 0;
    },
    commit() {
      painted.set(indexes);
      changed.fill(0);
      anyChanged = false;
    },
    update(centerS) {
      const b = shortWindowValues(matrix, centerS, widthMs, metric, rowList, channelValues);
      if (!b) return false;
      clipped = b.clipped;
      contactMeans(channelValues, map, contactValues, contactReasons);
      let any = false;
      for (let i = 0; i < nContacts; i++) {
        indexes[i] = lutIndex(scale, contactValues[i]);
        const differs = indexes[i] !== painted[i];
        changed[i] = differs ? 1 : 0;
        if (differs) any = true;
      }
      anyChanged = any;
      return true;
    },
  };
}
