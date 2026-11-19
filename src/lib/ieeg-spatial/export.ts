/**
 * Figure exports of the iEEG spatial view (card IS-V3): `exportPng` and `exportSvg` are the only
 * entry points, and each file carries the RAVE credit INSIDE it, painted or written as the last
 * thing, so nothing drawn afterwards can cover it.
 *
 * One `Figure` describes a picture (title, the image or the three views, the activity colorbar,
 * the labels wrapped to lines, a reserved footer for the credit). Two serializers read it:
 * - `buildDrawList` gives the raster export's draw list, a flat array of operations whose last one
 *   is always the credit, built and testable before anything is rasterized; `exportPng` runs it on
 *   a canvas, passing the export canvas's own device pixel ratio to the credit painter.
 * - `buildSvg` gives the vector export: the three views with a `<circle>` and `<title>` per
 *   contact, the labels as `<text>`, a `<metadata>` block (dataset id, version, recording path,
 *   frame, every label, the credit and its address) and, last, the credit's `<a href>` around its
 *   `<text>` from `creditSvg`.
 *
 * What the files say is what the panel said. Every label comes from the panel's own `PanelModel`
 * (the status line, the notes, the activity message, summary and colorbar ends, the selection),
 * in the same words; the template sentences come from the same `TemplatePlacement` the live view
 * reads, so a figure cannot say more, or less, than the screen. The contact list itself is not
 * restated: its rows are the keyboard path to the contacts, and each one's text is in its
 * circle's `<title>`.
 *
 * The SVG export is always the three 2D views (a vector file cannot hold the 3D picture). The PNG
 * is the 3D canvas's current frame when the live view is 3D, and the same three views otherwise.
 *
 * Seam for IS-V2 (template anatomy): `TemplatePlacement`. The panel asks `templatePlacementFor`
 * (in `panel.ts`) for one per state; it is null for every frame IS-V2 has not marked as a
 * registered template placement, and then no outline is drawn and no template sentence is said.
 * When it is not null, it carries the outlines from `views.json` (`parseViewOutlines`), the
 * positions to draw (in the template's millimeters, transformed by IS-V2's own code; absent means
 * as declared) and the template and "approximate" sentences, which the views and the files both
 * draw.
 */

import { colorFor } from "./activity";
import { type MatchKind, matchTag } from "./channel-match";
import { RAVE_CREDIT, creditSvg, doiUrl, paintCredit } from "./credit";
import type { ChannelJoin, Frame, RawCells, Units, Vec3 } from "./geometry";
import type { PanelModel, PanelState } from "./panel";
import {
  LETTER_PX,
  type Region,
  TITLE_INSET_PX,
  type TemplateOutlines,
  VIEWS_SENTENCE,
  type Views2d,
  type Views2dContact,
  escapeXml,
  layoutViews,
  viewsMarkup,
} from "./views2d";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Resolved CSS colors of the theme tokens, read by the caller from the page. */
export interface FigureTheme {
  /** `--color-bg` */
  background: string;
  /** `--color-fg` */
  foreground: string;
  /** `--color-fg-muted` */
  muted: string;
  /** `--color-border` */
  border: string;
  /** `--brand-electrode`, the contact color while no value colors it */
  contact: string;
}

/** IS-V2's seam: what a registered template placement adds to the views and to the files. */
export interface TemplatePlacement {
  /** The outlines to draw, from `views.json`. */
  outlines: TemplateOutlines;
  /** One position per placed contact, in the template's millimeters; absent: as declared. */
  positions?: readonly (Vec3 | null)[];
  /** True when the positions are a conversion or another template variant: each title says "approximate". */
  approximate: boolean;
  /** The sentences the screen says about the template: its label (with "approximate" where it applies) and its notice. */
  labels: readonly string[];
  /** Addresses behind those sentences (the reference, the license), for the SVG's metadata. */
  references: readonly string[];
}

export interface ExportInput {
  state: PanelState;
  /** `viewModel(state)`, the words and numbers the screen shows. */
  model: PanelModel;
  /** `contactColors(state, palette)`: four values (r, g, b, alpha) per placed contact. */
  colors: Float32Array | null;
  theme: FigureTheme;
  /** `templatePlacementFor(state)`. */
  template: TemplatePlacement | null;
  /** The frame as the status line names it (`frameName(...)`). */
  frameLabel: string;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The recording's file name without its extension, from the path alone. */
export function recordingStem(path: string): string {
  const base = path.split("/").pop() ?? "";
  const stem = base.split(".")[0].replace(/[^A-Za-z0-9_-]/g, "_");
  return stem === "" ? "recording" : stem;
}

/**
 * The frame as a file-name part, lowercase. Only closed vocabularies reach it: a standard
 * identifier, `ACPC`, `ScanRAS`, `Other`, `Pixels`; any other label (free text) is `unknown`.
 */
export function frameFileLabel(frame: Frame | null): string {
  let label: string;
  switch (frame?.kind) {
    case "template":
      label = frame.identifier;
      break;
    case "native":
    case "pixels":
    case "described":
      label = frame.declared;
      break;
    default:
      label = "unknown";
  }
  return label.toLowerCase().replace(/[^a-z0-9]/g, "") || "unknown";
}

export function figureFileName(input: ExportInput, extension: "png" | "svg"): string {
  const rec = input.state.recording;
  const stem = recordingStem(rec?.path ?? "");
  return `${stem}_contacts_${frameFileLabel(input.state.placement?.space.frame ?? null)}.${extension}`;
}

// ---------------------------------------------------------------------------
// The figure
// ---------------------------------------------------------------------------

export const FIGURE_WIDTH = 960;
const MARGIN = 24;
const VIEWS_HEIGHT = 300;
const IMAGE_MAX_HEIGHT = 520;
const COLORBAR_HEIGHT = 12;
const COLORBAR_STEPS = 48;
const LABEL_PX = 12;
const LABEL_LINE = 16;
const LABEL_GAP = 6;
/** The banner's lines wrap at this share of the content width: bold text is wider than the estimate. */
const BANNER_WRAP_SHARE = 0.92;
const BANNER_GAP = 10;
const TITLE_PX = 16;
/** Empty band at the bottom where the credit sits, so it covers no label, view or image. */
const FOOTER_HEIGHT = 44;
/** The PNG is drawn at this many pixels per figure pixel, whatever the screen's ratio. */
export const EXPORT_SCALE = 2;
export const FIGURE_FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

export type LabelRole =
  | "status"
  | "frame"
  | "template"
  | "note"
  | "webgl"
  | "axes"
  | "scale"
  | "selected"
  | "measure"
  | "activity";

export interface FigureLabel {
  id: string;
  role: LabelRole;
  text: string;
}

/** One wrapped line of a label; every line but the last keeps its trailing space. */
export interface PlacedLine {
  labelId: string;
  text: string;
  x: number;
  /** Baseline. */
  y: number;
}

export interface ColorbarPlan {
  steps: { x: number; width: number; fill: string }[];
  y: number;
  height: number;
  lo: { text: string; x: number };
  hi: { text: string; x: number };
  textY: number;
}

export interface Figure {
  width: number;
  height: number;
  title: string;
  titleY: number;
  theme: FigureTheme;
  recording: { datasetId: string; version: string; path: string };
  frameLabel: string;
  /**
   * The units banner (`units-banner.ts`), wrapped, right under the title and above the picture, in
   * bold foreground text; null when the panel shows none.
   */
  banner: { text: string; lines: PlacedLine[] } | null;
  labels: FigureLabel[];
  /** Addresses of the template's reference and license, when a template is drawn. */
  references: string[];
  lines: PlacedLine[];
  /** The 3D frame's box, when the PNG draws it; null when the three views are drawn. */
  image: Region | null;
  views: Views2d | null;
  colorbar: ColorbarPlan | null;
  /** The band the credit is painted in. */
  footer: Region;
}

export type TextMeasure = (text: string, fontPx: number) => number;

/** Width of `text` in `fontPx` pixels when nothing can measure it: a mean glyph advance. */
export const estimateWidth: TextMeasure = (text, fontPx) => text.length * fontPx * 0.56;

/**
 * Greedy wrap at spaces; a word wider than the line is split. A line that ends at a space keeps
 * it, so the lines joined are the text again.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  fontPx: number,
  measure: TextMeasure,
): string[] {
  const words = text.split(" ").filter((w) => w !== "");
  const lines: { text: string; space: boolean }[] = [];
  let line = "";
  const push = (space: boolean) => {
    if (line !== "") lines.push({ text: line, space });
    line = "";
  };
  for (let word of words) {
    while (measure(word, fontPx) > maxWidth && word.length > 1) {
      let cut = word.length - 1;
      while (cut > 1 && measure(word.slice(0, cut), fontPx) > maxWidth) cut -= 1;
      push(true);
      lines.push({ text: word.slice(0, cut), space: false });
      word = word.slice(cut);
    }
    const candidate = line === "" ? word : `${line} ${word}`;
    if (line !== "" && measure(candidate, fontPx) > maxWidth) {
      push(true);
      line = word;
    } else {
      line = candidate;
    }
  }
  push(false);
  if (lines.length === 0) return [""];
  return lines.map((l, i) => (l.space && i < lines.length - 1 ? `${l.text} ` : l.text));
}

const css255 = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);

/** The words the screen shows around the picture, in the order it shows them. */
export function figureLabels(input: ExportInput, withViews: boolean): FigureLabel[] {
  const { model, template } = input;
  const out: FigureLabel[] = [];
  const add = (role: LabelRole, text: string | null | undefined) => {
    if (text !== null && text !== undefined && text !== "") {
      out.push({ id: `label-${out.length}`, role, text });
    }
  };
  add("status", model.status);
  if (model.frames) {
    const selected = model.frames.options.find((o) => o.index === model.frames?.selected);
    add("frame", selected ? `Frame ${selected.label}` : null);
  }
  // The three views say what the seam says; the 3D frame says what the panel's model said when the
  // frame was drawn (a surface still loading, or one that failed, is said in those words).
  if (withViews) {
    for (const sentence of template?.labels ?? []) add("template", sentence);
  } else if (model.template) {
    const t = model.template;
    if (t.status === "ready") {
      add("template", t.label);
      add("template", t.notice);
    } else {
      add("template", t.sentence);
    }
  }
  for (const note of model.notes) add("note", note);
  if (model.stage.kind === "no_webgl") add("webgl", model.stage.sentence);
  if (withViews) add("axes", VIEWS_SENTENCE);
  // Under the units banner the views have no scale bar: the figure says their extent in words.
  if (withViews) add("scale", model.scale);
  const texts = contactTexts(input, withViews ? "seam" : "model");
  const picked = model.contacts.flatMap((c, i) => (c.selected ? [contactTitle(texts[i])] : []));
  if (model.selectedChannel !== null) add("selected", `Selected channel: ${model.selectedChannel}`);
  if (picked.length > 0) add("selected", `Selected: ${picked.join(" | ")}`);
  const a = model.activity;
  if (a) {
    add("measure", a.measure);
    add("activity", a.message);
    add("activity", a.summary);
    add("activity", a.noData);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a contact is called, and where it is: declared once, read by the list, the circles'
// titles, the selection line of the files and the files' metadata.
// ---------------------------------------------------------------------------

const triple = (p: Vec3, show: (v: number) => string): string => `(${p.map(show).join(", ")})`;
const millimeters = (v: number): string => String(Math.round(v * 1000) / 1000 || 0);

/**
 * What the dataset recorded for a contact, in the file's own words: x, y and z exactly as the
 * electrodes file wrote them (`-7.589096499647889e-05`, `-5.0` and `63.150000000000006` stay what
 * they are; the parser's numbers are for placing the contact, never for this line), the file's
 * unit word (`m`, `cm`, `mm`, `pixels`) and the declared frame. A `size` the file gives is added exactly as
 * written, with no unit of ours; an `n/a` or empty one is left out, since nothing was recorded. A unit the file leaves
 * out, or writes as `n/a`, is said not to be declared; any other word the view does not convert is
 * quoted.
 */
export function recordedLocation(raw: RawCells, units: Units, frameLabel: string): string {
  let unit: string;
  if (units.unitsDeclared && units.declared !== null) unit = ` ${units.declared}`;
  else if (units.declared === null || units.declared === "n/a") unit = ", units not declared";
  else unit = `, units "${units.declared}" (not converted)`;
  const size =
    raw.size === null || raw.size === "" || raw.size === "n/a" ? "" : `, size ${raw.size}`;
  return `recorded (${raw.x}, ${raw.y}, ${raw.z})${unit}, frame: ${frameLabel}${size}`;
}

/** The template position, only where a registered template placement gives one. */
export function templateLocation(position: Vec3, approximate: boolean): string {
  return `template ${triple(position, millimeters)} mm${approximate ? ", approximate" : ""}`;
}

/** A channel that uses a contact, and how its name reached it. */
export interface ChannelRef {
  /** The channel's own name, as the recording gave it. */
  name: string;
  /** `exact` for the file's own name; anything else is said beside the name. */
  kind: MatchKind;
}

export interface ContactText {
  /** The contact's name as the electrodes file records it. */
  name: string;
  /** The channels that use it, beside the name, each with how its name reached the contact. */
  channels: readonly ChannelRef[];
  /** `recordedLocation(...)`. */
  recorded: string;
  /** `templateLocation(...)` or null. */
  template: string | null;
  /** The activity value or why there is none; null when the overlay shows nothing. */
  value: string | null;
}

/**
 * The channels beside a contact's name: `channel LTP1-20000 [suffix match]`. The recording's own
 * name comes first in the recording's words; a join that is not the file's own name carries its
 * kind in brackets, and an exact name carries nothing. `withTags: false` leaves the brackets out
 * for a surface that shows the kind apart (the list's small tag).
 */
export function channelClause(channels: readonly ChannelRef[], withTags = true): string {
  if (channels.length === 0) return "";
  const parts = channels.map((c) => {
    const tag = withTags ? matchTag(c.kind) : null;
    return tag ? `${c.name} [${tag}]` : c.name;
  });
  return `channel${channels.length === 1 ? "" : "s"} ${parts.join(", ")}`;
}

/**
 * One sentence per contact: name first, channel beside it, where it was recorded, the rest. The
 * circle titles, the "Selected:" line of the files and the live list's rows all say it this way.
 */
export function contactTitle(t: ContactText): string {
  const clause = channelClause(t.channels);
  return [clause === "" ? t.name : `${t.name} (${clause})`, t.recorded, t.template, t.value]
    .filter((x): x is string => !!x)
    .join("; ");
}

/**
 * What a channel is, in terms of the contacts it was joined to, for the channel that is selected:
 * `LAF1-LAF2 (contacts LAF1, LAF2; midpoint)` for a bipolar channel, `LTP1-20000 (contact LTP1;
 * suffix match)` for a name that joined by a rule. Null for a channel whose name is its contact's
 * own, where there is nothing to add.
 */
export function channelProvenance(join: ChannelJoin): string | null {
  if (join.status === "unlocated" || join.matchKind === null) return null;
  const tag = matchTag(join.matchKind);
  if (join.status === "bipolar") {
    return `${join.channel} (contacts ${join.contacts.join(", ")}; midpoint${tag ? `; ${tag}` : ""})`;
  }
  return tag ? `${join.channel} (contact ${join.contacts[0]}; ${tag})` : null;
}

/**
 * `seam`: the three 2D views and the SVG, whose template line comes from the seam's positions.
 * `model`: the live 3D canvas's PNG, whose template line is the model's (the surface may not have
 * arrived, and then the canvas shows none).
 */
type TemplateSource = "seam" | "model";

function contactTexts(input: ExportInput, source: TemplateSource): ContactText[] {
  const { state, model, template } = input;
  const placement = state.placement;
  if (!placement) return [];
  return placement.contacts.map((c, i) => {
    const row = model.contacts[i];
    const tp = template?.positions?.[i];
    return {
      name: c.name,
      channels: row?.links ?? [],
      recorded: row?.recorded ?? "",
      template:
        source === "model"
          ? (row?.template ?? null)
          : tp
            ? templateLocation(tp, template?.approximate ?? false)
            : null,
      value: row?.value ?? null,
    };
  });
}

/** Contacts as the views draw them: fill and opacity from the panel's colors, title from `contactTitle`. */
export function viewContacts(input: ExportInput): Views2dContact[] {
  const { state, colors, theme, template } = input;
  const placement = state.placement;
  if (!placement) return [];
  const selected = new Set(state.selection.contacts);
  const texts = contactTexts(input, "seam");
  return placement.contacts.map((c, i) => {
    const fill = colors
      ? `rgb(${css255(colors[i * 4])}, ${css255(colors[i * 4 + 1])}, ${css255(colors[i * 4 + 2])})`
      : theme.contact;
    return {
      index: i,
      position: template?.positions ? (template.positions[i] ?? null) : c.position,
      size: c.size,
      fill,
      opacity: colors ? colors[i * 4 + 3] : 1,
      selected: selected.has(i),
      title: contactTitle(texts[i]),
    };
  });
}

export function isDrawable(input: ExportInput): boolean {
  const kind = input.model.stage.kind;
  return (
    input.state.placement !== null &&
    input.state.recording !== null &&
    (kind === "canvas" || kind === "views2d" || kind === "no_webgl")
  );
}

/**
 * Lay the figure out. `image` is the size in pixels of the 3D frame the PNG will draw, or null to
 * draw the three views. Throws when the state has nothing drawn on screen.
 */
export function buildFigure(
  input: ExportInput,
  image: { width: number; height: number } | null,
  measure: TextMeasure = estimateWidth,
): Figure {
  if (!isDrawable(input) || !input.state.recording || !input.state.placement) {
    throw new Error("export: there are no contacts on screen to save");
  }
  const rec = input.state.recording;
  const placement = input.state.placement;
  const { theme, model } = input;
  const contentW = FIGURE_WIDTH - 2 * MARGIN;
  const labels = figureLabels(input, image === null);
  const title = `${rec.datasetId} ${rec.version}: ${recordingStem(rec.path)}`;
  const titleY = MARGIN + TITLE_PX - 2;
  let y = MARGIN + 28;

  // The banner comes first, above the picture, so a figure cannot be read without it. It is drawn
  // bold, which is wider than the regular text the width estimate describes, so it wraps early.
  let banner: Figure["banner"] = null;
  if (model.banner) {
    const lines: PlacedLine[] = wrapText(
      model.banner,
      contentW * BANNER_WRAP_SHARE,
      LABEL_PX,
      measure,
    ).map((text) => {
      const line: PlacedLine = { labelId: "banner", text, x: MARGIN, y: y + LABEL_LINE - 4 };
      y += LABEL_LINE;
      return line;
    });
    banner = { text: model.banner, lines };
    y += BANNER_GAP;
  }

  let imageBox: Region | null = null;
  let views: Views2d | null = null;
  if (image) {
    // Fit the content width and the height cap, but never wider than the frame's own pixel count in
    // figure pixels. The PNG is drawn at EXPORT_SCALE canvas pixels per figure pixel, so the frame
    // is upsampled by exactly EXPORT_SCALE (smoothed); a larger box would only blur it more.
    const maxW = Math.min(contentW, image.width);
    const h = Math.min(IMAGE_MAX_HEIGHT, (maxW * image.height) / Math.max(1, image.width));
    const w = (h * image.width) / Math.max(1, image.height);
    imageBox = { x: MARGIN + (contentW - w) / 2, y, width: w, height: h };
    y += h + 12;
  } else {
    views = layoutViews({
      contacts: viewContacts(input),
      millimeters: placement.space.units.unit === "mm",
      template: input.template?.outlines ?? null,
      arrangement: "row",
      region: { x: MARGIN, y, width: contentW, height: VIEWS_HEIGHT },
    });
    y += VIEWS_HEIGHT + 12;
  }

  let colorbar: ColorbarPlan | null = null;
  const bar = model.activity?.colorbar;
  const shown = input.state.activity.shown;
  if (bar && shown) {
    const loW = measure(bar.lo, LABEL_PX);
    const hiW = measure(bar.hi, LABEL_PX);
    const x0 = MARGIN + loW + 8;
    const x1 = FIGURE_WIDTH - MARGIN - hiW - 8;
    const stepW = (x1 - x0) / COLORBAR_STEPS;
    const scale = shown.scale;
    const steps = Array.from({ length: COLORBAR_STEPS }, (_, k) => {
      const t = (k + 0.5) / COLORBAR_STEPS;
      const level = scale.lo + t * (scale.hi - scale.lo);
      // A z-scored scale takes the value whose z is `level`; the panel uses the plain one.
      const value =
        scale.kind === "zscore" && scale.mean !== null && scale.sd !== null
          ? scale.mean + level * scale.sd
          : level;
      const rgb = colorFor(scale, value);
      return {
        x: x0 + k * stepW,
        width: stepW + 0.5,
        fill: rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : theme.border,
      };
    });
    colorbar = {
      steps,
      y,
      height: COLORBAR_HEIGHT,
      lo: { text: bar.lo, x: MARGIN },
      hi: { text: bar.hi, x: FIGURE_WIDTH - MARGIN },
      textY: y + COLORBAR_HEIGHT - 2,
    };
    y += COLORBAR_HEIGHT + 10;
  }

  const lines: PlacedLine[] = [];
  for (const label of labels) {
    for (const text of wrapText(label.text, contentW, LABEL_PX, measure)) {
      lines.push({ labelId: label.id, text, x: MARGIN, y: y + LABEL_LINE - 4 });
      y += LABEL_LINE;
    }
    y += LABEL_GAP;
  }

  const height = Math.ceil(y + FOOTER_HEIGHT);
  return {
    width: FIGURE_WIDTH,
    height,
    title,
    titleY,
    theme,
    recording: { datasetId: rec.datasetId, version: rec.version, path: rec.path },
    frameLabel: input.frameLabel,
    banner,
    labels,
    references: image ? [] : [...(input.template?.references ?? [])],
    lines,
    image: imageBox,
    views,
    colorbar,
    footer: { x: 0, y: height - FOOTER_HEIGHT, width: FIGURE_WIDTH, height: FOOTER_HEIGHT },
  };
}

// ---------------------------------------------------------------------------
// Raster: the draw list
// ---------------------------------------------------------------------------

export type DrawOp =
  | { op: "background"; fill: string }
  | {
      op: "text";
      /** The label this line belongs to, or "title" / "view" / "colorbar". */
      label: string;
      text: string;
      x: number;
      y: number;
      size: number;
      fill: string;
      bold: boolean;
      anchor: "start" | "middle" | "end";
    }
  | { op: "rect"; x: number; y: number; width: number; height: number; fill: string }
  /** A view's frame: an outline, no fill. */
  | { op: "frame"; x: number; y: number; width: number; height: number; stroke: string }
  | {
      op: "path";
      role: "template-outline";
      d: string;
      fill: string;
      fillOpacity: number;
      stroke: string;
    }
  | {
      op: "circle";
      contact: number;
      cx: number;
      cy: number;
      r: number;
      fill: string;
      opacity: number;
      stroke: string;
      strokeWidth: number;
    }
  | { op: "image"; x: number; y: number; width: number; height: number }
  /** The credit, painted with `paintCredit` at the export canvas's own ratio. Always the last op. */
  | { op: "credit" };

/**
 * The raster export's operations in painting order. Everything is in figure pixels. The credit is
 * appended after every other operation, so no label, view or image is drawn over it.
 */
export function buildDrawList(figure: Figure): DrawOp[] {
  const { theme } = figure;
  const ops: DrawOp[] = [{ op: "background", fill: theme.background }];
  ops.push({
    op: "text",
    label: "title",
    text: figure.title,
    x: MARGIN,
    y: figure.titleY,
    size: TITLE_PX,
    fill: theme.foreground,
    bold: true,
    anchor: "start",
  });
  for (const line of figure.banner?.lines ?? []) {
    ops.push({
      op: "text",
      label: "banner",
      text: line.text,
      x: line.x,
      y: line.y,
      size: LABEL_PX,
      fill: theme.foreground,
      bold: true,
      anchor: "start",
    });
  }
  if (figure.image) {
    ops.push({ op: "image", ...figure.image });
  }
  for (const cell of figure.views?.cells ?? []) {
    ops.push({ op: "frame", ...cell.frame, stroke: theme.border });
    ops.push({
      op: "text",
      label: "view",
      text: cell.title,
      x: cell.box.x + TITLE_INSET_PX,
      y: cell.box.y + 13,
      size: 12,
      fill: theme.foreground,
      bold: true,
      anchor: "start",
    });
    for (const l of cell.letters) {
      ops.push({
        op: "text",
        label: "orientation",
        text: l.text,
        x: l.x,
        y: l.y,
        size: LETTER_PX,
        fill: theme.muted,
        bold: false,
        anchor: l.anchor,
      });
    }
    if (cell.outlinePath) {
      ops.push({
        op: "path",
        role: "template-outline",
        d: cell.outlinePath,
        fill: theme.muted,
        fillOpacity: 0.12,
        stroke: theme.muted,
      });
    }
    for (const d of cell.dots) {
      ops.push({
        op: "circle",
        contact: d.index,
        cx: d.cx,
        cy: d.cy,
        r: d.selected ? d.r + 1 : d.r,
        fill: d.fill,
        opacity: d.opacity,
        stroke: d.selected ? theme.foreground : theme.border,
        strokeWidth: d.selected ? 2 : 0.5,
      });
    }
  }
  const bar = figure.colorbar;
  if (bar) {
    for (const s of bar.steps) {
      ops.push({ op: "rect", x: s.x, y: bar.y, width: s.width, height: bar.height, fill: s.fill });
    }
    for (const [end, anchor] of [
      [bar.lo, "start"],
      [bar.hi, "end"],
    ] as const) {
      ops.push({
        op: "text",
        label: "colorbar",
        text: end.text,
        x: end.x,
        y: bar.textY,
        size: LABEL_PX,
        fill: theme.muted,
        bold: false,
        anchor,
      });
    }
  }
  for (const line of figure.lines) {
    ops.push({
      op: "text",
      label: line.labelId,
      text: line.text,
      x: line.x,
      y: line.y,
      size: LABEL_PX,
      fill: theme.muted,
      bold: false,
      anchor: "start",
    });
  }
  // Last, always: nothing above can be drawn over it.
  ops.push({ op: "credit" });
  return ops;
}

/** The subset of the canvas 2D context the draw list uses. */
export type DrawContext = CanvasRenderingContext2D;

/**
 * Run a draw list on a canvas `width` by `height` canvas pixels, `scale` canvas pixels per figure
 * pixel. `image` is the 3D frame for an `image` operation. The credit is painted in canvas pixels
 * with this canvas's own ratio, `scale`, so it is as large on screen as on a 1x export.
 */
export function rasterize(
  ctx: DrawContext,
  ops: readonly DrawOp[],
  options: {
    width: number;
    height: number;
    scale: number;
    theme: FigureTheme;
    image?: CanvasImageSource | null;
  },
): void {
  const { width, height, scale, theme } = options;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  for (const op of ops) {
    switch (op.op) {
      case "background":
        ctx.fillStyle = op.fill;
        ctx.fillRect(0, 0, width / scale, height / scale);
        break;
      case "text":
        ctx.font = `${op.bold ? "600 " : ""}${op.size}px ${FIGURE_FONT}`;
        ctx.textAlign = op.anchor === "middle" ? "center" : op.anchor;
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = op.fill;
        ctx.fillText(op.text, op.x, op.y);
        break;
      case "rect":
        ctx.fillStyle = op.fill;
        ctx.fillRect(op.x, op.y, op.width, op.height);
        break;
      case "frame":
        ctx.strokeStyle = op.stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(op.x, op.y, op.width, op.height);
        break;
      case "path": {
        const p = new Path2D(op.d);
        ctx.globalAlpha = op.fillOpacity;
        ctx.fillStyle = op.fill;
        ctx.fill(p, "evenodd");
        ctx.globalAlpha = 1;
        ctx.strokeStyle = op.stroke;
        ctx.lineWidth = 1;
        ctx.lineJoin = "round";
        ctx.stroke(p);
        break;
      }
      case "circle":
        ctx.beginPath();
        ctx.arc(op.cx, op.cy, op.r, 0, Math.PI * 2);
        ctx.globalAlpha = op.opacity;
        ctx.fillStyle = op.fill;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = op.stroke;
        ctx.lineWidth = op.strokeWidth;
        ctx.stroke();
        break;
      case "image":
        if (options.image) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(options.image, op.x, op.y, op.width, op.height);
        }
        break;
      case "credit":
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        paintCredit(
          ctx,
          width,
          height,
          { background: theme.background, foreground: theme.foreground },
          scale,
        );
        ctx.restore();
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Vector: the SVG
// ---------------------------------------------------------------------------

const num = (n: number): string => String(Math.round(n * 100) / 100);

function labelTexts(figure: Figure): string {
  return figure.labels
    .map((label) => {
      const lines = figure.lines.filter((l) => l.labelId === label.id);
      const first = lines[0];
      const tspans = lines
        .map(
          (l, i) =>
            `<tspan x="${num(l.x)}"${i === 0 ? "" : ` y="${num(l.y)}"`}>${escapeXml(l.text)}</tspan>`,
        )
        .join("");
      return `<text id="${label.id}" data-role="${label.role}" x="${num(first.x)}" y="${num(first.y)}" font-family="${escapeXml(FIGURE_FONT)}" font-size="${LABEL_PX}" fill="${escapeXml(figure.theme.muted)}">${tspans}</text>`;
    })
    .join("");
}

function bannerMarkup(figure: Figure): string {
  const banner = figure.banner;
  if (!banner || banner.lines.length === 0) return "";
  const first = banner.lines[0];
  const tspans = banner.lines
    .map(
      (l, i) =>
        `<tspan x="${num(l.x)}"${i === 0 ? "" : ` y="${num(l.y)}"`}>${escapeXml(l.text)}</tspan>`,
    )
    .join("");
  return `<g id="banner"><text data-role="banner" x="${num(first.x)}" y="${num(first.y)}" font-family="${escapeXml(FIGURE_FONT)}" font-size="${LABEL_PX}" font-weight="600" fill="${escapeXml(figure.theme.foreground)}">${tspans}</text></g>`;
}

function colorbarMarkup(figure: Figure): string {
  const bar = figure.colorbar;
  if (!bar) return "";
  const rects = bar.steps
    .map(
      (s) =>
        `<rect x="${num(s.x)}" y="${num(bar.y)}" width="${num(s.width)}" height="${num(bar.height)}" fill="${escapeXml(s.fill)}"/>`,
    )
    .join("");
  const text = (end: { text: string; x: number }, anchor: string) =>
    `<text x="${num(end.x)}" y="${num(bar.textY)}" text-anchor="${anchor}" font-family="${escapeXml(FIGURE_FONT)}" font-size="${LABEL_PX}" fill="${escapeXml(figure.theme.muted)}">${escapeXml(end.text)}</text>`;
  return `<g id="colorbar">${rects}${text(bar.lo, "start")}${text(bar.hi, "end")}</g>`;
}

/**
 * The vector export as one SVG document. The credit's `<g>` is the last element, so nothing
 * above it can cover it, and the document is self-describing: its `<metadata>` names the dataset,
 * version, recording path, frame and every label, and carries the credit line and its address.
 */
export function buildSvg(figure: Figure): string {
  const { theme } = figure;
  const rec = figure.recording;
  const description = `Contacts of ${rec.path}, frame ${figure.frameLabel}.`;
  const metadata = [
    '<metadata id="figure-metadata" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:nemar="urn:nemar:ieeg-spatial-figure:1">',
    `<dc:title>${escapeXml(figure.title)}</dc:title>`,
    `<nemar:dataset>${escapeXml(rec.datasetId)}</nemar:dataset>`,
    `<nemar:version>${escapeXml(rec.version)}</nemar:version>`,
    `<nemar:recording>${escapeXml(rec.path)}</nemar:recording>`,
    `<nemar:frame>${escapeXml(figure.frameLabel)}</nemar:frame>`,
    ...(figure.banner ? [`<dc:description>${escapeXml(figure.banner.text)}</dc:description>`] : []),
    ...figure.labels.map((l) => `<dc:description>${escapeXml(l.text)}</dc:description>`),
    ...figure.references.map((r) => `<dc:relation>${escapeXml(r)}</dc:relation>`),
    `<dc:description>${escapeXml(RAVE_CREDIT.text)}</dc:description>`,
    `<dc:relation>${escapeXml(RAVE_CREDIT.href)}</dc:relation>`,
    `<dc:relation>${escapeXml(doiUrl())}</dc:relation>`,
    "</metadata>",
  ].join("");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${figure.width} ${figure.height}" width="${figure.width}" height="${figure.height}" role="img" aria-labelledby="figure-title figure-desc">`,
    `<title id="figure-title">${escapeXml(figure.title)}</title>`,
    `<desc id="figure-desc">${escapeXml(description)}</desc>`,
    metadata,
    `<rect width="${figure.width}" height="${figure.height}" fill="${escapeXml(theme.background)}"/>`,
    `<text x="${MARGIN}" y="${num(figure.titleY)}" font-family="${escapeXml(FIGURE_FONT)}" font-size="${TITLE_PX}" font-weight="600" fill="${escapeXml(theme.foreground)}">${escapeXml(figure.title)}</text>`,
    bannerMarkup(figure),
    figure.views
      ? `<g id="views">${viewsMarkup(figure.views, { foreground: theme.foreground, muted: theme.muted, border: theme.border }, FIGURE_FONT)}</g>`
      : "",
    colorbarMarkup(figure),
    `<g id="labels">${labelTexts(figure)}</g>`,
    // Last, always: the credit and its link, inside the file.
    creditSvg(figure.width, figure.height, {
      background: theme.background,
      foreground: theme.foreground,
    }),
    "</svg>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface ExportFile {
  filename: string;
  mime: string;
  data: Blob | string;
}

/** The SVG figure of the state on screen: always the three views. */
export function exportSvg(input: ExportInput): ExportFile {
  const figure = buildFigure(input, null);
  return {
    filename: figureFileName(input, "svg"),
    mime: "image/svg+xml",
    data: buildSvg(figure),
  };
}

/**
 * The PNG figure of the state on screen. `frame3d` is the 3D canvas's current frame
 * (`BrainRenderer.snapshot()`), drawn when the live view is 3D; null draws the three views.
 */
export async function exportPng(
  input: ExportInput,
  frame3d: ImageData | null,
  doc: Document = document,
): Promise<ExportFile> {
  const probe = doc.createElement("canvas").getContext("2d");
  if (!probe) throw new Error("export: no 2D canvas is available");
  const measure: TextMeasure = (text, size) => {
    probe.font = `${size}px ${FIGURE_FONT}`;
    return probe.measureText(text).width;
  };
  const figure = buildFigure(
    input,
    frame3d ? { width: frame3d.width, height: frame3d.height } : null,
    measure,
  );
  const canvas = doc.createElement("canvas");
  canvas.width = Math.ceil(figure.width * EXPORT_SCALE);
  canvas.height = Math.ceil(figure.height * EXPORT_SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("export: no 2D canvas is available");

  let image: CanvasImageSource | null = null;
  if (frame3d) {
    const tmp = doc.createElement("canvas");
    tmp.width = frame3d.width;
    tmp.height = frame3d.height;
    const tctx = tmp.getContext("2d");
    if (!tctx) throw new Error("export: no 2D canvas is available");
    tctx.putImageData(frame3d, 0, 0);
    image = tmp;
  }
  rasterize(ctx, buildDrawList(figure), {
    width: canvas.width,
    height: canvas.height,
    scale: EXPORT_SCALE,
    theme: figure.theme,
    image,
  });
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("export: the PNG could not be encoded"))),
      "image/png",
    ),
  );
  return { filename: figureFileName(input, "png"), mime: "image/png", data: blob };
}

/** How long the download's address lives, so the navigation can start before it is revoked. */
export const REVOKE_DELAY_MS = 1000;

/** What the panel says when the browser refuses the download. */
export function downloadFailedSentence(filename: string): string {
  return `Couldn't start the download of ${filename}. Check that this browser allows downloads from this page, then try again.`;
}

/** Hand a file to the browser as a download. Throws when it cannot start one. */
export function downloadFile(
  file: ExportFile,
  doc: Document = document,
  schedule: (run: () => void, ms: number) => void = (run, ms) => void setTimeout(run, ms),
): void {
  const blob =
    typeof file.data === "string"
      ? new Blob([file.data], { type: `${file.mime};charset=utf-8` })
      : file.data;
  const url = URL.createObjectURL(blob);
  try {
    const link = doc.createElement("a");
    link.href = url;
    link.download = file.filename;
    doc.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Give the navigation a tick to start before the blob goes away.
    schedule(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}
