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
 * No export makes a request: the picture is painted from what the page drew, and the files come
 * from the source the page drew with. A result, or the reason there is none, is said in a status
 * line read aloud.
 */

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
  /** The site's origin, for the permalink. */
  readonly origin: string;
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

/** The metadata of the picture the view would export now. */
export function exportMeta(input: ExportInput): ExportMeta {
  const { view, record } = input;
  return {
    caption: view.caption,
    kind: view.kind,
    kindVersion: view.kind_version,
    // Compared with the declaration's own digest before the view was drawn (`panel.ts`).
    digest: record.digests[view.key],
    permalink: qualityPermalink(input.origin, record.datasetId, input.version, {
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
  /** A button that runs `act` once at a time and says what failed. */
  const button = (label: string, act: () => Promise<string>): HTMLButtonElement => {
    const b = el("button", label);
    b.type = "button";
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        say(await act());
      } catch (error) {
        console.error("[quality-views] an export failed:", error);
        say(`${label}: this browser could not make it.`);
      } finally {
        b.disabled = false;
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
    viewFields(input).some((f) => f.field.drawnMaps().length > 0);
  if (picture) {
    // Loaded as the controls open, so a click makes no request.
    const images = import("./picture");
    // A failed load is said by the click that needs it.
    images.catch(() => {});
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
      const bytes = await exportPng(
        doc,
        {
          meta: exportMeta(input),
          built: input.built,
          fields: viewFields(input),
          heatmap: heatmapOf(input),
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
