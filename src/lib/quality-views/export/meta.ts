/**
 * What every exported image names (website phase W8; nemar-cli ADR 0137 decision 9, website ADR
 * 0035 decision 7): the view's digest (`nemar.view-digest.v1`, the one the route computed and the
 * page compared before drawing), its kind and kind version, its permalink, and, when the image
 * shows a color map, where the color maps' license notices are. The PNG writes these as text
 * chunks (`png.ts`) and the SVG as its `<metadata>` (`svg.ts`), from this one list.
 */

import { COLOR_MAPS_NOTICE } from "../colormap";

export interface ExportMeta {
  readonly caption: string;
  readonly kind: string;
  readonly kindVersion: number;
  /** The view's `nemar.view-digest.v1`, 64 lowercase hexadecimal digits. */
  readonly digest: string;
  /** `https://nemar.org/dataset/<id>?v=<version>#quality/<recording>/<key>` (`qualityPermalink`). */
  readonly permalink: string;
  /** Whether the image shows a color map (a scalp map or a heatmap). */
  readonly colorMaps: boolean;
  /** More fields of the picture, written and printed after the others: a computed view's window
   *  (`nemar:window-start-s`, `nemar:window-length-s`), for one. */
  readonly extra?: readonly (readonly [string, string])[];
}

/** The sentence that goes with a color map, and the absolute address of the notices. */
export const COLOR_MAPS_SENTENCE =
  "Colors: ColorBrewer RdBu (Apache-2.0), viridis (CC0) and Turbo (Apache-2.0); license notices at";

/** The notices' address on the permalink's site. */
export function noticeUrl(permalink: string): string {
  return new URL(COLOR_MAPS_NOTICE, permalink).href;
}

/** The software that wrote the image. */
export const SOFTWARE = "nemar.org quality views";

/** The image's metadata, keyword and text, in order: the PNG's text chunks, the SVG's fields. */
export function metaEntries(meta: ExportMeta): [string, string][] {
  const entries: [string, string][] = [
    ["Title", meta.caption],
    ["Source", meta.permalink],
    ["Software", SOFTWARE],
    ["nemar:view-digest", meta.digest],
    ["nemar:digest-method", "nemar.view-digest.v1"],
    ["nemar:kind", meta.kind],
    ["nemar:kind-version", String(meta.kindVersion)],
    ["nemar:permalink", meta.permalink],
  ];
  if (meta.colorMaps) {
    entries.push(["nemar:color-maps", `${COLOR_MAPS_SENTENCE} ${noticeUrl(meta.permalink)}`]);
  }
  return [...entries, ...(meta.extra ?? []).map(([k, v]): [string, string] => [k, v])];
}

/** The lines printed under the drawing, so a printed copy names its view too. */
export function footerLines(meta: ExportMeta): string[] {
  const lines = [
    `${meta.kind}, version ${meta.kindVersion}`,
    `View digest (nemar.view-digest.v1): ${meta.digest}`,
    // The notes are the picture's own paragraphs (`PictureInput.notes`), not a footer line.
    ...(meta.extra ?? [])
      .filter(([k]) => k !== "nemar:notes")
      .map(([k, v]) => `${k.replace(/^nemar:/, "")}: ${v}`),
    meta.permalink,
  ];
  if (meta.colorMaps) lines.push(`${COLOR_MAPS_SENTENCE} ${noticeUrl(meta.permalink)}`);
  return lines;
}

/**
 * `text` in lines of at most `fits(line)` each: broken at spaces, and a word too long for a line
 * of its own (a digest, a permalink) broken where it must, so no printed line runs past its width.
 */
export function wrapText(text: string, fits: (line: string) => boolean): string[] {
  const out: string[] = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) {
      line = next;
      continue;
    }
    if (line) out.push(line);
    // Break a word no line holds, as many characters at a time as fit (at least one).
    while (word.length > 1 && !fits(word)) {
      let n = word.length - 1;
      while (n > 1 && !fits(word.slice(0, n))) n--;
      out.push(word.slice(0, n));
      word = word.slice(n);
    }
    line = word;
  }
  if (line) out.push(line);
  return out;
}
