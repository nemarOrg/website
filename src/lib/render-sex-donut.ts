/**
 * Tiny donut chart for the Demographics tab. Three arcs (M / F / Other)
 * around a single circle, drawn with the stroke-dasharray trick so the
 * geometry is one circle command per slice — no manual arc-path math.
 *
 * The returned string is the full <svg> element. Center carries the total
 * participant count; legend is rendered in HTML by the caller (kept out of
 * the SVG so the text obeys page typography).
 */

interface SexCounts {
  M: number;
  F: number;
  O: number;
}

// Geometry constants. r = 14, stroke = 8 → ring sits within an 80×80 box
// with margin enough for the center text. circumference = 2πr ≈ 87.96.
const VIEW = 80;
const CENTER = VIEW / 2;
const R = 14;
const STROKE = 8;
const CIRC = 2 * Math.PI * R;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Emit one circular arc segment of the donut. `frac` is the slice's
 *  share of the total (0–1); `offsetFrac` is how many circumferences to
 *  rotate the dash pattern by (cumulative previous slices). */
function arc(frac: number, offsetFrac: number, color: string, label: string): string {
  if (frac <= 0) return "";
  const len = frac * CIRC;
  const off = -offsetFrac * CIRC;
  return [
    `<circle cx="${CENTER}" cy="${CENTER}" r="${R}"`,
    ` fill="none" stroke="${color}" stroke-width="${STROKE}"`,
    ` stroke-dasharray="${len.toFixed(3)} ${(CIRC - len).toFixed(3)}"`,
    ` stroke-dashoffset="${off.toFixed(3)}"`,
    ` transform="rotate(-90 ${CENTER} ${CENTER})">`,
    `<title>${esc(label)}</title>`,
    "</circle>",
  ].join("");
}

/**
 * Build the donut SVG. When all counts are zero, returns an empty-state
 * track circle without any colored slices — callers can still drop the
 * donut into the panel and rely on the surrounding empty-state message.
 */
export function renderSexDonutSvg(counts: SexCounts): string {
  const total = counts.M + counts.F + counts.O;
  const trackColor = "var(--color-border)";
  // The track sits underneath the slices so partial donuts (e.g. all-F)
  // still read as a circle, not a 270° arc.
  const track = `<circle cx="${CENTER}" cy="${CENTER}" r="${R}" fill="none" stroke="${trackColor}" stroke-width="${STROKE}" />`;

  if (total === 0) {
    return `<svg viewBox="0 0 ${VIEW} ${VIEW}" role="img" aria-label="No participants" class="sdonut__svg">${track}</svg>`;
  }

  const mFrac = counts.M / total;
  const fFrac = counts.F / total;
  const oFrac = counts.O / total;
  const slices = [
    arc(mFrac, 0, "var(--modality-eeg)", `Male: ${counts.M}`),
    arc(fFrac, mFrac, "var(--modality-ieeg)", `Female: ${counts.F}`),
    arc(oFrac, mFrac + fFrac, "var(--color-fg-subtle)", `Other or unknown: ${counts.O}`),
  ].join("");

  const label = `Male ${counts.M}, Female ${counts.F}, Other or unknown ${counts.O}`;
  return [
    `<svg viewBox="0 0 ${VIEW} ${VIEW}" role="img" aria-label="${esc(label)}" class="sdonut__svg">`,
    track,
    slices,
    // Center label: total count. font-size in SVG user units so it scales
    // with the parent's CSS sizing instead of fighting it.
    `<text x="${CENTER}" y="${CENTER}" text-anchor="middle" dominant-baseline="central"`,
    ` font-size="10" font-family="var(--font-display)" fill="var(--color-fg)">${total}</text>`,
    "</svg>",
  ].join("");
}
