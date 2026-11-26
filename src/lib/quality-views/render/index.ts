/**
 * Which renderer draws a built view (the live-views plan's C2 on the page; website ADR 0035
 * decision 3). Each renderer is its own chunk, loaded when a model of its type is drawn, so a page
 * that shows a histogram never loads the scalp maps' code (the owner's ruling on #594's size).
 *
 * `renderView` never rejects: a model it has no renderer for shows the view's tables, and a
 * renderer that fails (or cannot be loaded) says the view could not be drawn and lists its files.
 * `renderRefusal` words a view that is not drawn at all (an invalid declaration, or a file not the
 * one recorded). The figure frame, the fallback and the words are small and load with this file.
 */

import type { BuiltModel, Download, Model, ViewDecl } from "../model";
import { type Element, h, toDom } from "../tree";
import type { SensorFieldClient } from "../worker-client";
import { RENDER_FAILED, renderFallback } from "./fallback";
import { type ViewContext, figure } from "./figure";
import { attachLazyTable } from "./interact";
import type { PaintColors, SensorFieldHandle } from "./sensor-field-view";
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

export interface PageDeps {
  /** The page's one map client (`sharedSensorFieldClient()`). */
  readonly client: () => SensorFieldClient;
  /** The key the worker caches this view's geometry by: the layout file's SHA-256. */
  readonly layoutKey: string;
  readonly colors: PaintColors;
}

/** A renderer: the tree, its data table, and what it does once on the page. */
interface Renderer {
  render(built: BuiltModel, ctx: ViewContext): { tree: Element; table?: () => Element };
  attach?(root: HTMLElement, built: BuiltModel, deps: PageDeps): SensorFieldHandle | undefined;
}

/** Each model type's renderer, loaded on demand. */
const RENDERERS: Readonly<Record<string, () => Promise<Renderer>>> = {
  table: () =>
    import("./table").then((m) => ({
      render: (b, ctx) => ({ tree: m.renderTable(b.model as never, b.downloads, ctx) }),
    })),
  lines: () =>
    import("./lines").then((m) => ({
      render: (b, ctx) => ({
        tree: m.renderLines(b.model as never, b.downloads, ctx),
        table: () => m.linesTable(b.model as never, ctx.caption),
      }),
      attach: (root, b) => {
        m.attachLines(root, b.model as never);
        return undefined;
      },
    })),
  heatmap: () =>
    import("./heatmap").then((m) => ({
      render: (b, ctx) => ({
        tree: m.renderHeatmap(b.model as never, b.downloads, ctx),
        table: () => m.heatmapTable(b.model as never, ctx.caption),
      }),
      attach: (root, b) => {
        m.attachHeatmap(root, b.model as never);
        return undefined;
      },
    })),
  histogram: () =>
    import("./histogram").then((m) => ({
      render: (b, ctx) => ({
        tree: m.renderHistogram(b.model as never, b.downloads, ctx),
        table: () => m.histogramTable(b.model as never, ctx.caption),
      }),
      attach: (root, b) => {
        m.attachHistogram(root, b.model as never);
        return undefined;
      },
    })),
  "sensor-field": () =>
    import("./sensor-field-view").then((m) => ({
      render: (b, ctx) => ({
        tree: m.renderSensorField(b.model as never, b.downloads, ctx),
        table: () => m.fieldTable(b.model as never, ctx.caption),
      }),
      attach: (root, b, deps) =>
        m.mountSensorField(root, b as never, {
          client: deps.client(),
          layoutKey: deps.layoutKey,
          colors: deps.colors,
        }),
    })),
};

/** The renderer for a model, or null for the fallback (and for a type no renderer knows). */
async function rendererOf(model: Model): Promise<Renderer | null> {
  const load = Object.prototype.hasOwnProperty.call(RENDERERS, model.type)
    ? RENDERERS[model.type]
    : undefined;
  return load ? load() : null;
}

/** The tree of a built view and its data table, its renderer loaded on demand. */
export async function renderView(
  built: BuiltModel,
  ctx: ViewContext,
): Promise<{ tree: Element; table?: () => Element; renderer: Renderer | null }> {
  try {
    const renderer = await rendererOf(built.model);
    if (!renderer) {
      const model =
        built.model.type === "fallback" ? built.model : { type: "fallback" as const, tables: [] };
      return { tree: renderFallback(model, built, ctx), renderer: null };
    }
    return { ...renderer.render(built, ctx), renderer };
  } catch (error) {
    console.error("[quality-views] a view could not be drawn; its files are listed:", error);
    return {
      tree: renderFallback({ type: "fallback", tables: [] }, built, ctx, RENDER_FAILED),
      renderer: null,
    };
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

export interface MountedView {
  readonly element: HTMLElement;
  /** For a scalp map: its maps, their readouts and the export hook. */
  readonly field?: SensorFieldHandle;
}

/** Draw a built view into `container`, replacing what it held, and attach its behavior. */
export async function mountView(
  container: HTMLElement,
  built: BuiltModel,
  ctx: ViewContext,
  deps: PageDeps,
): Promise<MountedView> {
  const { tree, table, renderer } = await renderView(built, ctx);
  const element = toDom(tree, container.ownerDocument) as HTMLElement;
  container.replaceChildren(element);
  attachLazyTable(element, table);
  let field: SensorFieldHandle | undefined;
  try {
    field = renderer?.attach?.(element, built, deps);
  } catch (error) {
    console.error("[quality-views] a view's behavior could not be attached:", error);
  }
  return field ? { element, field } : { element };
}
