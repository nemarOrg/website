/**
 * The signal viewer's live scalp map on NEMAR's one scalp-map algorithm (website ADR 0035 decision
 * 5; nemar-cli ADR 0137 decision 3 and its amendment of 2026-11-24; website#588 phase W3).
 *
 * Where the sensors go is decided once per recording, here, with no frame ever assumed:
 *
 * 1. A recording whose electrodes file gives positions has them laid out by
 *    `nemar.sensor-layout.v1`. Positions in an intracranial frame (`Pixels`, `ACPC`, `ScanRAS`)
 *    draw no scalp map at all (`frame_not_scalp`), and positions none of whose rows is typed EEG
 *    draw none (`no_eeg_sensors`).
 * 2. When the layout refuses them (`frame_unknown`, `positions_flat`, `positions_partial`), the
 *    channels are placed by name instead, but only when every row of the positions is typed EEG,
 *    and the reason the positions were not used is kept (`unused_positions`) and shown.
 * 3. A recording with no positions is placed by name (`name-placement.ts`, until W2b's
 *    `nemar.sensor-labels.v1`): template positions from one of neuroschema's montages, centered on
 *    that montage's own center from its file. A montage that cannot be loaded leaves the map
 *    undrawn with its reason (`montage_unavailable`, which is also how a `MontageCenterUnavailable`
 *    from the layout ends).
 *
 * The map itself is `nemar.sensor-field.v1`, drawn in the quality views' worker
 * (`worker-client.ts`) and painted here with the sequential color map on the `minmax` color axis.
 * Every refusal, whether of the placement or of the map (`too_few_sensors`, `head_outside_grid`,
 * `interpolation_failed`), or a worker that cannot draw, leaves the map undrawn with a sentence;
 * nothing is guessed and nothing throws past this module.
 */

import { SEQUENTIAL_STOPS, lookupTable, paintGrid } from "../quality-views/colormap";
import { type Montage, centersOf } from "../quality-views/montages";
import {
  MontageCenterUnavailable,
  type SensorLayoutWord,
  sensorLayout,
} from "../quality-views/sensor-layout";
import { clean, excludedByName, isFiducial, typeClass } from "../quality-views/sensor-names";
import type { DrawOutcome, DrawnMap } from "../quality-views/worker-client";
import { MIN_MATCHED, candidateMontages, matchLabels } from "./name-placement";

/** Coordinate systems of intracranial recordings: no scalp map is drawn from them, by place or by
 *  name (the amendment's `frame_not_scalp`). */
export const INTRACRANIAL_FRAMES: ReadonlySet<string> = new Set(["Pixels", "ACPC", "ScanRAS"]);

/** The store's word for a channel whose type it was not given (`parseChannels`): untyped here. */
export const STORE_UNTYPED = "OTHER";

/** Why the sensors were not placed. The first five are the specification's words; the others the
 *  viewer's own. */
export type PlacementWord =
  | SensorLayoutWord
  | "frame_not_scalp"
  | "no_eeg_sensors"
  | "labels_unrecognized"
  | "montage_unavailable";

/** Why a placed map was not drawn: the sensor-field words, or a worker that could not draw. */
export type MapWord = "too_few_sensors" | "head_outside_grid" | "interpolation_failed" | "worker";

/** The sentence a reader sees in place of the map, one per word. */
export const SCALP_MAP_SENTENCES: Readonly<Record<PlacementWord | MapWord, string>> = {
  frame_not_scalp:
    "No scalp map: this recording's electrode positions are in an intracranial coordinate system.",
  no_eeg_sensors: "No scalp map: none of this recording's positioned channels is typed EEG.",
  frame_unknown:
    "No scalp map: the electrode positions name a coordinate system whose orientation is not known.",
  positions_flat:
    "No scalp map: the electrode positions are too flat, or too few, to locate the head's center.",
  positions_partial:
    "No scalp map: the electrode positions cover too little of the head to locate its center.",
  labels_unrecognized: "No scalp map: no channel name matches a standard montage.",
  montage_unavailable: "No scalp map: the standard montage could not be loaded.",
  too_few_sensors: "No scalp map: a map needs at least 8 placed channels with a value.",
  head_outside_grid: "No scalp map: the placed channels leave no part of the head to draw.",
  interpolation_failed: "No scalp map: the interpolation did not give a finite map.",
  worker: "No scalp map: the map could not be drawn on this page.",
};

/** Why a recording's own positions were not used, when its channels were placed by name. */
export const UNUSED_POSITIONS_SENTENCES: Readonly<Record<SensorLayoutWord, string>> = {
  frame_unknown: "its electrode positions name a coordinate system of unknown orientation",
  positions_flat: "its electrode positions are too flat to locate the head's center",
  positions_partial: "its electrode positions cover too little of the head",
};

/** What the placement reads of a recording: its positions, their frame, and its scalp channels. */
export interface ScalpInput {
  /** Positions by label, in the electrodes file's order; empty when it gives none. */
  readonly positions: Readonly<Record<string, readonly [number, number, number]>>;
  readonly coordinateSystem: string;
  /** The channels of the recording's scalp groups, in order, with their BIDS type. */
  readonly channels: readonly { readonly label: string; readonly channelType: string }[];
}

export type Placement =
  | {
      readonly kind: "placed";
      /** `positions` (the recording's own) or `names` (template positions by name). */
      readonly source: "positions" | "names";
      /** For `names`, the montage the template positions come from. */
      readonly montage: string | null;
      /** One per row: the channel label whose value goes there. */
      readonly labels: readonly string[];
      /** One per row, NaN for a row with no layout (`nemar.sensor-layout.v1`). */
      readonly thetaDeg: Float64Array;
      readonly radius: Float64Array;
      /** Why the recording's own positions were not used, when names replaced them. */
      readonly unusedPositions: SensorLayoutWord | null;
    }
  | {
      readonly kind: "refused";
      /** A placement word, or `worker` when placing failed in a way no word names. */
      readonly word: PlacementWord | "worker";
      readonly detail: string;
      readonly unusedPositions: SensorLayoutWord | null;
    };

/** A channel's type for the layout: null (untyped) for the store's word for none. */
const sensorType = (channelType: string | undefined): string | null =>
  channelType === undefined || channelType === STORE_UNTYPED ? null : channelType;

/** Step 1: the recording's own positions, or the word they were refused with. */
export function placeByPositions(
  input: ScalpInput,
): Placement | { readonly kind: "names"; readonly unusedPositions: SensorLayoutWord | null } {
  const labels = Object.keys(input.positions);
  if (labels.length === 0) return { kind: "names", unusedPositions: null };
  const frame = input.coordinateSystem;
  if (INTRACRANIAL_FRAMES.has(frame)) {
    return {
      kind: "refused",
      word: "frame_not_scalp",
      detail: `the positions are in ${JSON.stringify(frame)}`,
      unusedPositions: null,
    };
  }
  const typeOf = new Map(input.channels.map((c) => [c.label, c.channelType]));
  const sensorTypes = labels.map((label) => sensorType(typeOf.get(label)));
  const rows = labels.flatMap((label, row) => (isFiducial(label) ? [] : [row]));
  if (!rows.some((row) => typeClass(sensorTypes[row]) === "eeg")) {
    return {
      kind: "refused",
      word: "no_eeg_sensors",
      detail: "no positioned row is typed EEG",
      unusedPositions: null,
    };
  }
  const result = sensorLayout(
    {
      x: labels.map((l) => input.positions[l][0]),
      y: labels.map((l) => input.positions[l][1]),
      z: labels.map((l) => input.positions[l][2]),
    },
    frame,
    { names: labels, sensorTypes },
  );
  if (result.kind === "layout") {
    return {
      kind: "placed",
      source: "positions",
      montage: null,
      labels,
      thetaDeg: result.layout.thetaDeg,
      radius: result.layout.radius,
      unusedPositions: null,
    };
  }
  if (rows.every((row) => typeClass(sensorTypes[row]) === "eeg")) {
    return { kind: "names", unusedPositions: result.word };
  }
  return { kind: "refused", word: result.word, detail: result.detail, unusedPositions: null };
}

/** The channels placement by name considers: typed EEG, or untyped and not named as another
 *  signal; never a fiducial. */
export function nameCandidates(channels: ScalpInput["channels"]): string[] {
  return channels
    .filter((c) => {
      const kind = typeClass(sensorType(c.channelType));
      if (kind === "other") return false;
      if (kind === "untyped" && excludedByName(clean(c.label))) return false;
      return !isFiducial(c.label);
    })
    .map((c) => c.label);
}

/**
 * Step 3: template positions by name, centered on the montage's own center. `load` fetches a
 * montage (`loadMontage` on a page).
 */
export async function placeByNames(
  input: ScalpInput,
  unusedPositions: SensorLayoutWord | null,
  load: (name: string) => Promise<Montage>,
): Promise<Placement> {
  const labels = nameCandidates(input.channels);
  for (const name of candidateMontages(labels)) {
    let montage: Montage;
    try {
      montage = await load(name);
    } catch (error) {
      return {
        kind: "refused",
        word: "montage_unavailable",
        detail: `${name}: ${error instanceof Error ? error.message : String(error)}`,
        unusedPositions,
      };
    }
    const matched = matchLabels(labels, montage);
    if (matched.length < MIN_MATCHED && name !== "standard_1005") continue;
    if (matched.length === 0) break;
    try {
      const result = sensorLayout(
        {
          x: matched.map((m) => m.position[0]),
          y: matched.map((m) => m.position[1]),
          z: matched.map((m) => m.position[2]),
        },
        "n/a",
        {
          montage: name,
          names: matched.map((m) => m.label),
          montageCenter: centersOf([montage]),
        },
      );
      if (result.kind === "refused") {
        return { kind: "refused", word: result.word, detail: result.detail, unusedPositions };
      }
      return {
        kind: "placed",
        source: "names",
        montage: name,
        labels: matched.map((m) => m.label),
        thetaDeg: result.layout.thetaDeg,
        radius: result.layout.radius,
        unusedPositions,
      };
    } catch (error) {
      if (!(error instanceof MontageCenterUnavailable)) throw error;
      return {
        kind: "refused",
        word: "montage_unavailable",
        detail: error.message,
        unusedPositions,
      };
    }
  }
  return {
    kind: "refused",
    word: "labels_unrecognized",
    detail: `${labels.length} candidate channel(s), none named in a standard montage`,
    unusedPositions,
  };
}

/** Where a recording's sensors go: steps 1 to 3. Never rejects: every failure is a refusal. */
export async function placeScalpSensors(
  input: ScalpInput,
  load: (name: string) => Promise<Montage>,
): Promise<Placement> {
  try {
    const first = placeByPositions(input);
    if (first.kind !== "names") return first;
    return await placeByNames(input, first.unusedPositions, load);
  } catch (error) {
    // A bug here must not end the viewer: the map is left undrawn and says it could not be drawn.
    console.error("[eeg-viewer] scalp placement failed:", error);
    return {
      kind: "refused",
      word: "worker",
      detail: error instanceof Error ? error.message : String(error),
      unusedPositions: null,
    };
  }
}

/** The sentence shown in place of a map refused with `word`. */
export function refusalSentence(word: PlacementWord | MapWord): string {
  return SCALP_MAP_SENTENCES[word];
}

/** What the panel shows: a map to paint, a sentence in its place, or nothing new. */
export type TopoView =
  | { readonly kind: "map"; readonly map: DrawnMap }
  | { readonly kind: "undrawn"; readonly sentence: string }
  | { readonly kind: "unchanged" };

/** The panel before any draw: undrawn while placing or refused, or null when a map can be asked for. */
export function viewOfPlacement(placement: Placement | null): TopoView | null {
  if (placement === null) {
    return { kind: "undrawn", sentence: "Placing the channels on the scalp map..." };
  }
  if (placement.kind === "refused") {
    return { kind: "undrawn", sentence: refusalSentence(placement.word) };
  }
  return null;
}

/** The panel after a draw of one map: the map, its refusal's sentence, or (cancelled) unchanged. */
export function viewOfDraw(outcome: DrawOutcome): TopoView {
  if (outcome.kind === "cancelled") return { kind: "unchanged" };
  if (outcome.kind === "unavailable")
    return { kind: "undrawn", sentence: refusalSentence("worker") };
  const map = outcome.maps[0];
  if (!map) return { kind: "undrawn", sentence: refusalSentence("worker") };
  if (map.kind === "refused") return { kind: "undrawn", sentence: refusalSentence(map.word) };
  return { kind: "map", map };
}

/** The note under a map whose channels were placed by name. */
export function templateNote(placement: Placement & { kind: "placed" }): string | null {
  if (placement.source !== "names") return null;
  const base = `Template positions from the ${placement.montage} montage, matched by channel name`;
  return placement.unusedPositions === null
    ? `${base}.`
    : `${base}; this recording's own positions were not used: ${UNUSED_POSITIONS_SENTENCES[placement.unusedPositions]}.`;
}

/**
 * One value per placed row from the channels on screen: a dimmed (rejected) channel, a channel not
 * on screen and a value that is not finite are NaN, so the map leaves them out.
 */
export function rowValues(
  labels: readonly string[],
  channels: readonly { readonly label: string; readonly dim?: boolean; readonly value: number }[],
): Float64Array {
  const byLabel = new Map<string, number>();
  for (const c of channels) if (!c.dim) byLabel.set(c.label, c.value);
  return Float64Array.from(labels, (label) => {
    const value = byLabel.get(label);
    return value !== undefined && Number.isFinite(value) ? value : Number.NaN;
  });
}

// --- painting --------------------------------------------------------------

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

/** The axis a viewer map is colored on: `minmax`, with the sequential map. */
export const VIEWER_LIMITS = "minmax";
export const VIEWER_COLOR_MAP = "sequential";

/**
 * Paint a drawn map: the grid in the sequential colors on its `minmax` color axis (masked cells
 * stay clear), the head, nose and ears, and a marker per plotted row. `scratch` is this viewer's own
 * offscreen canvas for the grid (never shared between viewers). Returns the color axis, for the
 * legend.
 */
export function paintScalpMap(
  ctx: CanvasRenderingContext2D,
  sizePx: number,
  map: DrawnMap,
  thetaDeg: ArrayLike<number>,
  radius: ArrayLike<number>,
  colors: { readonly foreground: string; readonly background: string },
  scratch: HTMLCanvasElement,
): readonly [number, number] {
  ctx.clearRect(0, 0, sizePx, sizePx);
  const markers = markerPoints(map, thetaDeg, radius);
  const frame = mapFrame(map, markers, sizePx);
  const axis = map.colorAxis[VIEWER_LIMITS];
  const size = map.geometry.x.length;

  // The grid: cell (i, j) sits at (x[i], y[j]); each pixel of the scratch image is one cell, so the
  // image spans half a cell past the first and last points on each axis.
  const { x, y } = map.geometry;
  const dx = (x[size - 1] - x[0]) / (size - 1);
  const dy = (y[size - 1] - y[0]) / (size - 1);
  if (scratch.width !== size || scratch.height !== size) {
    scratch.width = size;
    scratch.height = size;
  }
  const sctx = scratch.getContext("2d");
  if (sctx) {
    const image = sctx.createImageData(size, size);
    image.data.set(paintGrid(map.grid, axis, lookupTable(VIEWER_COLOR_MAP), size));
    sctx.putImageData(image, 0, 0);
    const [left, top] = toCanvas(frame, x[size - 1] + dx / 2, y[0] - dy / 2);
    ctx.save();
    ctx.beginPath();
    ctx.arc(frame.cx, frame.cy, 0.5 * frame.scale, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(scratch, left, top, size * dy * frame.scale, size * dx * frame.scale);
    ctx.restore();
  } else {
    console.warn("[eeg-viewer] scalp map: no 2D context for the grid; field omitted");
  }

  // Head, nose and ears.
  const { head } = map.geometry;
  ctx.strokeStyle = colors.foreground;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(frame.cx, frame.cy, head.radius * frame.scale, 0, Math.PI * 2);
  ctx.stroke();
  for (const line of [head.nose, head.rightEar, head.leftEar]) {
    ctx.beginPath();
    line.forEach(([px, py], i) => {
      const [cx, cy] = toCanvas(frame, px, py);
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.stroke();
  }

  // Markers, with a thin background-colored ring so they read against any color.
  const dotR = Math.max(1.4, 0.5 * frame.scale * 0.016);
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.background;
  ctx.fillStyle = colors.foreground;
  for (const [px, py] of markers) {
    const [cx, cy] = toCanvas(frame, px, py);
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  return axis;
}

/** The legend's CSS gradient: the sequential stops, evenly, low on the left. */
export const SEQUENTIAL_GRADIENT = `linear-gradient(to right, ${SEQUENTIAL_STOPS.map(([, color]) => color).join(", ")})`;
