import type { Montage } from "../quality-views/montages";
import type { Vec3 } from "../quality-views/sensor-layout";

/**
 * The signal viewer's placement of channels by name, until `nemar.sensor-labels.v1` arrives
 * (website ADR 0035 decision 5; phase W2b of website#588 replaces this file with it).
 *
 * Many EEG datasets name standard channel labels (Fp1, Cz, Oz, ...) or a recognizable cap's
 * (EGI `E1..`, BioSemi `A1..`) but ship no `electrodes.tsv`. For those the viewer places each
 * channel at the position its name has in one of neuroschema's montages (`views/montages`, copied
 * by digest into `src/lib/quality-views/vocabulary/montages/`), as template positions that
 * `nemar.sensor-layout.v1` centers on the montage's own center.
 *
 * Which montage, and how a name matches, is still the viewer's earlier rule (#855), not yet the
 * specification's: a cap whose labels look like a BioSemi bank or an EGI net is tried first, then
 * the 10-05 montage; names compare case-insensitively, with the 10-20 aliases T3, T4, T5 and T6.
 * Only the coordinates changed: they are neuroschema's, where the viewer kept its own copy of MNE's.
 * `nemar.sensor-field.v1` draws no map through fewer than 8 placed sensors, so a handful of
 * incidental matches draws nothing.
 *
 * ACCEPTED DEVIATION FROM ADR 0137, until phase W2b (website#588) replaces this file with
 * `nemar.sensor-labels.v1` (owner's ruling on website#593):
 * - EGI nets are chosen by names alone (`namedCap`: numbered `E` labels give a HydroCel net by the
 *   highest number). The amendment forbids that: a recording is placed on a HydroCel net only
 *   when its `CapManufacturersModelName` names that net, because older EGI nets number their
 *   electrodes alike on other positions, so names alone never decide an EGI net.
 * - There is no share rule: sensor-labels.v1 refuses a montage unless at least 80% of the
 *   candidate channels match it (`share_too_low`); the #855 rule has none, only `MIN_MATCHED`
 *   here and BioSemi's bank dominance (60% of the labels).
 * - Ambiguity (`montage_ambiguous`), `duplicate_label`, `net_coverage_low` and the hyphen split
 *   are not checked either.
 * W2b removes all of this; do not extend it.
 */

/** The montages this rule can choose, by their exact neuroschema names. */
export type NamedMontage =
  | "standard_1005"
  | "GSN-HydroCel-129"
  | "GSN-HydroCel-257"
  | "biosemi128"
  | "biosemi256";

/** The legacy 10-20 names of four 10-10 positions, read only against the 10-05 montage. */
export const ALIASES: Readonly<Record<string, string>> = {
  T3: "T7",
  T4: "T8",
  T5: "P7",
  T6: "P8",
};

/** A montage needs this many matched names before the next one is not tried. */
export const MIN_MATCHED = 3;

const key = (label: string): string => label.trim().toUpperCase();

/**
 * The named cap a label set points to, or null when the labels look like neither an EGI geodesic
 * net nor a BioSemi cap.
 *
 * The two label namespaces overlap on `E*` (BioSemi-256 banks run A..H, so it also has E1..E32), so
 * the BioSemi A bank decides: every BioSemi cap starts at A1, while EGI nets number E1.. (and Cz).
 * The net's size is read from the highest bank or number seen, since a dataset normally carries
 * every electrode of its cap.
 */
export function namedCap(labels: readonly string[]): NamedMontage | null {
  const upper = labels.map(key);
  if (upper.some((l) => /^A\d{1,2}$/.test(l))) {
    const banks = new Set<string>();
    let count = 0;
    for (const l of upper) {
      const m = /^([A-H])\d{1,2}$/.exec(l);
      if (m) {
        banks.add(m[1]);
        count++;
      }
    }
    // A BioSemi cap is almost entirely bank-labeled; a 10-20 set has a few incidental [A-H]-digit
    // labels (F3, C4) and maybe an A1/A2 ear reference, so the bank labels must dominate.
    if (count >= 3 && count >= upper.length * 0.6) {
      const highest = [...banks].sort().pop() as string;
      return highest <= "D" ? "biosemi128" : "biosemi256";
    }
  }
  let eCount = 0;
  let eMax = 0;
  for (const l of upper) {
    const m = /^E(\d{1,3})$/.exec(l);
    if (m) {
      eCount++;
      eMax = Math.max(eMax, Number(m[1]));
    }
  }
  if (eCount >= 3) return eMax <= 129 ? "GSN-HydroCel-129" : "GSN-HydroCel-257";
  return null;
}

/** The montages to try for a label set, in order: a recognized cap's, then the 10-05 montage. */
export function candidateMontages(labels: readonly string[]): NamedMontage[] {
  const cap = namedCap(labels);
  return cap ? [cap, "standard_1005"] : ["standard_1005"];
}

/** One channel placed by name: the caller's label, as spelled, and its montage position. */
export interface MatchedLabel {
  readonly label: string;
  readonly position: Vec3;
}

/**
 * The labels that name an electrode of `montage`, in the caller's order, each with that electrode's
 * position. Case is ignored; the 10-20 aliases apply to the 10-05 montage only; a label that names
 * no electrode is left out.
 */
export function matchLabels(labels: readonly string[], montage: Montage): MatchedLabel[] {
  const index = new Map<string, Vec3>();
  montage.names.forEach((name, i) => index.set(key(name), montage.positions[i]));
  if (montage.family === "10-05") {
    for (const [legacy, modern] of Object.entries(ALIASES)) {
      const position = index.get(key(modern));
      if (position && !index.has(legacy)) index.set(legacy, position);
    }
  }
  const out: MatchedLabel[] = [];
  for (const label of labels) {
    const position = index.get(key(label));
    if (position) out.push({ label, position });
  }
  return out;
}
