/**
 * The signal viewer's live scalp map on NEMAR's one scalp-map algorithm (website ADR 0035 decision
 * 5; nemar-cli ADR 0137 decision 3 and its amendment of 2026-11-24; website#588 phase W3).
 *
 * Where the sensors go is decided once per recording, here, with no frame ever assumed:
 *
 * 1. A recording whose electrodes file gives positions has them laid out by
 *    `nemar.sensor-layout.v1`. Positions in an intracranial frame (`Pixels`, `ACPC`, `ScanRAS`)
 *    draw no scalp map at all (`frame_not_scalp`); an electrodes file naming none of the
 *    recording's channels draws none (`positions_unmatched`, the viewer's word); and positions
 *    none of whose rows is typed EEG draw none (`no_eeg_sensors`). The store's `OTHER` (a channels
 *    file type of `n/a`) is untyped, so such rows are not EEG: the strict rule of ADR 0137's
 *    amendment, which the viewer keeps until neuroschema 0.6.1 rules on untyped rows.
 * 2. When the layout refuses them (`frame_unknown`, `positions_flat`, `positions_partial`), the
 *    drawn rows (the positioned rows typed EEG) are placed by name instead, and the reason the
 *    positions were not used is kept (`unused_positions`) and shown. Positioned rows of other
 *    types, and rows naming no channel, are neither placed nor in the way.
 * 3. A recording with no positions is placed by name with `nemar.sensor-labels.v1`
 *    (`quality-views/sensor-labels.ts`): template positions from the one montage the names
 *    identify, centered on that montage's own center from its file, or no map with the
 *    algorithm's refusal (`too_few_channels`, `share_too_low`, `cap_model_unknown`, ...), whose
 *    sentence is `sensor-labels-copy.ts`'s. Scalp channels all typed and none EEG are
 *    `no_eeg_sensors`. The store carries no `CapManufacturersModelName` or `EEGReference`, so an
 *    EGI net is refused (`cap_model_unknown`) and no reference channel is reported. The montages
 *    names reach load only when a recording is placed by name; one that cannot be loaded leaves
 *    the map undrawn with its reason (`montage_unavailable`, the viewer's word).
 *
 * The map itself is `nemar.sensor-field.v1`, drawn in the quality views' worker
 * (`worker-client.ts`) and painted here with the sequential color map on the `minmax` color axis.
 * Every refusal, whether of the placement or of the map (`too_few_sensors`, `head_outside_grid`,
 * `interpolation_failed`), or a worker that cannot draw, leaves the map undrawn with a sentence;
 * nothing is guessed and nothing throws past this module.
 */

import { SEQUENTIAL_STOPS, lookupTable, paintGrid } from "../quality-views/colormap";
import type { Montage } from "../quality-views/montages";
import { mapFrame, markerPoints, toCanvas } from "../quality-views/render/map-frame";
import {
  type LabelsReason,
  MIN_CHANNELS,
  countCandidates,
  inferPositions,
  loadNameMontages,
} from "../quality-views/sensor-labels";
import {
  LABELS_SENTENCES,
  MONTAGE_UNAVAILABLE_SENTENCE,
  asClause,
} from "../quality-views/sensor-labels-copy";
import { type SensorLayoutWord, sensorLayout } from "../quality-views/sensor-layout";
import { isFiducial, typeClass } from "../quality-views/sensor-names";
import type { DrawOutcome, DrawnMap } from "../quality-views/worker-client";

/** Coordinate systems of intracranial recordings: no scalp map is drawn from them, by place or by
 *  name (the amendment's `frame_not_scalp`). */
export const INTRACRANIAL_FRAMES: ReadonlySet<string> = new Set(["Pixels", "ACPC", "ScanRAS"]);

/** The store's word for a channel whose type it was not given (`parseChannels`): untyped here. */
export const STORE_UNTYPED = "OTHER";

/**
 * Why the sensors were not placed. `frame_unknown`, `positions_flat`, `positions_partial`,
 * `frame_not_scalp` and `no_eeg_sensors` are the amendment's words, and every refusal of
 * `nemar.sensor-labels.v1` is one too (`LabelsReason`); the other two are the viewer's own:
 * `positions_unmatched`, an electrodes file none of whose rows names a channel of the recording,
 * and `montage_unavailable`, a montage that cannot be loaded. No specification word says either.
 */
export type PlacementWord =
  | SensorLayoutWord
  | "frame_not_scalp"
  | "no_eeg_sensors"
  | "positions_unmatched"
  | LabelsReason
  | "montage_unavailable";

/** Why a placed map was not drawn: the sensor-field words, or a worker that could not draw. */
export type MapWord = "too_few_sensors" | "head_outside_grid" | "interpolation_failed" | "worker";

/** The sentence a reader sees in place of the map, one per word. */
export const SCALP_MAP_SENTENCES: Readonly<Record<PlacementWord | MapWord, string>> = {
  frame_not_scalp:
    "No scalp map: this recording's electrode positions are in an intracranial coordinate system.",
  no_eeg_sensors: "No scalp map: none of this recording's channels is typed EEG.",
  positions_unmatched: "No scalp map: the electrodes file names none of this recording's channels.",
  frame_unknown:
    "No scalp map: the electrode positions name a coordinate system whose orientation is not known.",
  positions_flat:
    "No scalp map: the electrode positions are too flat, or too few, to locate the head's center.",
  positions_partial:
    "No scalp map: the electrode positions cover too little of the head to locate its center.",
  montage_unavailable: `No scalp map: ${asClause(MONTAGE_UNAVAILABLE_SENTENCE)}`,
  too_few_sensors: "No scalp map: a map needs at least 8 placed channels with a value.",
  head_outside_grid: "No scalp map: the placed channels leave no part of the head to draw.",
  interpolation_failed: "No scalp map: the interpolation did not give a finite map.",
  worker: "No scalp map: the map could not be drawn on this page.",
  ...(Object.fromEntries(
    Object.entries(LABELS_SENTENCES).map(([word, text]) => [
      word,
      `No scalp map: ${asClause(text)}`,
    ]),
  ) as Record<LabelsReason, string>),
};

/**
 * `no_eeg_sensors` on the positions path when some channel of the recording is typed EEG, but none
 * the electrodes file positions: the general sentence would be false there.
 */
export const NO_EEG_POSITIONED_SENTENCE =
  "No scalp map: none of the channels the electrodes file positions is typed EEG.";

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
  /** The sidecar's `CapManufacturersModelName` and `EEGReference`, which `nemar.sensor-labels.v1`
   *  reads; the recording store carries neither today (nemarOrg/nemar-cli#2407), so the viewer
   *  leaves them out and an EGI net placed by name is `cap_model_unknown`. */
  readonly capModel?: string | null;
  readonly reference?: string | null;
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
      /** The sentence in place of the map, when it is not the word's own (`placementSentence`). */
      readonly sentence?: string;
      readonly unusedPositions: SensorLayoutWord | null;
    };

/** A channel's type for the layout: null (untyped) for the store's word for none. */
const sensorType = (channelType: string | undefined): string | null =>
  channelType === undefined || channelType === STORE_UNTYPED ? null : channelType;

/** Where step 1 sends the placement on: names, with the labels to place (all scalp channels,
 *  or, after a refused projection, the positioned rows typed EEG) and why positions were not used. */
export interface ToNames {
  readonly kind: "names";
  readonly unusedPositions: SensorLayoutWord | null;
  /** The labels to place by name; null for every candidate channel of the recording. */
  readonly labels: readonly string[] | null;
}

/**
 * Step 1: the recording's own positions, or the word they were refused with.
 *
 * The drawn rows are the positioned rows typed EEG (neuroschema's `drawn_rows` for measured
 * positions; never a fiducial). When the projection refuses them, every drawn row is EEG by
 * definition, so the channels are placed by name, from the drawn rows' labels only: a positioned
 * EOG, ECG or MISC row, and a row that names no channel (GND, REF), neither blocks the fallback
 * nor is placed.
 */
export function placeByPositions(input: ScalpInput): Placement | ToNames {
  const labels = Object.keys(input.positions);
  if (labels.length === 0) return { kind: "names", unusedPositions: null, labels: null };
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
  if (!labels.some((label) => typeOf.has(label))) {
    return {
      kind: "refused",
      word: "positions_unmatched",
      detail: `${labels.length} positioned row(s), none named as a channel`,
      unusedPositions: null,
    };
  }
  const sensorTypes = labels.map((label) => sensorType(typeOf.get(label)));
  const drawn = labels.filter(
    (label, row) => !isFiducial(label) && typeClass(sensorTypes[row]) === "eeg",
  );
  if (drawn.length === 0) {
    return {
      kind: "refused",
      word: "no_eeg_sensors",
      detail: "no positioned row is typed EEG",
      ...(input.channels.some((c) => typeClass(sensorType(c.channelType)) === "eeg")
        ? { sentence: NO_EEG_POSITIONED_SENTENCE }
        : {}),
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
  return { kind: "names", unusedPositions: result.word, labels: drawn };
}

/**
 * Step 3: template positions by name (`nemar.sensor-labels.v1`), centered on the montage's own
 * center. `load` fetches a montage (`loadMontage` on a page); the fourteen montages names reach are
 * loaded here, so a recording placed by its own positions never fetches one. `only` is step 1's
 * drawn rows after a refused projection (each typed EEG); otherwise every scalp channel is given,
 * with its type, and the algorithm leaves out what is not EEG.
 */
export async function placeByNames(
  input: ScalpInput,
  unusedPositions: SensorLayoutWord | null,
  load: (name: string) => Promise<Montage>,
  only: readonly string[] | null = null,
): Promise<Placement> {
  const typeOf = new Map(input.channels.map((c) => [c.label, sensorType(c.channelType)]));
  const labels = only ? [...only] : input.channels.map((c) => c.label);
  const kinds = input.channels.map((c) => typeClass(sensorType(c.channelType)));
  if (only === null && kinds.length > 0 && kinds.every((kind) => kind === "other")) {
    return {
      kind: "refused",
      word: "no_eeg_sensors",
      detail: "every scalp channel is typed, and none EEG",
      unusedPositions,
    };
  }
  const given = labels.map((label) => [label, typeOf.get(label) ?? null] as const);
  // Too few candidates is refused before any montage is fetched (countCandidates needs none).
  if (countCandidates(given) < MIN_CHANNELS) {
    return {
      kind: "refused",
      word: "too_few_channels",
      detail: `${countCandidates(given)} candidate channel(s), fewer than ${MIN_CHANNELS}`,
      unusedPositions,
    };
  }
  let montages: Montage[];
  try {
    montages = await loadNameMontages(load);
  } catch (error) {
    return {
      kind: "refused",
      word: "montage_unavailable",
      detail: error instanceof Error ? error.message : String(error),
      unusedPositions,
    };
  }
  const inference = inferPositions(given, montages, {
    capModel: input.capModel ?? null,
    reference: input.reference ?? null,
  });
  if (inference.outcome === "refused") {
    return {
      kind: "refused",
      word: inference.reason!,
      detail: `${inference.matched} of ${inference.candidates} candidate channel(s) matched one montage${
        inference.contenders.length > 0 ? ` (${inference.contenders.join(", ")})` : ""
      }`,
      unusedPositions,
    };
  }
  const name = inference.montage!;
  const montage = montages.find((m) => m.name === name)!;
  const placed = inference.channels.filter((c) => c.position !== null);
  const result = sensorLayout(
    {
      x: placed.map((c) => c.position![0]),
      y: placed.map((c) => c.position![1]),
      z: placed.map((c) => c.position![2]),
    },
    "n/a",
    { montage: name, names: placed.map((c) => c.name), montageCenter: () => montage.center },
  );
  if (result.kind === "refused") {
    return { kind: "refused", word: result.word, detail: result.detail, unusedPositions };
  }
  return {
    kind: "placed",
    source: "names",
    montage: name,
    labels: placed.map((c) => c.name),
    thetaDeg: result.layout.thetaDeg,
    radius: result.layout.radius,
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
    return await placeByNames(input, first.unusedPositions, load, first.labels);
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

/** Where a viewer's sensors go, decided as late as it can be (`scalpPlacer`). */
export interface ScalpPlacer {
  /** The placement once known; null while placement by name waits for `show` or is running. */
  readonly placement: Placement | null;
  /** The map is shown: start the placement by name, once, if one is waiting. */
  show(): void;
}

/**
 * The viewer's placement, in two steps. Step 1 (the recording's own positions, or the word they
 * are refused with) needs no montage and runs at once, so the map's toggle can say where the
 * positions come from, or why there is no map, before it is opened. Placement by name loads the
 * fourteen montages names reach, so it waits until the map is first shown (`show`). `onPlaced` is
 * called once with the placement: at once for step 1, after `show` for names. Never rejects.
 */
export function scalpPlacer(
  input: ScalpInput,
  load: (name: string) => Promise<Montage>,
  onPlaced: (placement: Placement) => void,
): ScalpPlacer {
  let placement: Placement | null = null;
  let waiting: ToNames | null = null;
  const failed = (error: unknown): Placement => {
    // A bug here must not end the viewer: the map is left undrawn and says it could not be drawn.
    console.error("[eeg-viewer] scalp placement failed:", error);
    return {
      kind: "refused",
      word: "worker",
      detail: error instanceof Error ? error.message : String(error),
      unusedPositions: null,
    };
  };
  const settle = (placed: Placement): void => {
    placement = placed;
    onPlaced(placed);
  };
  let first: Placement | ToNames;
  try {
    first = placeByPositions(input);
  } catch (error) {
    first = failed(error);
  }
  if (first.kind === "names") waiting = first;
  else settle(first);
  return {
    get placement() {
      return placement;
    },
    show() {
      if (waiting === null) return;
      const names = waiting;
      waiting = null;
      void placeByNames(input, names.unusedPositions, load, names.labels)
        .catch(failed)
        .then(settle);
    },
  };
}

/** The sentence in place of a refused placement's map. */
export function placementSentence(placement: Placement & { kind: "refused" }): string {
  return placement.sentence ?? refusalSentence(placement.word);
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
    return { kind: "undrawn", sentence: placementSentence(placement) };
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

// The frame helpers are the quality views' own (render/map-frame.ts), shared with their maps.
export { type MapFrame, mapFrame, markerPoints, toCanvas } from "../quality-views/render/map-frame";

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
