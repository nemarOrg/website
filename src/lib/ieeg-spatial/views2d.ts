/**
 * Three orthographic views of the contacts (card IS-V3): the panel's picture when WebGL2 is
 * missing or the reader chooses it, and the figure the Save SVG and 2D Save PNG exports draw.
 * Pure geometry and markup, no DOM, so Node tests read every number and every element.
 *
 * What it draws:
 * - The left, top and front views of the contacts, one shared scale in all three so sizes can
 *   be compared. The axes are read the way the 3D view reads them: x toward the subject's right,
 *   y anterior, z superior, whatever the declared frame. The orientation is the 3D presets':
 *   in the left view anterior is on the left, in the top view anterior is up, and in the front
 *   view the subject's right is on the screen's left.
 * - One `<circle>` per contact that has a position, in a `<g>` per view, each with a `<title>`
 *   (the contact's name, its channel and its value). A contact without a finite position is
 *   never drawn; the caller's list of unlocated channels says what is missing.
 * - Template outlines only when the caller passes a `TemplateOutlines`. This module never
 *   decides that: IS-V2 marks a frame as a registered template placement (see `TemplateSeam` in
 *   `export.ts`), and the outlines it hands over come from `views.json`, parsed by
 *   `parseViewOutlines`. A native, described, pixel or unknown frame gets none.
 *
 * What it never does: transform a position, snap a contact to an outline, or invent a scale. The
 * contact radius follows the 3D view's rule (`contactRadius`, millimeters) only when the units
 * are millimeters; otherwise every contact has one fixed radius in pixels.
 */

import { contactRadius } from "./brain-gl";
import type { Vec3 } from "./geometry";

export type ViewName = "left" | "top" | "front";
export const VIEW_NAMES: readonly ViewName[] = ["left", "top", "front"];

interface ViewDef {
  title: string;
  /** Axis indices (0 x, 1 y, 2 z) of the screen's horizontal and vertical. */
  h: 0 | 1 | 2;
  v: 0 | 1 | 2;
  /** +1 when the screen's right is the axis's positive direction, -1 when it is the negative. */
  hSign: 1 | -1;
  /** The axis the eye looks along, and the sign of "nearer the eye", for the drawing order. */
  depth: 0 | 1 | 2;
  nearSign: 1 | -1;
}

/** Orientation of each view, the same as camera.ts's presets (a test pins them together). */
export const VIEW_DEFS: Record<ViewName, ViewDef> = {
  left: { title: "Left", h: 1, v: 2, hSign: -1, depth: 0, nearSign: -1 },
  top: { title: "Top", h: 0, v: 1, hSign: 1, depth: 2, nearSign: 1 },
  front: { title: "Front", h: 0, v: 2, hSign: -1, depth: 1, nearSign: 1 },
};

/** The sentence that says how the axes are read; shown with the views, live and exported. */
export const VIEWS_SENTENCE =
  "Left, top and front views read the file's x, y and z as right, anterior and superior, as the 3D view does.";

/** Smallest dot, so a 0.5 mm contact on a wide view stays visible. CSS pixels. */
export const MIN_DOT_PX = 2.5;
/** Dot radius when the units carry no scale claim. CSS pixels. */
export const FIXED_DOT_PX = 3.5;
/** Room for a view's title above its drawing, and around it. CSS pixels. */
const TITLE_PX = 18;
const PAD_PX = 10;
/** A view's extent is never taken as less than this share of the widest, so a lone contact is not zoomed to infinity. */
const MIN_EXTENT_SHARE = 0.05;

// ---------------------------------------------------------------------------
// Template outlines (views.json)
// ---------------------------------------------------------------------------

export type Point2 = readonly [number, number];

export interface ViewOutline {
  axes: readonly [string, string];
  /** Closed polylines, [horizontal, vertical] in millimeters, unflipped; filled together, even-odd. */
  polylines: readonly (readonly Point2[])[];
}

export type TemplateOutlines = Record<ViewName, ViewOutline>;

/**
 * Read `views.json` of a vendored template (`brain-template-views v1`). Anything that is not
 * that format, or that lacks one of the three views or holds a non-finite number, throws: an
 * outline that cannot be read must not be replaced by a guess.
 */
export function parseViewOutlines(json: unknown): TemplateOutlines {
  const root = json as { format?: unknown; views?: Record<string, unknown> } | null;
  if (!root || root.format !== "brain-template-views v1" || typeof root.views !== "object") {
    throw new Error("views2d: not a brain-template-views v1 file");
  }
  const out = {} as Record<ViewName, ViewOutline>;
  for (const name of VIEW_NAMES) {
    const view = root.views?.[name] as { axes?: unknown; polylines?: unknown } | undefined;
    if (!view || !Array.isArray(view.axes) || !Array.isArray(view.polylines)) {
      throw new Error(`views2d: the ${name} view is missing from the template outlines`);
    }
    const polylines = view.polylines.map((ring) => {
      if (!Array.isArray(ring) || ring.length < 3)
        throw new Error(`views2d: ${name} has a short outline`);
      return ring.map((p) => {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) {
          throw new Error(`views2d: ${name} has an outline point that is not two numbers`);
        }
        return [p[0], p[1]] as const;
      });
    });
    out[name] = { axes: [String(view.axes[0]), String(view.axes[1])], polylines };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface Views2dContact {
  /** The contact's index in the panel's placement, the id a click or the list uses. */
  index: number;
  /** Null for a contact without a position: it is not drawn. */
  position: Vec3 | null;
  size: number | null;
  /** A CSS color. */
  fill: string;
  /** 0 to 1. */
  opacity: number;
  selected: boolean;
  /** The circle's `<title>`: name, channel and value. */
  title: string;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Views2dInput {
  contacts: readonly Views2dContact[];
  /** True only when the positions are in millimeters (IS-C1 scaled them), so radii are real sizes. */
  millimeters: boolean;
  /** Outlines to draw behind the contacts; null for every frame without a registered template. */
  template: TemplateOutlines | null;
  /** Three views in a row, or a two by two grid for a narrow panel. */
  arrangement: "row" | "grid";
  region: Region;
}

export interface Dot {
  index: number;
  cx: number;
  cy: number;
  r: number;
  fill: string;
  opacity: number;
  selected: boolean;
  title: string;
}

export interface ViewCell {
  name: ViewName;
  title: string;
  /** The view's own box, in the same pixels as the dots. */
  box: Region;
  /** An SVG path (closed subpaths, fill with the even-odd rule) or null when no template is drawn. */
  outlinePath: string | null;
  /** Far to near, the selected contacts last. */
  dots: Dot[];
}

export interface Views2d {
  region: Region;
  cells: ViewCell[];
  /** Contacts that had a position, and so a dot in every cell. */
  drawn: number;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

function screenPoint(def: ViewDef, p: Vec3): [number, number] {
  return [def.hSign * p[def.h], p[def.v]];
}

function hasPosition(c: Views2dContact): c is Views2dContact & { position: Vec3 } {
  return !!c.position && c.position.length === 3 && c.position.every(Number.isFinite);
}

export function layoutViews(input: Views2dInput): Views2d {
  const { region } = input;
  const located = input.contacts.filter(hasPosition);
  const columns = input.arrangement === "row" ? 3 : 2;
  const rows = input.arrangement === "row" ? 1 : 2;
  const cellW = region.width / columns;
  const cellH = region.height / rows;
  const innerW = Math.max(1, cellW - 2 * PAD_PX);
  const innerH = Math.max(1, cellH - TITLE_PX - 2 * PAD_PX);

  // Extent of each view in screen millimeters (or declared units): contacts and outline points.
  const extents = VIEW_NAMES.map((name) => {
    const def = VIEW_DEFS[name];
    const pts: [number, number][] = located.map((c) => screenPoint(def, c.position));
    if (input.template) {
      for (const ring of input.template[name].polylines) {
        for (const [a, b] of ring) pts.push([def.hSign * a, b]);
      }
    }
    if (pts.length === 0) pts.push([0, 0]);
    const hs = pts.map((p) => p[0]);
    const vs = pts.map((p) => p[1]);
    return {
      minH: Math.min(...hs),
      maxH: Math.max(...hs),
      minV: Math.min(...vs),
      maxV: Math.max(...vs),
    };
  });
  const widest = Math.max(1e-9, ...extents.flatMap((e) => [e.maxH - e.minH, e.maxV - e.minV]));
  const floor = widest * MIN_EXTENT_SHARE;
  // One scale for all three views: the least generous of the three fits them all.
  const scale = Math.min(
    ...extents.map((e) =>
      Math.min(
        innerW / Math.max(e.maxH - e.minH, floor),
        innerH / Math.max(e.maxV - e.minV, floor),
      ),
    ),
  );

  const cells: ViewCell[] = VIEW_NAMES.map((name, i) => {
    const def = VIEW_DEFS[name];
    const e = extents[i];
    const box: Region = {
      x: region.x + (i % columns) * cellW,
      y: region.y + Math.floor(i / columns) * cellH,
      width: cellW,
      height: cellH,
    };
    const cx0 = box.x + cellW / 2 - ((e.minH + e.maxH) / 2) * scale;
    const cy0 = box.y + TITLE_PX + PAD_PX + innerH / 2 + ((e.minV + e.maxV) / 2) * scale;
    const px = (h: number): number => r2(cx0 + h * scale);
    const py = (v: number): number => r2(cy0 - v * scale);

    let outlinePath: string | null = null;
    if (input.template) {
      outlinePath = input.template[name].polylines
        .map(
          (ring) =>
            `${ring.map(([a, b], k) => `${k === 0 ? "M" : "L"}${px(def.hSign * a)} ${py(b)}`).join(" ")} Z`,
        )
        .join(" ");
    }

    const dots: Dot[] = located
      .map((c) => {
        const [h, v] = screenPoint(def, c.position);
        const near = def.nearSign * c.position[def.depth];
        const r = input.millimeters
          ? Math.max(MIN_DOT_PX, contactRadius(c.size) * scale)
          : FIXED_DOT_PX;
        return {
          near,
          dot: {
            index: c.index,
            cx: px(h),
            cy: py(v),
            r: r2(r),
            fill: c.fill,
            opacity: c.opacity,
            selected: c.selected,
            title: c.title,
          } satisfies Dot,
        };
      })
      // Far first, so a near contact covers a far one; a selected contact is always on top.
      .sort((a, b) => Number(a.dot.selected) - Number(b.dot.selected) || a.near - b.near)
      .map((d) => d.dot);

    return { name, title: VIEW_DEFS[name].title, box, outlinePath, dots };
  });

  return { region, cells, drawn: located.length };
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/** Resolved CSS colors of the theme tokens, read by the caller (`--color-*`, `--brand-electrode`). */
export interface ViewsTheme {
  foreground: string;
  muted: string;
  border: string;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The three `<g>` views as markup: a title, the outline when there is one, and a `<circle>` with
 * a `<title>` for every dot. The same markup is the live panel's picture and the exported file's
 * body, so what is saved is what was shown. `font` is the text's font family.
 */
export function viewsMarkup(views: Views2d, theme: ViewsTheme, font: string): string {
  return views.cells
    .map((cell) => {
      const parts = [
        `<g id="view-${cell.name}" data-view="${cell.name}">`,
        `<text x="${r2(cell.box.x + PAD_PX)}" y="${r2(cell.box.y + 13)}" font-family="${escapeXml(font)}" font-size="12" font-weight="600" fill="${escapeXml(theme.foreground)}">${escapeXml(cell.title)}</text>`,
      ];
      if (cell.outlinePath) {
        parts.push(
          `<path data-template-outline="" d="${cell.outlinePath}" fill="${escapeXml(theme.muted)}" fill-opacity="0.12" fill-rule="evenodd" stroke="${escapeXml(theme.muted)}" stroke-width="1" stroke-linejoin="round"/>`,
        );
      }
      for (const d of cell.dots) {
        const ring = d.selected
          ? ` stroke="${escapeXml(theme.foreground)}" stroke-width="2"`
          : ` stroke="${escapeXml(theme.border)}" stroke-width="0.5"`;
        parts.push(
          `<circle data-contact="${d.index}" cx="${d.cx}" cy="${d.cy}" r="${d.selected ? r2(d.r + 1) : d.r}" fill="${escapeXml(d.fill)}" fill-opacity="${r2(d.opacity)}"${ring}><title>${escapeXml(d.title)}</title></circle>`,
        );
      }
      parts.push("</g>");
      return parts.join("");
    })
    .join("");
}
