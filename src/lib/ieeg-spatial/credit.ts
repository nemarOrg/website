/**
 * The RAVE credit of the iEEG spatial view (card IS-K1), declared once.
 *
 * NEMAR draws the electrode view with its own renderer and ships no RAVE code or asset, so no
 * license asks for this credit: it is a voluntary acknowledgment, and its wording says
 * "inspired by", never "powered by" or "rendered by". The Reproducible Analysis and
 * Visualization of intracranial EEG (RAVE) project asks users of its viewer to cite the 2020
 * NeuroImage paper; the citation rides in the link's title and in exported SVG metadata.
 *
 * Three forms of the same credit, so every surface carries it: a live link element for the
 * panel (`creditLink`), a canvas painter for raster exports (`paintCredit`) and an SVG fragment
 * for vector exports (`creditSvg`). Nothing else in the code base writes these words; a test
 * scans `src` to keep it so.
 */

export const RAVE_CREDIT = Object.freeze({
  text: "Electrode view inspired by RAVE",
  href: "https://rave.wiki",
  title:
    "RAVE: Reproducible Analysis and Visualization of iEEG (Magnotti, Wang and Beauchamp, NeuroImage 2020, doi:10.1016/j.neuroimage.2020.117341)",
  doi: "10.1016/j.neuroimage.2020.117341",
});

/** The class the live link wears; its rules live in `src/styles/eeg-viewer.css`. */
export const CREDIT_CLASS = "eegv-credit";

/** CSS pixels. The live link's stylesheet rule and the painters share this size. */
export const CREDIT_FONT_PX = 11;

const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', sans-serif";
/** Backing opacity of the painted and SVG credit; the live link uses the same ratio in CSS. */
const BACKING_OPACITY = 0.8;
/** Nominal CSS pixel metrics, scaled by the device pixel ratio. */
const PAD_X = 6;
const PAD_Y = 3;
const MARGIN = 8;
const LINE_HEIGHT = 1.3;
/** Mean glyph advance, in em, used where no text can be measured (the SVG fragment). */
const SVG_ADVANCE_EM = 0.58;

/** Resolved CSS colors, read by the caller from the theme tokens (`--color-bg`, `--color-fg`). */
export interface CreditTheme {
  background: string;
  foreground: string;
}

/** A rectangle in canvas pixels. */
export interface CreditBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CreditLayout {
  box: CreditBox;
  /** Font size in canvas pixels; below `CREDIT_FONT_PX * dpr` only when the canvas is too narrow. */
  fontPx: number;
  /** Space between the box edge and the text, in canvas pixels. */
  padX: number;
  /** Vertical center of the text line, in canvas pixels. */
  centerY: number;
}

/** What the live link is made of: its text and attributes, as plain data Node tests can read. */
export interface CreditLinkSpec {
  text: string;
  attributes: {
    href: string;
    title: string;
    target: string;
    rel: string;
    class: string;
    "aria-label": string;
  };
}

export function creditLinkSpec(): CreditLinkSpec {
  return {
    text: RAVE_CREDIT.text,
    attributes: {
      href: RAVE_CREDIT.href,
      title: RAVE_CREDIT.title,
      target: "_blank",
      rel: "noopener noreferrer",
      class: CREDIT_CLASS,
      // The visible text first, so the name still contains what a sighted user reads.
      "aria-label": `${RAVE_CREDIT.text} (opens in a new tab)`,
    },
  };
}

/**
 * The live link for a panel corner. An anchor with an href is keyboard-focusable; position and
 * colors come from the `eegv-credit` class alone. Everything it sets comes from `creditLinkSpec`.
 */
export function creditLink(doc: Document): HTMLAnchorElement {
  const { text, attributes } = creditLinkSpec();
  const a = doc.createElement("a");
  for (const [name, value] of Object.entries(attributes)) a.setAttribute(name, value);
  a.textContent = text;
  return a;
}

/**
 * Where the credit sits on a canvas `width` by `height` canvas pixels, anchored bottom-right.
 * `textWidthPx` is the sentence's measured width, in canvas pixels, at `CREDIT_FONT_PX * dpr`.
 * A canvas too small for the sentence at that size gets a proportionally smaller credit, so the
 * box never leaves the canvas.
 */
export function creditLayout(
  width: number,
  height: number,
  dpr: number,
  textWidthPx: number,
): CreditLayout {
  if (![width, height, dpr, textWidthPx].every(Number.isFinite) || dpr <= 0) {
    throw new RangeError("creditLayout needs finite sizes and a positive pixel ratio");
  }
  const margin = MARGIN * dpr;
  const padX = PAD_X * dpr;
  const fontNominal = CREDIT_FONT_PX * dpr;
  const boxW = Math.max(textWidthPx, 0) + 2 * padX;
  const boxH = fontNominal * LINE_HEIGHT + 2 * PAD_Y * dpr;
  const fit = Math.max(0, Math.min(1, (width - 2 * margin) / boxW, (height - 2 * margin) / boxH));
  const w = boxW * fit;
  const h = boxH * fit;
  const x = Math.max(0, width - margin - w);
  const y = Math.max(0, height - margin - h);
  return {
    box: { x, y, width: w, height: h },
    fontPx: fontNominal * fit,
    padX: padX * fit,
    centerY: y + h / 2,
  };
}

/**
 * Paint the credit in the bottom-right corner of a raster export, on a token-colored backing,
 * and return the box it covered. The caller paints it last. `width` and `height` are the
 * canvas's pixel size and `dpr` its device pixel ratio, so the text is `CREDIT_FONT_PX` CSS
 * pixels tall on screen. The default is the browser's ratio, right for a canvas drawn at screen
 * scale; an export canvas rendered at a fixed scale, whatever the screen, must pass its own.
 */
export function paintCredit(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: CreditTheme,
  dpr: number = globalThis.devicePixelRatio || 1,
): CreditBox {
  ctx.save();
  ctx.font = `${CREDIT_FONT_PX * dpr}px ${FONT_FAMILY}`;
  const textWidth = ctx.measureText(RAVE_CREDIT.text).width;
  const layout = creditLayout(width, height, dpr, textWidth);
  const { box } = layout;
  ctx.globalAlpha = BACKING_OPACITY;
  ctx.fillStyle = theme.background;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.globalAlpha = 1;
  ctx.font = `${layout.fontPx}px ${FONT_FAMILY}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = theme.foreground;
  ctx.fillText(RAVE_CREDIT.text, box.x + layout.padX, layout.centerY);
  ctx.restore();
  return box;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * The credit as an SVG fragment for a vector export of `width` by `height` user units: a
 * `<g>` holding a `<metadata>` block (credit, address, citation), a backing rectangle and an
 * `<a href>` around the `<text>`, in the bottom-right corner. SVG cannot measure text, so the
 * backing is sized from a mean glyph advance and the text is right-anchored inside it.
 */
export function creditSvg(width: number, height: number, theme: CreditTheme): string {
  const textWidth = RAVE_CREDIT.text.length * CREDIT_FONT_PX * SVG_ADVANCE_EM;
  const layout = creditLayout(width, height, 1, textWidth);
  const { box } = layout;
  const doi = `https://doi.org/${RAVE_CREDIT.doi}`;
  return [
    `<g class="${CREDIT_CLASS}">`,
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">`,
    `<dc:description>${esc(RAVE_CREDIT.text)}. ${esc(RAVE_CREDIT.title)}</dc:description>`,
    `<dc:relation>${esc(RAVE_CREDIT.href)}</dc:relation>`,
    `<dc:relation>${esc(doi)}</dc:relation>`,
    "</metadata>",
    `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" fill="${esc(theme.background)}" fill-opacity="${BACKING_OPACITY}"/>`,
    `<a href="${esc(RAVE_CREDIT.href)}" target="_blank" rel="noopener noreferrer">`,
    `<text x="${num(box.x + box.width - layout.padX)}" y="${num(layout.centerY)}" text-anchor="end" dominant-baseline="central" font-family="${esc(FONT_FAMILY)}" font-size="${num(layout.fontPx)}" fill="${esc(theme.foreground)}">${esc(RAVE_CREDIT.text)}</text>`,
    "</a>",
    "</g>",
  ].join("");
}
