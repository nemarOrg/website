/**
 * Stacked-bar age histogram for the Demographics tab. Reuses the existing
 * `bucketAgesBySex` helper from `./qa.ts` so the bucketing math is unit-
 * tested in one place. Each bucket renders as one column with three
 * segments stacked bottom-to-top: M (bottom), F (middle), O (top).
 *
 * Returns the full <svg> element as a string so the same helper can be
 * called from server-render and client-script contexts.
 *
 * Geometry note (#83 fix): the viewBox is intentionally in NATIVE PIXEL
 * coordinates — at the rendered size (CSS fixes `block-size: 160px` with
 * auto width), 1 user unit ≈ 1 device pixel, so `font-size` in user units
 * matches normal screen typography. The previous version compressed the
 * viewBox (`42 × 72` for 3 buckets) and stretched it to 100% width, which
 * blew the 6-unit tick labels up to ~90 px text.
 */

import { bucketAgesBySex } from "./qa";

// Pixel-coordinate geometry. CELL_W scales with bucket count; PLOT_H + LABEL_H
// give the chart a fixed 160-pixel height regardless of how many buckets the
// dataset has. The CSS sets `block-size: 160px` so these values render at 1:1.
const BAR_W = 30;
const PAD = 14;
const CELL_W = BAR_W + PAD;
const SIDE_PAD = 8;
const PLOT_H = 130;
const LABEL_GAP = 6;
const LABEL_FONT_PX = 11;
const TOTAL_H = PLOT_H + LABEL_GAP + LABEL_FONT_PX + 4;

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
    const w = CELL_W * 3 + SIDE_PAD * 2;
    return [
      `<svg viewBox="0 0 ${w} ${TOTAL_H}" role="img" aria-label="No age data" class="agbar__svg">`,
      `<text x="${w / 2}" y="${PLOT_H / 2}" text-anchor="middle" font-size="${LABEL_FONT_PX}" fill="var(--color-fg-subtle)">No age data</text>`,
      "</svg>",
    ].join("");
  }
  const totalW = buckets.length * CELL_W + SIDE_PAD * 2;
  const maxTotal = Math.max(1, ...buckets.map((b) => b.M + b.F + b.O));

  const segments: string[] = [];
  buckets.forEach((b, i) => {
    const x = SIDE_PAD + i * CELL_W + PAD / 2;
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
      `<text x="${x + BAR_W / 2}" y="${PLOT_H + LABEL_GAP + LABEL_FONT_PX}" text-anchor="middle" font-size="${LABEL_FONT_PX}" font-family="var(--font-mono)" fill="var(--color-fg-subtle)">${esc(b.label)}</text>`,
    );
  });

  return [
    `<svg viewBox="0 0 ${totalW} ${TOTAL_H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Age distribution stacked by sex" class="agbar__svg">`,
    segments.join(""),
    `<line x1="${SIDE_PAD}" y1="${PLOT_H}" x2="${totalW - SIDE_PAD}" y2="${PLOT_H}" stroke="var(--color-border)" stroke-width="1" />`,
    "</svg>",
  ].join("");
}
