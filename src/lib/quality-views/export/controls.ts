/**
 * A view's export controls (website phase W8, #588; nemar-cli ADR 0137 decision 9, website ADR 0035
 * decision 7), a chunk of its own that the panel loads only when a visitor opens a view's Export
 * toggle (`export-hook.ts`): exports are made only on request, and their code is on no first screen.
 *
 * - **Image (PNG)** at 2, 3 or 4 times, in the light palette, with text chunks naming the view's
 *   digest, kind, kind version and permalink, and the color maps' notice when a map is shown
 *   (`raster.ts`, `png.ts`).
 * - **Drawing (SVG)** for a line chart (the spectrum) or a histogram, with the same in `<metadata>`
 *   (`svg.ts`). Both are one chunk (`picture.ts`), loaded as the controls open.
 * - **Each file** of the view, the exact bytes checked against their size and SHA-256.
 *
 * No export makes a request at its click: the picture is painted from what the page drew, and the
 * files come from the source the page drew with, each asked for as the controls open. A result, or the reason there is none, is said in a status
 * line read aloud.
 */

import { MARKETING_BASE_URL } from "../../host";
import type { ColorMapName } from "../colormap";
import {
  type BuiltModel,
  type FileSource,
  type SensorFieldModel,
  type ViewDecl,
  downloadsOf,
} from "../model";
import { qualityPermalink } from "../panel-model";
import type { QualityRecord } from "../record";
import type { SensorFieldHandle } from "../render/sensor-field-view";
import { exportName, mediaTypeOf, saveBytes, verifiedBytes } from "./download";
import type { ExportMeta } from "./meta";
import type { ExportField, Scale } from "./raster";

/** What the panel hands the export of one drawn view. */
export interface ExportInput {
  readonly view: ViewDecl;
  readonly record: QualityRecord;
  /** The base's model as drawn (null for a view with no data of its own). */
  readonly built: BuiltModel | null;
  /** The file source the view was drawn from. */
  readonly files: FileSource;
  /** The panel's scalp maps, by the element each is drawn into: those in `container` are the
   *  view's, read at each export, so a map drawn since (the spectrum's picked row) is in. */
  readonly fields: ReadonlyMap<
    HTMLElement,
    {
      readonly field: SensorFieldHandle;
      readonly model: SensorFieldModel;
      readonly built: BuiltModel & { readonly model: SensorFieldModel };
    }
  >;
  /** The view's container in its tab. */
  readonly container: HTMLElement;
  /** The color map the page paints a scalp map with now (the Turbo toggle). */
  readonly colorOf: (model: SensorFieldModel) => ColorMapName;
  readonly version: string | null;
  /** The page's origin: the permalink names the canonical site instead, except in local
   *  development (`permalinkOrigin`). */
  readonly origin: string;
}

/** The site a permalink names: the canonical one (`MARKETING_BASE_URL`, the site's configured
 *  public address; C14 of the live-views plan), whatever host the page is served from, except in
 *  local development, where the page's own origin is the only one that opens. */
export function permalinkOrigin(pageOrigin: string): string {
  let host = "";
  try {
    host = new URL(pageOrigin).hostname;
  } catch {
    // Not an address: the canonical site.
  }
  const local =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  return local ? pageOrigin : MARKETING_BASE_URL;
}

/** The view's scalp maps on show now, each with the color map the page paints it with. */
export function viewFields(input: ExportInput): ExportField[] {
  return [...input.fields]
    .filter(([target]) => input.container.contains(target))
    .map(([, f]) => ({ built: f.built, field: f.field, colorMap: input.colorOf(f.model) }));
}

/** Why a file is not saved, after its name. */
const NOT_SAVED = {
  file_missing: "could not be read",
  file_size_mismatch: "does not have the size NEMAR recorded",
  file_digest_mismatch: "does not match the digest NEMAR recorded",
} as const;

/** The page's canvas of the view's heatmap cells, when the view is a heatmap. */
const heatmapOf = (input: ExportInput): HTMLCanvasElement | null =>
  input.built?.refused === null && input.built.model.type === "heatmap"
    ? input.container.querySelector("canvas.qv-heatmap-cells")
    : null;

/** The activations figure the view shows, when the view is a computed `nemar.ic-activity`. */
const activityFigure = (input: ExportInput): Element | null =>
  input.view.kind === "nemar.ic-activity" ? input.container.querySelector(".qp-activity") : null;

/** The window on show of an activations figure (its chunk is loaded: it drew the figure), as the
 *  picture paints it, and the fields that name it. */
async function shownWindow(figure: Element) {
  const m = await import("../activations");
  const shown = m.shownActivity.get(figure)?.();
  if (!shown) return null;
  const { startS, lengthS } = m.activityWindow(shown.activity);
  return {
    picture: {
      height: m.activityHeight(shown.activity.plan.components.length),
      painter: (colors: Parameters<typeof m.activityPainter>[2]) =>
        m.activityPainter(shown.activity, shown.label, colors),
    },
    notes: shown.notes,
    extra: [
      ["nemar:window-start-s", String(startS)],
      ["nemar:window-length-s", String(lengthS)],
      ["nemar:notes", shown.notes.join(" ")],
    ] as const,
  };
}

/** The metadata of the picture the view would export now. */
export function exportMeta(input: ExportInput): ExportMeta {
  const { view, record } = input;
  return {
    caption: view.caption,
    kind: view.kind,
    kindVersion: view.kind_version,
    // Compared with the declaration's own digest before the view was drawn (`panel.ts`).
    digest: record.digests[view.key],
    permalink: qualityPermalink(permalinkOrigin(input.origin), record.datasetId, input.version, {
      recording: record.recording,
      key: view.key,
    }),
    colorMaps:
      heatmapOf(input) !== null || viewFields(input).some((f) => f.field.drawnMaps().length > 0),
  };
}

/** Fill `host` (the Export toggle's body) with the view's controls. */
export function fillExport(host: HTMLElement, input: ExportInput): void {
  const doc = host.ownerDocument;
  const { view, record } = input;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    return node;
  };
  const status = el("p");
  status.className = "qv-export-status";
  status.setAttribute("role", "status");
  const say = (text: string): void => {
    status.textContent = text;
  };
  /** A button that runs `act` once at a time and says what failed. While it runs it is
   *  `aria-disabled` and ignores a second click, but never `disabled`: a disabled button drops
   *  the keyboard's focus to the page. */
  const button = (label: string, act: () => Promise<string>): HTMLButtonElement => {
    const b = el("button", label);
    b.type = "button";
    let busy = false;
    b.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      b.setAttribute("aria-disabled", "true");
      try {
        say(await act());
      } catch (error) {
        console.error("[quality-views] an export failed:", error);
        say(`${label}: this browser could not make it.`);
      } finally {
        busy = false;
        b.removeAttribute("aria-disabled");
      }
    });
    return b;
  };
  const meta = exportMeta(input);
  const about = el(
    "p",
    "An image names this view's digest, kind and permalink in its own metadata; a file is saved exactly as NEMAR recorded it. Permalink: ",
  );
  about.className = "qv-note";
  const link = el("a", meta.permalink);
  link.href = meta.permalink;
  about.append(link);
  const parts: Node[] = [about];

  const name = (extension: string) => exportName(view.key, record.recording, extension);
  const type = input.built?.refused === null ? input.built.model.type : null;
  // SVG for a line chart (the spectrum) or a histogram only (`hasSvg` in `palette.ts`).
  const svg = type === "lines" || type === "histogram";
  const picture =
    svg ||
    heatmapOf(input) !== null ||
    activityFigure(input) !== null ||
    viewFields(input).some((f) => f.field.drawnMaps().length > 0);
  if (picture) {
    // Loaded as the controls open, so a click makes no request.
    const images = import("./picture");
    // The parts this view's picture paints, each a chunk of its own, loaded now too.
    const painters = [
      heatmapOf(input) ? import("./heatmap-part") : null,
      viewFields(input).length > 0 ? import("./maps-part") : null,
    ];
    // A failed load is said by the click that needs it.
    for (const loading of [images, ...painters]) loading?.catch(() => {});
    const group = el("div");
    group.className = "qv-export-images";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Save the view as an image");
    const select = el("select");
    select.id = `qv-export-${view.key}-scale`;
    for (const scale of [2, 3, 4]) {
      const option = el("option", `${scale}×`);
      option.value = String(scale);
      select.append(option);
    }
    const label = el("label", "Scale ");
    label.htmlFor = select.id;
    const png = button("Save image (PNG)", async () => {
      const scale = Number(select.value) as Scale;
      const { exportPng } = await images;
      const figure = activityFigure(input);
      const window = figure ? await shownWindow(figure) : null;
      if (figure && !window) return "No window of activations is drawn to save.";
      const bytes = await exportPng(
        doc,
        {
          meta: { ...exportMeta(input), extra: window?.extra },
          built: input.built,
          fields: viewFields(input),
          heatmap: heatmapOf(input),
          activity: window?.picture,
          notes: window?.notes,
        },
        scale,
      );
      saveBytes(doc, bytes, name("png"), "image/png");
      return `Saved the image at ${scale}× (${bytes.length} bytes).`;
    });
    group.append(label, select, png);
    if (svg) {
      group.append(
        button("Save drawing (SVG)", async () => {
          const m = await images;
          const tree = await m.svgDrawing(input.built);
          // The drawing is the line chart or histogram alone: it shows no color map.
          if (!tree) return "This view has no drawing to save.";
          saveBytes(
            doc,
            m.exportSvg(tree, { ...exportMeta(input), colorMaps: false }),
            name("svg"),
            "image/svg+xml",
          );
          return "Saved the drawing.";
        }),
      );
    }
    parts.push(group);
  }

  const files = downloadsOf(view);
  // Asked for now, as the controls open, through the source the view was drawn with, which keeps
  // what it read: a file the view did not read itself (the Signal window's tables) is then saved
  // with no request at the click. A file it read is already held.
  for (const file of files) void input.files(file).catch(() => {});
  if (files.length > 0) {
    const list = el("ul");
    list.className = "qv-export-files";
    list.setAttribute("aria-label", "Save a file of this view, as recorded");
    for (const file of files) {
      const base = file.location.slice(file.location.lastIndexOf("/") + 1);
      const item = el("li");
      const save = button(`Save ${base}`, async () => {
        const got = await verifiedBytes(file, input.files);
        if ("word" in got) return `${base} ${NOT_SAVED[got.word]}, so it is not saved.`;
        saveBytes(doc, got.bytes, base, mediaTypeOf(file.location));
        return `Saved ${base} (${got.bytes.length} bytes), the bytes NEMAR recorded.`;
      });
      save.dataset.sha256 = file.sha256;
      item.append(save, ` (${file.role}, ${file.size} bytes)`);
      list.append(item);
    }
    parts.push(list);
  }
  parts.push(status);
  host.replaceChildren(...parts);
}
