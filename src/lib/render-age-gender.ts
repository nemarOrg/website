/**
 * Stacked-bar age histogram for the Demographics tab. Reuses the existing
 * `bucketAgesBySex` helper from `./qa.ts` so the bucketing math is unit-
 * tested in one place. Each bucket renders as one column with three
 * segments stacked bottom-to-top: M (bottom), F (middle), O (top).
 *
 * Returns the full <svg> element as a string so the same helper can be
 * called from server-render and client-script contexts.
 */

import { bucketAgesBySex } from "./qa";

// Geometry — picked so the chart reads well at ~280px wide.
const BAR_W = 10;
const PAD = 4;
const CELL_W = BAR_W + PAD;
const PLOT_H = 60;
const LABEL_H = 12;
const TOTAL_H = PLOT_H + LABEL_H;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Bucket width is fixed; total width grows with the number of buckets. */
export function renderAgeGenderStackedSvg(
  ages: number[],
  sexes: Array<"M" | "F" | "O" | null>,
): string {
  const buckets = bucketAgesBySex(ages, sexes, 10);
  if (buckets.length === 0) {
    return [
      `<svg viewBox="0 0 ${CELL_W * 4} ${TOTAL_H}" role="img" aria-label="No age data" class="agbar__svg">`,
      `<text x="0" y="${PLOT_H / 2}" font-size="8" fill="var(--color-fg-subtle)">No age data</text>`,
      "</svg>",
    ].join("");
  }
  const totalW = buckets.length * CELL_W;
  const maxTotal = Math.max(1, ...buckets.map((b) => b.M + b.F + b.O));

  const segments: string[] = [];
  buckets.forEach((b, i) => {
    const x = i * CELL_W;
    const mH = (b.M / maxTotal) * PLOT_H;
    const fH = (b.F / maxTotal) * PLOT_H;
    const oH = (b.O / maxTotal) * PLOT_H;
    // Stack: M sits on the baseline, F atop M, O atop F. y grows downward
    // so each segment's y = PLOT_H - (cumulative_height_from_baseline).
    let y = PLOT_H - mH;
    if (mH > 0) {
      segments.push(
        `<rect x="${x}" y="${y.toFixed(2)}" width="${BAR_W}" height="${mH.toFixed(2)}" fill="var(--modality-eeg)"><title>${esc(`${b.label}: ${b.M} M`)}</title></rect>`,
      );
    }
    y -= fH;
    if (fH > 0) {
      segments.push(
        `<rect x="${x}" y="${y.toFixed(2)}" width="${BAR_W}" height="${fH.toFixed(2)}" fill="var(--modality-ieeg)"><title>${esc(`${b.label}: ${b.F} F`)}</title></rect>`,
      );
    }
    y -= oH;
    if (oH > 0) {
      segments.push(
        `<rect x="${x}" y="${y.toFixed(2)}" width="${BAR_W}" height="${oH.toFixed(2)}" fill="var(--color-fg-subtle)"><title>${esc(`${b.label}: ${b.O} other`)}</title></rect>`,
      );
    }
    // Bucket label below the baseline. Numeric ranges like "10-19".
    segments.push(
      `<text x="${x + BAR_W / 2}" y="${TOTAL_H - 2}" text-anchor="middle" font-size="6" font-family="var(--font-mono)" fill="var(--color-fg-subtle)">${esc(b.label)}</text>`,
    );
  });

  return [
    `<svg viewBox="0 0 ${totalW} ${TOTAL_H}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Age distribution stacked by sex" class="agbar__svg">`,
    segments.join(""),
    `<line x1="0" y1="${PLOT_H}" x2="${totalW}" y2="${PLOT_H}" stroke="var(--color-border)" stroke-width="0.5" />`,
    "</svg>",
  ].join("");
}
