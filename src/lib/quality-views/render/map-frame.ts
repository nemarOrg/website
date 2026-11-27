/**
 * Where a drawn scalp map sits on a canvas (website ADR 0035 decision 1): the markers at each
 * plotted sensor's squeezed place, a frame that fits the head, nose, ears and markers, nose up, and
 * the conversion from grid units (x to the nose, y to the right ear) to canvas pixels. Shared by the
 * quality views' maps and the signal viewer's live map (`eeg-viewer/scalp-map.ts`).
 */

import type { DrawnMap } from "../worker-client";

/** A point of a map in grid units (x to the nose, y to the right ear) on the canvas: nose up. */
export interface MapFrame {
  readonly cx: number;
  readonly cy: number;
  /** CSS pixels per grid unit. */
  readonly scale: number;
}

/** Grid positions of the rows that get a marker: theta and radius times `squeezefac`. */
export function markerPoints(
  map: DrawnMap,
  thetaDeg: ArrayLike<number>,
  radius: ArrayLike<number>,
): [number, number][] {
  const s = map.geometry.squeezefac;
  return map.geometry.plotted.map((row) => {
    const t = (thetaDeg[row] * Math.PI) / 180;
    return [Math.cos(t) * radius[row] * s, Math.sin(t) * radius[row] * s];
  });
}

/** The canvas frame that fits the head, its nose and ears, and every marker, in `sizePx`. */
export function mapFrame(
  map: DrawnMap,
  markers: readonly (readonly [number, number])[],
  sizePx: number,
): MapFrame {
  let reach = 0.5;
  const { head } = map.geometry;
  for (const [x, y] of [...head.nose, ...head.rightEar, ...head.leftEar, ...markers]) {
    reach = Math.max(reach, Math.hypot(x, y));
  }
  return { cx: sizePx / 2, cy: sizePx / 2, scale: sizePx / 2 / (reach * 1.06) };
}

/** Canvas coordinates of a grid point. */
export function toCanvas(frame: MapFrame, x: number, y: number): [number, number] {
  return [frame.cx + y * frame.scale, frame.cy - x * frame.scale];
}
