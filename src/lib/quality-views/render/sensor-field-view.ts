/**
 * `nemar.sensor-field` version 1 drawn on the page (neuroschema 0.6.0 `docs/views/sensor-field.md`,
 * What the renderer shows; website ADR 0035 decisions 1, 4 and 7): one scalp map per map of the
 * model, drawn in the worker (`worker-client.ts`), each with the head, a marker at every plotted
 * sensor and the contour lines.
 *
 * - **Readouts come from stored values.** A pointer or a key selects a plotted sensor and the
 *   readout prints that sensor's stored text in that map; a grid cell is never read out.
 * - **Where the positions came from** is stated beside the maps, from the model's placement.
 * - **A text row per map**: its label and either the range of its stored values (by their texts
 *   and the sensors that hold them) or the sentence for the word that took its place.
 * - Maps off screen are painted when they scroll into view, and their contour lines are traced
 *   then (`contoursOf`); the worker traces only the maps on screen. `drawnMaps()` hands an export
 *   (phase W8) every drawn map with its lines, traced the same way.
 */

import { type ColorMapName, lookupTable, paintGrid } from "../colormap";
import type { BuiltModel, Download, SensorFieldModel } from "../model";
import { numberText } from "../read";
import { type Element, h } from "../tree";
import type { DrawOutcome, DrawnMap, MapResult, SensorFieldClient } from "../worker-client";
import { contoursOf } from "../worker-client";
import { type ViewContext, dataTableToggle, figure, textTable } from "./figure";
import { mapFrame, markerPoints, toCanvas } from "./map-frame";
import { columnHeader } from "./table";
import { MAP_SENTENCES, UNUSED_POSITIONS_SENTENCES, sentence } from "./words";

/** A map's canvas, in CSS pixels. */
export const MAP_SIZE = 160;
/** Maps drawn first: those a page shows before it scrolls. */
export const MAPS_FIRST = 8;

type FieldBuilt = BuiltModel & { readonly model: SensorFieldModel };

/** What the worker is asked to draw: the drawn rows' places and, per drawable map, their values. */
export interface FieldDraw {
  /** The sensor rows drawn, in row order; the worker's row k is sensor row `rows[k]`. */
  readonly rows: readonly number[];
  readonly thetaDeg: Float64Array;
  readonly radius: Float64Array;
  /** The model's map index of each map sent. */
  readonly mapIndices: readonly number[];
  readonly maps: readonly Float64Array[];
}

/** The draw request for a built scalp map, or null when no map can be drawn (a placement word). */
export function fieldDrawInput(built: FieldBuilt): FieldDraw | null {
  const { model, layout } = built;
  if (!layout || model.placement.word !== null) return null;
  const rows = model.sensors.drawn.flatMap((drawn, k) => (drawn ? [k] : []));
  const mapIndices = model.maps.items.flatMap((item, m) => (item.word === null ? [m] : []));
  if (rows.length === 0 || mapIndices.length === 0) return null;
  return {
    rows,
    thetaDeg: Float64Array.from(rows, (k) => layout.thetaDeg[k]),
    radius: Float64Array.from(rows, (k) => layout.radius[k]),
    mapIndices,
    maps: mapIndices.map((m) => Float64Array.from(rows, (k) => model.maps.items[m].values[k])),
  };
}

const withUnit = (text: string, unit: string | null): string => (unit ? `${text} ${unit}` : text);

/** The readout for sensor row `row` of map `map`: the sensor's stored text, never a grid cell. */
export function sensorReadout(model: SensorFieldModel, map: number, row: number): string {
  const item = model.maps.items[map];
  return `${item.label}, ${model.sensors.labels[row]}: ${withUnit(item.text[row], model.unit)}`;
}

/** The readout for the `k`-th plotted marker of a drawn map: that sensor's stored text. */
export function markerReadout(
  model: SensorFieldModel,
  draw: FieldDraw,
  map: DrawnMap,
  mapIndex: number,
  k: number,
): string {
  return sensorReadout(model, mapIndex, draw.rows[map.geometry.plotted[k]]);
}

/** The plotted sensor (by its index among `markers`) nearest a canvas point, within `reach`. */
export function nearestMarker(
  markers: readonly (readonly [number, number])[],
  x: number,
  y: number,
  reach: number,
): number | null {
  let best: number | null = null;
  let distance = reach;
  markers.forEach(([mx, my], k) => {
    const d = Math.hypot(mx - x, my - y);
    if (d <= distance) {
      distance = d;
      best = k;
    }
  });
  return best;
}

/** The caption of a drawn map's note. */
export function noteCaption(note: string, valueRange: number, unit: string | null): string {
  if (note === "flat_field") return "all sensors have the same value";
  if (note === "near_flat") {
    return `all sensors are within ${withUnit(numberText(valueRange), unit)} of each other`;
  }
  return note;
}

/** A map's text row: its label and the range of its drawn sensors' stored values, by text. */
export function mapTextRow(model: SensorFieldModel, map: number): string {
  const item = model.maps.items[map];
  if (item.word !== null) return `${item.label}: not drawn. ${sentence(MAP_SENTENCES, item.word)}`;
  let low = -1;
  let high = -1;
  model.sensors.drawn.forEach((drawn, k) => {
    if (!drawn) return;
    if (low < 0 || item.values[k] < item.values[low]) low = k;
    if (high < 0 || item.values[k] > item.values[high]) high = k;
  });
  if (low < 0) return `${item.label}: no sensor is drawn.`;
  const at = (k: number) => `${withUnit(item.text[k], model.unit)} at ${model.sensors.labels[k]}`;
  return `${item.label}: from ${at(low)} to ${at(high)}.`;
}

/** Where the sensors' places came from (sensor-field.md, What the renderer shows). */
export function placementStatement(model: SensorFieldModel): string {
  const p = model.placement;
  if (p.source === "names") {
    const montage = p.montage ? ` on the ${p.montage} montage` : "";
    const unused = p.unused_positions
      ? ` ${sentence(UNUSED_POSITIONS_SENTENCES, p.unused_positions)}`
      : "";
    return `Template positions matched by sensor name${montage}.${unused}`;
  }
  if (p.position_source === "template") {
    return `Template positions${p.montage ? ` of the ${p.montage} montage` : ""}.`;
  }
  return "Measured positions: the dataset's own, which NEMAR does not verify.";
}

/** The color map a scalp map is painted with: diverging for `absmax`, sequential for `minmax`. */
export const fieldColorMap = (model: SensorFieldModel): ColorMapName =>
  model.limits === "absmax" ? "diverging" : "sequential";

/** The legend's words: no number, since the color axis comes from the interpolated grid. */
export function legendWords(model: SensorFieldModel): readonly [string, string, string] {
  const unit = model.unit ? ` (${model.unit})` : "";
  return model.limits === "absmax"
    ? [`negative${unit}`, "0", `positive${unit}`]
    : [`lower${unit}`, "", `higher${unit}`];
}

function mapLabel(model: SensorFieldModel, map: number): string {
  return `Scalp map ${mapTextRow(model, map)}`;
}

export function fieldTable(model: SensorFieldModel, caption: string): Element {
  const header = [
    model.sensors.dim ?? "sensor",
    ...model.maps.items.map((item) => columnHeader(item.label, model.unit)),
  ];
  const rows = model.sensors.labels.map((label, k) => [
    label,
    ...model.maps.items.map((item) => item.text[k]),
  ]);
  return textTable(caption, header, rows);
}

export function renderSensorField(
  model: SensorFieldModel,
  downloads: readonly Download[],
  ctx: ViewContext,
): Element {
  const [low, middle, high] = legendWords(model);
  const maps = model.maps.items.map((item, m) =>
    h(
      "li",
      { class: "qv-map", "data-map": m },
      item.word === null
        ? h("canvas", {
            class: "qv-map-canvas",
            width: MAP_SIZE,
            height: MAP_SIZE,
            role: "img",
            tabindex: 0,
            "aria-label": mapLabel(model, m),
            "aria-describedby": `${ctx.id}-readout`,
          })
        : h(
            "p",
            { class: "qv-map-word", "data-word": item.word },
            sentence(MAP_SENTENCES, item.word),
          ),
      h("p", { class: "qv-map-label" }, item.label),
    ),
  );
  const placement = model.placement;
  return figure({
    ctx,
    role: "group",
    drawing: h("ol", { class: "qv-maps" }, ...maps),
    label: `${ctx.caption} ${model.maps.items.length} scalp maps of ${model.sensors.labels.length} sensors.`,
    readout: true,
    notes: [
      h("p", { class: "qv-placement" }, placementStatement(model)),
      placement.word !== null
        ? h(
            "p",
            { class: "qv-note", "data-word": placement.word },
            sentence(MAP_SENTENCES, placement.word),
          )
        : null,
      h(
        "div",
        { class: "qv-legend", "data-limits": model.limits },
        h("span", { class: "qv-legend-low" }, low),
        h("span", { class: `qv-legend-bar qv-legend-${fieldColorMap(model)}` }),
        middle ? h("span", { class: "qv-legend-middle" }, middle) : null,
        h("span", { class: "qv-legend-high" }, high),
        h("button", { type: "button", class: "qv-turbo", "aria-pressed": "false" }, "Turbo colors"),
      ),
      h(
        "ul",
        { class: "qv-map-rows" },
        ...model.maps.items.map((_, m) => h("li", { "data-map": m }, mapTextRow(model, m))),
      ),
    ].filter((n): n is Element => n !== null),
    table: dataTableToggle(fieldTable(model, ctx.caption)),
    downloads,
    colorMaps: true,
  });
}

// ── On the page ─────────────────────────────────────────────────────────

export interface PaintColors {
  readonly foreground: string;
  readonly background: string;
  readonly contour: string;
}

/** Paint one drawn map: the grid inside the head on the model's color axis, the contour lines,
 *  the head, nose and ears, and a marker per plotted sensor; `selected` gets a ring. */
export function paintFieldMap(
  ctx: CanvasRenderingContext2D,
  map: DrawnMap,
  draw: FieldDraw,
  rule: "absmax" | "minmax",
  colorMap: ColorMapName,
  colors: PaintColors,
  scratch: HTMLCanvasElement,
  selected: number | null,
): void {
  const size = MAP_SIZE;
  ctx.clearRect(0, 0, size, size);
  const markers = markerPoints(map, draw.thetaDeg, draw.radius);
  const frame = mapFrame(map, markers, size);
  const { x, y, head } = map.geometry;
  const n = x.length;
  const dx = (x[n - 1] - x[0]) / (n - 1);
  const dy = (y[n - 1] - y[0]) / (n - 1);
  scratch.width = n;
  scratch.height = n;
  const sctx = scratch.getContext("2d");
  if (sctx) {
    const image = sctx.createImageData(n, n);
    image.data.set(paintGrid(map.grid, map.colorAxis[rule], lookupTable(colorMap), n));
    sctx.putImageData(image, 0, 0);
    const [left, top] = toCanvas(frame, x[n - 1] + dx / 2, y[0] - dy / 2);
    ctx.save();
    ctx.beginPath();
    ctx.arc(frame.cx, frame.cy, 0.5 * frame.scale, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(scratch, left, top, n * dy * frame.scale, n * dx * frame.scale);
    ctx.restore();
  }
  ctx.strokeStyle = colors.contour;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (const segments of contoursOf(map)) {
    for (let s = 0; s + 3 < segments.length; s += 4) {
      const [ax, ay] = toCanvas(frame, segments[s], segments[s + 1]);
      const [bx, by] = toCanvas(frame, segments[s + 2], segments[s + 3]);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
  }
  ctx.stroke();
  ctx.strokeStyle = colors.foreground;
  ctx.lineWidth = 1.2;
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
  ctx.fillStyle = colors.foreground;
  markers.forEach(([px, py], k) => {
    const [cx, cy] = toCanvas(frame, px, py);
    ctx.beginPath();
    ctx.arc(cx, cy, k === selected ? 3 : 1.4, 0, Math.PI * 2);
    ctx.fill();
  });
}

export interface SensorFieldHandle {
  /** Settles when every map is drawn, refused or the draw ends. */
  readonly ready: Promise<DrawOutcome | null>;
  /** The drawn maps with their contour lines (traced here when the worker did not): the hook a
   *  PNG or SVG export (phase W8) reads, never `contourLines` itself. */
  drawnMaps(): readonly { index: number; map: DrawnMap; contours: readonly Float32Array[] }[];
  /** Repaint with another color map (the turbo toggle). */
  setColorMap(name: ColorMapName): void;
  /** Stop drawing and leave the page as it is. */
  destroy(): void;
}

export interface MountOptions {
  readonly client: SensorFieldClient;
  /** The SHA-256 of the file the places came from: the worker caches geometry by it. */
  readonly layoutKey: string;
  readonly colors: PaintColors;
}

/** Draw the maps of a rendered scalp-map figure (`root` holds `renderSensorField`'s tree). */
export function mountSensorField(
  root: HTMLElement,
  built: FieldBuilt,
  options: MountOptions,
): SensorFieldHandle {
  const { model } = built;
  const doc = root.ownerDocument;
  const readout = root.querySelector<HTMLOutputElement>(".qv-readout");
  const draw = fieldDrawInput(built);
  const abort = new AbortController();
  const results = new Map<number, DrawnMap>();
  const painted = new Set<number>();
  const selected = new Map<number, number>();
  let colorMap = fieldColorMap(model);
  const scratch = doc.createElement("canvas");
  const canvasOf = (m: number) =>
    root.querySelector<HTMLCanvasElement>(`.qv-map[data-map="${m}"] canvas`);

  const paint = (m: number): void => {
    const map = results.get(m);
    const canvas = canvasOf(m);
    const ctx = canvas?.getContext("2d");
    if (!map || !ctx || !draw) return;
    paintFieldMap(
      ctx,
      map,
      draw,
      model.limits,
      colorMap,
      options.colors,
      scratch,
      selected.get(m) ?? null,
    );
    painted.add(m);
  };
  const visible = new Set<number>();
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const m = Number((entry.target.closest(".qv-map") as HTMLElement).dataset.map);
            if (entry.isIntersecting) {
              visible.add(m);
              if (!painted.has(m)) paint(m);
            } else visible.delete(m);
          }
        })
      : null;
  const shouldPaint = (m: number) => !observer || visible.has(m);

  const refuse = (m: number, word: string): void => {
    model.maps.items[m].word = word;
    const li = root.querySelector(`.qv-map[data-map="${m}"]`);
    const canvas = li?.querySelector("canvas");
    if (canvas) {
      const p = doc.createElement("p");
      p.className = "qv-map-word";
      p.dataset.word = word;
      p.textContent = sentence(MAP_SENTENCES, word);
      canvas.replaceWith(p);
    }
    const row = root.querySelector(`.qv-map-rows li[data-map="${m}"]`);
    if (row) row.textContent = mapTextRow(model, m);
  };

  const select = (m: number, k: number | null): void => {
    if (!draw || k === null) return;
    const map = results.get(m);
    if (!map) return;
    selected.set(m, k);
    if (readout) readout.textContent = markerReadout(model, draw, map, m, k);
    paint(m);
  };

  const onBatch = (maps: readonly MapResult[]): void => {
    for (const result of maps) {
      const m = draw!.mapIndices[result.index];
      if (result.kind === "refused") {
        refuse(m, result.word);
        continue;
      }
      results.set(m, result);
      model.maps.items[m].notes = [...result.notes];
      if (result.notes.length > 0) {
        const label = root.querySelector(`.qv-map[data-map="${m}"] .qv-map-label`);
        if (label) {
          label.textContent = `${model.maps.items[m].label} (${result.notes.map((note) => noteCaption(note, result.valueRange, model.unit)).join("; ")})`;
        }
      }
      if (shouldPaint(m)) paint(m);
    }
  };

  for (const canvas of root.querySelectorAll<HTMLCanvasElement>(".qv-map canvas")) {
    observer?.observe(canvas);
    const m = Number((canvas.closest(".qv-map") as HTMLElement).dataset.map);
    canvas.addEventListener("pointermove", (event) => {
      const map = results.get(m);
      if (!map || !draw) return;
      const box = canvas.getBoundingClientRect();
      const px = ((event.clientX - box.left) / box.width) * MAP_SIZE;
      const py = ((event.clientY - box.top) / box.height) * MAP_SIZE;
      const markers = markerPoints(map, draw.thetaDeg, draw.radius);
      const frame = mapFrame(map, markers, MAP_SIZE);
      const onCanvas = markers.map(([x, y]) => toCanvas(frame, x, y));
      select(m, nearestMarker(onCanvas, px, py, MAP_SIZE / 8));
    });
    canvas.addEventListener("keydown", (event) => {
      const map = results.get(m);
      if (!map) return;
      const count = map.geometry.plotted.length;
      const at = selected.get(m);
      const step =
        event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (step === 0) return;
      event.preventDefault();
      select(m, at === undefined ? 0 : (at + step + count) % count);
    });
  }
  root.querySelector(".qv-turbo")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const on = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(on));
    handle.setColorMap(on ? "turbo" : fieldColorMap(model));
  });

  const ready: Promise<DrawOutcome | null> = draw
    ? options.client
        .draw(
          {
            layoutKey: options.layoutKey,
            thetaDeg: draw.thetaDeg,
            radius: draw.radius,
            maps: draw.maps,
          },
          {
            first: Array.from({ length: Math.min(MAPS_FIRST, draw.maps.length) }, (_, i) => i),
            onBatch,
            signal: abort.signal,
          },
        )
        .then((outcome) => {
          if (outcome.kind === "unavailable") {
            console.warn("[quality-views] scalp maps:", outcome.reason);
            for (const m of draw.mapIndices) if (!results.has(m)) refuse(m, "worker");
          }
          return outcome;
        })
    : Promise.resolve(null);

  const handle: SensorFieldHandle = {
    ready,
    drawnMaps: () =>
      [...results.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, map]) => ({ index, map, contours: contoursOf(map) })),
    setColorMap(name) {
      colorMap = name;
      for (const m of painted) paint(m);
    },
    destroy() {
      abort.abort();
      observer?.disconnect();
    },
  };
  return handle;
}
