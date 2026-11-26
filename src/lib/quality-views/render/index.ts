/**
 * Which renderer draws a built view (the live-views plan's C2 on the page; website ADR 0035
 * decision 3), and the page's side of each: the pointer and the keyboard read stored rows into the
 * readout, the heatmap's cells are painted, and the scalp maps are drawn in the worker.
 *
 * `renderView` never throws: a model it has no renderer for, or a renderer that fails, shows the
 * view's tables with their downloads, as the fallback does. `renderRefusal` words a view that is
 * not drawn at all (an invalid declaration, or a file not the one recorded).
 */

import type {
  BuiltModel,
  Download,
  HeatmapModel,
  HistogramModel,
  LinesModel,
  ViewDecl,
} from "../model";
import { type Element, h, toDom } from "../tree";
import type { SensorFieldClient } from "../worker-client";
import { renderFallback } from "./fallback";
import { type ViewContext, figure } from "./figure";
import { heatmapPixels, heatmapReadout, renderHeatmap } from "./heatmap";
import { histogramBars, histogramRows, renderHistogram } from "./histogram";
import {
  LINES_MARGIN,
  LINES_SIZE,
  linesPlot,
  linesReadout,
  nearestSeries,
  renderLines,
  rowAtPointer,
} from "./lines";
import {
  type PaintColors,
  type SensorFieldHandle,
  mountSensorField,
  renderSensorField,
} from "./sensor-field-view";
import { renderTable } from "./table";
import { VIEW_SENTENCES, sentence } from "./words";

export type { ViewContext } from "./figure";

/** A view's context from its declaration. */
export function viewContext(
  view: ViewDecl,
  id: string,
  downloadUrl?: ViewContext["downloadUrl"],
): ViewContext {
  return {
    id,
    caption: view.caption,
    kind: view.kind,
    kindVersion: view.kind_version,
    downloadUrl,
  };
}

function draw(built: BuiltModel, ctx: ViewContext): Element {
  const { model, downloads } = built;
  switch (model.type) {
    case "table":
      return renderTable(model, downloads, ctx);
    case "lines":
      return renderLines(model, downloads, ctx);
    case "heatmap":
      return renderHeatmap(model, downloads, ctx);
    case "histogram":
      return renderHistogram(model, downloads, ctx);
    case "sensor-field":
      return renderSensorField(model, downloads, ctx);
    case "fallback":
      return renderFallback(model, built, ctx);
    default:
      throw new Error(
        `no renderer for a model of type ${JSON.stringify((model as { type?: unknown }).type)}`,
      );
  }
}

/** The tree of a built view: its kind's renderer, or its tables when that cannot draw it. */
export function renderView(built: BuiltModel, ctx: ViewContext): Element {
  try {
    return draw(built, ctx);
  } catch (error) {
    console.error("[quality-views] a view could not be drawn; its tables are shown:", error);
    return renderFallback({ type: "fallback", tables: [] }, built, ctx);
  }
}

/** A view that is not drawn at all, with its word's sentence and the files still offered. */
export function renderRefusal(
  word: string,
  downloads: readonly Download[],
  ctx: ViewContext,
): Element {
  return figure({
    ctx,
    drawing: null,
    label: ctx.caption,
    notes: [h("p", { class: "qv-note", "data-word": word }, sentence(VIEW_SENTENCES, word))],
    downloads,
  });
}

// ── On the page ─────────────────────────────────────────────────────────

/** Step a selection by the arrow keys within `count` places. */
function step(key: string, at: number, count: number): number | null {
  if (key === "ArrowRight" || key === "ArrowDown") return Math.min(count - 1, at + 1);
  if (key === "ArrowLeft" || key === "ArrowUp") return Math.max(0, at - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

function attachLines(root: HTMLElement, model: LinesModel, readout: HTMLOutputElement): void {
  const svg = root.querySelector<SVGSVGElement>("svg.qv-lines");
  const cursor = root.querySelector<SVGLineElement>(".qv-cursor");
  const drawing = root.querySelector<HTMLElement>(".qv-drawing");
  if (!svg || !drawing) return;
  const plot = linesPlot(model);
  let row = 0;
  let series = 0;
  const show = (): void => {
    readout.textContent = linesReadout(model, row, series);
    const x = plot.px(model.x.values[row]);
    cursor?.setAttribute("x1", String(x));
    cursor?.setAttribute("x2", String(x));
    cursor?.setAttribute("visibility", "visible");
    for (const line of svg.querySelectorAll(".qv-series")) {
      line.classList.toggle("qv-selected", line.getAttribute("data-series") === String(series));
    }
  };
  svg.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * LINES_SIZE.width - LINES_MARGIN.left;
    const py = ((event.clientY - box.top) / box.height) * LINES_SIZE.height - LINES_MARGIN.top;
    row = rowAtPointer(model, plot, px);
    series = nearestSeries(model, plot, row, py);
    show();
  });
  drawing.addEventListener("keydown", (event) => {
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    const next = vertical
      ? step(
          event.key === "ArrowUp" ? "ArrowLeft" : "ArrowRight",
          series,
          model.series.items.length,
        )
      : step(event.key, row, model.x.values.length);
    if (next === null) return;
    event.preventDefault();
    if (vertical) series = next;
    else row = next;
    show();
  });
}

function attachHeatmap(root: HTMLElement, model: HeatmapModel, readout: HTMLOutputElement): void {
  const canvas = root.querySelector<HTMLCanvasElement>(".qv-heatmap-cells");
  const drawing = root.querySelector<HTMLElement>(".qv-drawing");
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx || !drawing) return;
  const rows = model.values.length;
  const columns = model.values[0].length;
  const image = ctx.createImageData(columns, rows);
  image.data.set(heatmapPixels(model));
  ctx.putImageData(image, 0, 0);
  let at: [number, number] = [0, 0];
  const show = (): void => {
    readout.textContent = heatmapReadout(model, at[0], at[1]);
  };
  canvas.addEventListener("pointermove", (event) => {
    const box = canvas.getBoundingClientRect();
    const r = Math.min(rows - 1, Math.floor(((event.clientY - box.top) / box.height) * rows));
    const c = Math.min(columns - 1, Math.floor(((event.clientX - box.left) / box.width) * columns));
    if (r < 0 || c < 0) return;
    at = [r, c];
    show();
  });
  drawing.addEventListener("keydown", (event) => {
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    const next = vertical ? step(event.key, at[0], rows) : step(event.key, at[1], columns);
    if (next === null) return;
    event.preventDefault();
    at = vertical ? [next, at[1]] : [at[0], next];
    show();
  });
}

function attachHistogram(
  root: HTMLElement,
  model: HistogramModel,
  readout: HTMLOutputElement,
): void {
  const drawing = root.querySelector<HTMLElement>(".qv-drawing");
  if (!drawing) return;
  // The bars in drawn order, each with its data-table row's text: label, count, density.
  const bars = histogramBars(model, 1, 1);
  const rows = histogramRows(model);
  const textOf = (k: number): string => {
    const bar = bars[k];
    const item = bar.index >= 0 && bar.index < model.items.length ? rows[bar.index] : null;
    const density = item && model.heights === "density" ? `, ${item[2]} per unit width` : "";
    return `${bar.label}: ${bar.count}${density}`;
  };
  let at = 0;
  const show = (): void => {
    readout.textContent = textOf(at);
    for (const el of root.querySelectorAll(".qv-bar")) {
      el.classList.toggle("qv-selected", el.getAttribute("data-index") === String(bars[at].index));
    }
  };
  for (const el of root.querySelectorAll<SVGElement>(".qv-bar")) {
    el.addEventListener("pointerenter", () => {
      const k = bars.findIndex((bar) => String(bar.index) === el.getAttribute("data-index"));
      if (k >= 0) {
        at = k;
        show();
      }
    });
  }
  drawing.addEventListener("keydown", (event) => {
    const next = step(event.key, at, bars.length);
    if (next === null) return;
    event.preventDefault();
    at = next;
    show();
  });
}

export interface MountedView {
  readonly element: HTMLElement;
  /** For a scalp map: its maps, their readouts and the export hook. */
  readonly field?: SensorFieldHandle;
}

export interface PageDeps {
  /** The page's one map client (`sharedSensorFieldClient()`). */
  readonly client: () => SensorFieldClient;
  /** The key the worker caches this view's geometry by: the layout file's SHA-256. */
  readonly layoutKey: string;
  readonly colors: PaintColors;
}

/** Draw a built view into `container`, replacing what it held, and attach its behavior. */
export function mountView(
  container: HTMLElement,
  built: BuiltModel,
  ctx: ViewContext,
  deps: PageDeps,
): MountedView {
  const tree = renderView(built, ctx);
  const element = toDom(tree, container.ownerDocument) as HTMLElement;
  container.replaceChildren(element);
  const readout = element.querySelector<HTMLOutputElement>(".qv-readout");
  const { model } = built;
  if (readout && model.type === "lines") attachLines(element, model, readout);
  if (readout && model.type === "heatmap") attachHeatmap(element, model, readout);
  if (readout && model.type === "histogram") attachHistogram(element, model, readout);
  if (model.type === "sensor-field") {
    const field = mountSensorField(
      element,
      { ...built, model },
      {
        client: deps.client(),
        layoutKey: deps.layoutKey,
        colors: deps.colors,
      },
    );
    return { element, field };
  }
  return { element };
}
