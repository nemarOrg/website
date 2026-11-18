/**
 * The banner on a dataset whose declared unit disagrees with its numbers (card IS-Q2, ADR 0033).
 *
 * `on004100` declares meters for numbers that are millimeter-sized, so every contact lands tens of
 * meters from the origin once the declared unit is applied and nothing is visible. The ADR forbids
 * inferring a unit from magnitudes, so nothing is corrected: the positions stay as IS-C1 gave them
 * (the declared unit applied, nothing else), and what the panel adds is a statement, drawn on the
 * stage and written into every figure, that the numbers look millimeter-sized, how far the farthest
 * contact is, and that the contacts are drawn as declared and placed on no template.
 *
 * When it applies: IS-C1 converted a declared non-millimeter unit (`scaleToMm` not 1), and EVERY
 * drawn contact then lies more than `UNITS_BANNER_MIN_DISTANCE_MM` from the origin. One contact
 * inside that distance is a plausible head, so there is no banner; a file in millimeters, a file
 * with no declared unit, and a file whose meters really are meters (`on004473`: its contacts lie
 * 29 to 115 mm out) never have one. The sentence is declared here and nowhere else.
 */

import type { Units, Vec3 } from "./geometry";

/**
 * A head is about 200 mm across, and frames that are centered on it (a template, the anterior
 * commissure) put contacts within about 120 mm of the origin; the scanner's origin can be farther
 * out. Every contact past this distance, in a unit the file converted, is the case the banner
 * names. A documented constant: change it only with its test.
 */
export const UNITS_BANNER_MIN_DISTANCE_MM = 300;

export interface UnitsBanner {
  /** The unit word the file declared (`m`, `cm`, ...). */
  declared: string;
  /** The farthest drawn contact from the origin, millimeters as drawn. */
  largestMm: number;
  /** The sentence, as the stage and the figures say it. */
  text: string;
}

/** The banner's sentence: declared once; the stage and every figure read it from the model. */
function bannerText(declared: string, largestMm: number): string {
  const distance = Math.round(largestMm).toLocaleString("en-US");
  return `Declared unit ${declared}, but the values look millimeter-sized (largest distance ${distance} mm from the origin). Positions are shown as declared and are not placed on any template.`;
}

/**
 * The banner for these drawn positions (millimeters as IS-C1 gave them, never rescaled), or null.
 * Reads the positions and never changes them.
 */
export function unitsBanner(units: Units, positions: readonly Vec3[]): UnitsBanner | null {
  const converted =
    units.unit === "mm" &&
    units.unitsDeclared &&
    units.declared !== null &&
    units.scaleToMm !== null &&
    units.scaleToMm !== 1;
  if (!converted || positions.length === 0) return null;
  let nearest = Number.POSITIVE_INFINITY;
  let farthest = 0;
  for (const p of positions) {
    const d = Math.hypot(p[0], p[1], p[2]);
    nearest = Math.min(nearest, d);
    farthest = Math.max(farthest, d);
  }
  if (!(nearest > UNITS_BANNER_MIN_DISTANCE_MM)) return null;
  const declared = units.declared as string;
  return { declared, largestMm: farthest, text: bannerText(declared, farthest) };
}
