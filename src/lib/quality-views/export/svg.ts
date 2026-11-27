/**
 * Scalable Vector Graphics (SVG) export of a view (website phase W8; nemar-cli ADR 0137 decision 9:
 * "SVG for the spectrum and the histogram"): the drawing the page shows, as one standalone file in
 * the light print palette, with a `<title>`, a `<desc>`, a `<metadata>` element holding the view's
 * digest, kind, kind version and permalink (`meta.ts`), and the same lines printed under it.
 *
 * The drawing is the renderer's own tree (`linesSvg`, `histogramSvg`), so the file draws what the
 * page drew; its classes are given the light palette by an inline `<style>`, since the file
 * carries no page stylesheet. The page's cursor is left out. The renderer is imported on demand:
 * it is the one the page drew the view with, already loaded, so no request is made.
 */

import type { BuiltModel, HistogramModel, LinesModel } from "../model";
import { type Child, type Element, h, toDom } from "../tree";
import { type ExportMeta, footerLines, metaEntries, wrapText } from "./meta";
import { CLASS_PAINT, FONT, LIGHT, hasSvg, paintOf, viewBoxSize } from "./palette";

/** The `<style>` that gives the drawing's classes the light palette. */
export function exportStyle(): string {
  const rules = Object.entries(CLASS_PAINT).map(([name, p]) => {
    const parts = [
      p.hidden ? "display:none" : null,
      p.stroke ? `stroke:${p.stroke}` : null,
      p.strokeWidth !== undefined ? `stroke-width:${p.strokeWidth}` : null,
      p.strokeOpacity !== undefined ? `stroke-opacity:${p.strokeOpacity}` : null,
      p.fill ? `fill:${p.fill}` : p.stroke ? "fill:none" : null,
      p.fontSize ? `font-size:${p.fontSize}px` : null,
    ].filter((s): s is string => s !== null);
    return `.${name}{${parts.join(";")}}`;
  });
  return `text{font-family:${FONT}}${rules.join("")}.qv-export-text{fill:${LIGHT.muted};font-size:${TEXT_SIZE}px}.qv-export-title{fill:${LIGHT.foreground};font-size:${TITLE_SIZE}px;font-weight:600}`;
}

/** The drawing of a built view, as its renderer draws it, or null when it has none to export. */
export async function svgDrawing(built: BuiltModel | null): Promise<Element | null> {
  if (!built || !hasSvg(built)) return null;
  if (built.model.type === "lines") {
    return (await import("../render/lines")).linesSvg(built.model as LinesModel);
  }
  return (await import("../render/histogram")).histogramSvg(built.model as HistogramModel);
}

/** The drawing's children without the elements an export does not draw. */
function exportChildren(node: Element): Child[] {
  return node.children
    .filter((c) => typeof c === "string" || !paintOf(c.attrs.class).hidden)
    .map((c) => (typeof c === "string" ? c : { ...c, children: exportChildren(c) }));
}

/** The printed lines' sizes, and the widths a character may take at most, in ems: an SVG file
 *  has no way to measure text, so its lines are broken by these (the browser test measures them). */
const TITLE_SIZE = 13;
const TEXT_SIZE = 10;
const LINE_HEIGHT = 14;
export const EM_PER_CHARACTER = 0.66;
const MARGIN = 8;

/** Lines that fit `width` at `size` pixels a character of `EM_PER_CHARACTER` ems. */
export const svgLines = (text: string, width: number, size: number): string[] =>
  wrapText(text, (line) => line.length * size * EM_PER_CHARACTER <= width - 2 * MARGIN);

/** The browser's own XML serializer, on the tree as SVG elements. */
const xml = (tree: Element): string => new XMLSerializer().serializeToString(toDom(tree, document));

/** The standalone SVG file of a drawing; `serialize` writes the tree as XML (the browser's
 *  serializer; `toHtml` of `tree.ts` writes the same elements where there is no DOM, in tests). */
export function exportSvg(
  drawing: Element,
  meta: ExportMeta,
  serialize: (tree: Element) => string = xml,
): string {
  const { width, height } = viewBoxSize(drawing);
  const title = svgLines(meta.caption, width, TITLE_SIZE);
  const lines = footerLines(meta).flatMap((line) => svgLines(line, width, TEXT_SIZE));
  const top = 8 + title.length * (TITLE_SIZE + 5);
  const total = top + height + 8 + lines.length * LINE_HEIGHT;
  const tree = h(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width,
      height: total,
      viewBox: `0 0 ${width} ${total}`,
      role: "img",
      "aria-labelledby": "qv-export-title qv-export-desc",
    },
    h("title", { id: "qv-export-title" }, meta.caption),
    h("desc", { id: "qv-export-desc" }, footerLines(meta).join(" ")),
    h("metadata", { id: "nemar-view" }, JSON.stringify(Object.fromEntries(metaEntries(meta)))),
    h("style", {}, exportStyle()),
    h("rect", { x: 0, y: 0, width, height: total, fill: LIGHT.background }),
    ...title.map((line, i) =>
      h(
        "text",
        { class: "qv-export-title", x: MARGIN, y: 8 + (i + 1) * (TITLE_SIZE + 5) - 5 },
        line,
      ),
    ),
    h("g", { transform: `translate(0 ${top})` }, ...exportChildren(drawing)),
    ...lines.map((line, i) =>
      h(
        "text",
        { class: "qv-export-text", x: MARGIN, y: top + height + 5 + (i + 1) * LINE_HEIGHT },
        line,
      ),
    ),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(tree)}\n`;
}

/** The metadata of an SVG export, read back from its text (a reader's side, and the tests'). */
export function svgMetadata(svg: string): Record<string, string> | null {
  const match = /<metadata id="nemar-view">([^<]*)<\/metadata>/.exec(svg);
  if (!match) return null;
  const text = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return JSON.parse(text) as Record<string, string>;
}
