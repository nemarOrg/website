/**
 * The frame every quality view is drawn in (website ADR 0035 decision 7; the live-views plan's
 * C14): a `figure` with its `figcaption`, the drawing (`role="img"` with a text alternative built
 * from the model), a readout a pointer or the keyboard fills with stored text, a data table behind a
 * native toggle (`details`), the files to download, and the notice for the color maps.
 *
 * Everything here is a tree (`tree.ts`), so the server and the page draw the same thing.
 */

import { COLOR_MAPS_NOTICE } from "../colormap";
import type { Download } from "../model";
import { type Child, type Element, h } from "../tree";

export interface ViewContext {
  /** A prefix for the ids of this view's elements, unique on the page. */
  readonly id: string;
  /** The view's caption, as declared. */
  readonly caption: string;
  /** The view's declared kind and version, said beside the caption. */
  readonly kind: string;
  readonly kindVersion: number;
  /** Where a file can be downloaded, or null when the page offers no link yet. Only an http(s)
   *  or blob address (or a path on this site) is linked; any other is shown as text. */
  readonly downloadUrl?: (file: Download) => string | null;
  /** Build the data tables now, for a page drawn on the server with no script; a page builds
   *  each when its toggle is first opened. */
  readonly eagerTables?: boolean;
}

/** `url` when it is an http(s) or blob address, or a path that resolves to one; null otherwise
 *  (`javascript:`, `data:` and every other scheme). */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const protocol = new URL(url, "https://nemar.invalid/").protocol;
    return protocol === "https:" || protocol === "http:" || protocol === "blob:" ? url : null;
  } catch {
    return null;
  }
}

/** A table of text: one header row and rows of cells, every cell a stored text. */
export function textTable(
  caption: string,
  header: readonly string[],
  rows: readonly (readonly string[])[],
): Element {
  return h(
    "table",
    { class: "qv-table" },
    h("caption", {}, caption),
    h("thead", {}, h("tr", {}, ...header.map((name) => h("th", { scope: "col" }, name)))),
    h("tbody", {}, ...rows.map((row) => h("tr", {}, ...row.map((cell) => h("td", {}, cell))))),
  );
}

export const DATA_TABLE = "Data table";

/** A data table behind a native toggle, closed by default; built now only when `table` is given
 *  (the server), otherwise on the toggle's first opening (`attachLazyTable`). */
export function dataTableToggle(table: Element | null, label = DATA_TABLE): Element {
  return h("details", { class: "qv-data" }, h("summary", {}, label), table);
}

/** The last segment of a location: the name a download is saved under. */
export const fileName = (location: string): string => location.slice(location.lastIndexOf("/") + 1);

/** The view's files, each offered for download: no view hides data. */
export function downloadList(files: readonly Download[], ctx: ViewContext): Element | null {
  if (files.length === 0) return null;
  return h(
    "ul",
    { class: "qv-downloads", "aria-label": "Files of this view" },
    ...files.map((file) => {
      const url = safeUrl(ctx.downloadUrl?.(file));
      const name = fileName(file.location);
      return h(
        "li",
        {},
        url ? h("a", { href: url, download: name }, name) : h("span", {}, name),
        ` (${file.role}, ${file.size} bytes)`,
      );
    }),
  );
}

/** The link to the color maps' licenses (the Apache-2.0 notices of ColorBrewer and Turbo). */
export function colorMapsNotice(): Element {
  return h(
    "p",
    { class: "qv-notice" },
    h("a", { href: COLOR_MAPS_NOTICE, rel: "license" }, "Color map licenses"),
  );
}

export interface FigureParts {
  readonly ctx: ViewContext;
  /** The drawing, or null when nothing is drawn (a table needs no drawing). */
  readonly drawing: Child | null;
  /** The drawing's text alternative: the caption and text from the model. */
  readonly label: string;
  /** A live region the pointer and the keyboard fill, when the drawing has a readout. */
  readonly readout?: boolean;
  /** `img` (the default): the drawing is one image. `group`: it holds images of its own (a row of
   *  scalp maps, each with its own text alternative). */
  readonly role?: "img" | "group";
  /** The drawing takes focus and arrow keys itself (false for scalp maps, whose maps do). */
  readonly focusable?: boolean;
  /** What the drawing is, for a screen reader (`aria-roledescription`): "line chart", ... */
  readonly roleDescription?: string;
  /** The keys the drawing answers, said under it. */
  readonly keys?: string;
  /** The data table, built when its toggle first opens (or now, with `ctx.eagerTables`). */
  readonly table?: () => Element;
  readonly notes?: readonly Child[];
  readonly downloads: readonly Download[];
  readonly colorMaps?: boolean;
}

/** The figure of one view. */
export function figure(parts: FigureParts): Element {
  const { ctx } = parts;
  const captionId = `${ctx.id}-caption`;
  return h(
    "figure",
    { class: "qv-figure", id: ctx.id, "aria-labelledby": captionId },
    h(
      "figcaption",
      { id: captionId },
      ctx.caption,
      h("span", { class: "qv-kind" }, ` (${ctx.kind}, version ${ctx.kindVersion})`),
    ),
    parts.drawing
      ? h(
          "div",
          {
            class: "qv-drawing",
            role: parts.role ?? "img",
            "aria-roledescription": parts.roleDescription ?? null,
            "aria-label": parts.label,
            tabindex: parts.readout && parts.focusable !== false ? 0 : null,
            "aria-describedby": parts.readout ? `${ctx.id}-readout` : null,
          },
          parts.drawing,
        )
      : null,
    parts.keys ? h("p", { class: "qv-keys" }, parts.keys) : null,
    parts.readout
      ? h("output", { class: "qv-readout", id: `${ctx.id}-readout`, "aria-live": "polite" })
      : null,
    ...(parts.notes ?? []),
    parts.table ? dataTableToggle(ctx.eagerTables ? parts.table() : null) : null,
    downloadList(parts.downloads, ctx),
    parts.colorMaps ? colorMapsNotice() : null,
  );
}
