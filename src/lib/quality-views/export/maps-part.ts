/**
 * Scalp maps in the PNG export (website phase W8): every drawn map of a view, those never scrolled
 * into view included, painted by the page's own `paintFieldMap` with the contour lines
 * `SensorFieldHandle.drawnMaps()` hands over (`contoursOf`: a map off screen has none from the
 * worker, and gets them traced there). A chunk of its own, loaded as the export controls of a view
 * with maps open.
 */

import type { DrawnMap } from "../worker-client";
import type { Paint, Part } from "./palette";
import type { ExportField } from "./raster";

/** A map's square in CSS pixels: `MAP_SIZE` of `sensor-field-view.ts` (the tests hold them equal). */
export const MAP_PX = 160;
export const MAP_GAP = 16;
const MAP_LABEL = 16;
/** Maps per row, at most. */
export const MAPS_PER_ROW = 6;

/** One drawn map of a field with its contour lines, ready to paint. */
export interface ExportMap {
  readonly index: number;
  readonly label: string;
  readonly map: DrawnMap;
  readonly contours: readonly Float32Array[];
}

/** Every drawn map of a field, in map order, each with its lines: the handle's (`contoursOf`),
 *  set as the map's own, so `paintFieldMap` draws them for a map the worker did not trace. */
export function fieldMaps(field: ExportField): ExportMap[] {
  return field.field.drawnMaps().map(({ index, map, contours }) => ({
    index,
    label: field.built.model.maps.items[index]?.label ?? String(index),
    map: { ...map, contourLines: contours },
    contours,
  }));
}

/** Every drawn map of a field in rows of at most `MAPS_PER_ROW`, each with its label, then the
 *  legend's words and where the positions came from, for the picture to print. */
export async function mapParts(
  doc: Document,
  field: ExportField,
  width: number,

  { light: LIGHT, font: FONT }: Paint,
): Promise<{ readonly grid: Part; readonly legend: string; readonly placement: string } | null> {
  const maps = fieldMaps(field);
  if (maps.length === 0) return null;
  const view = await import("../render/sensor-field-view");
  const draw = view.fieldDrawInput(field.built);
  if (!draw) return null;
  const { model } = field.built;
  const perRow = Math.max(
    1,
    Math.min(MAPS_PER_ROW, Math.floor((width + MAP_GAP) / (MAP_PX + MAP_GAP))),
  );
  const cell = MAP_PX + MAP_LABEL + MAP_GAP;
  const scratch = doc.createElement("canvas");
  const colors = { foreground: LIGHT.head, background: LIGHT.background, contour: LIGHT.contour };
  const grid: Part = {
    height: Math.ceil(maps.length / perRow) * cell,
    paint(c) {
      maps.forEach((m, i) => {
        c.save();
        c.translate((i % perRow) * (MAP_PX + MAP_GAP), Math.floor(i / perRow) * cell);
        view.paintFieldMap(c, m.map, draw, model.limits, field.colorMap, colors, scratch, null);
        // paintFieldMap clears its square: the light ground goes back under it.
        c.globalCompositeOperation = "destination-over";
        c.fillStyle = LIGHT.background;
        c.fillRect(0, 0, MAP_PX, MAP_PX);
        c.globalCompositeOperation = "source-over";
        c.font = `12px ${FONT}`;
        c.fillStyle = LIGHT.foreground;
        c.textAlign = "center";
        c.textBaseline = "top";
        c.fillText(m.label, MAP_PX / 2, MAP_PX + 2);
        c.restore();
      });
    },
  };
  const [low, middle, high] = view.legendWords(model);
  const legend = `Colors from ${low}${middle ? ` through ${middle}` : ""} to ${high}, each map on its own range (${field.colorMap}).`;
  return { grid, legend, placement: view.placementStatement(model) };
}
