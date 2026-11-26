/**
 * One view's drawing steps, shared by the dataset page's panel (`panel.ts`) and the admin run
 * drill-down (`admin-drill.ts`), so the public and the admin renders of a view cannot diverge
 * (nemarOrg/website#600):
 *
 * 1. the view's declaration digest (`nemar.view-digest.v1`) is recomputed and compared with the
 *    record's before anything is drawn (`view_digest_mismatch` draws nothing);
 * 2. its files are checked against their sizes and SHA-256 as the model is built (`buildModel`),
 *    and a `ViewRefused` draws the refusal with the view's downloads;
 * 3. the base is mounted on the page's one map client, its geometry cached by the layout file's
 *    SHA-256 (`layoutKeyOf`);
 * 4. its kind's extras draw on, and a preset's own word is said under the base (`noteOf`), in the
 *    caller's sentences.
 *
 * The computed presets (the Signal window, the activations) are drawn only by a caller that asks
 * for them (`computed`): they have no stored data for a base, and the admin drill-down lists them
 * instead of drawing them.
 */

import type { ExtraContext } from "./extras/context";
import {
  type BuiltModel,
  type FileSource,
  type ModelOptions,
  type SensorFieldModel,
  type ViewDecl,
  ViewRefused,
  buildModel,
  downloadsOf,
} from "./model";
import type { QualityRecord } from "./record";
import {
  type MountedView,
  type ViewContext,
  mountView,
  renderRefusal,
  viewContext,
} from "./render/index";
import { toDom } from "./tree";
import { viewDigest } from "./verify";
import type { SensorFieldClient } from "./worker-client";

export type FieldHandle = NonNullable<MountedView["field"]>;

/** Each kind's extras beyond its base, a chunk of its own. */
const EXTRAS: Readonly<Record<string, () => Promise<{ draw(x: ExtraContext): Promise<void> }>>> = {
  "nemar.spectrum": () => import("./extras/spectrum"),
  "nemar.ic-maps": () => import("./extras/components"),
  "nemar.ic-classes": () => import("./extras/components"),
  "nemar.signal-window": () => import("./extras/signal"),
  "nemar.ic-activity": () => import("./extras/activity"),
};

/** The computed presets: no stored data for a base to draw, their extras draw them whole. */
const COMPUTED = ["nemar.signal-window", "nemar.ic-activity"];

/** Paint colors from the page's tokens. */
export function paintColors(root: HTMLElement) {
  const style = getComputedStyle(root);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    foreground: token("--qv-head-line", "#334155"),
    background: token("--color-bg", "#ffffff"),
    contour: token("--qv-contour-line", "rgb(15 23 42 / 45%)"),
  };
}

/** The model's options on the page's client. */
export const modelOptions = (client: () => SensorFieldClient): ModelOptions => ({
  checks: client().checks(),
  // Montages are needed only for template positions: loaded with the first that is.
  montage: (name) => import("./montage-loader").then((m) => m.loadMontage(name)),
});

/** The key the worker caches a view's geometry by: its layout file's SHA-256, else the view's. */
export const layoutKeyOf = (view: ViewDecl): string =>
  view.data?.find((d) => d.role === "layout")?.sha256 ?? `view:${view.key}`;

/** A scalp map drawn, with what it was drawn from (the Turbo toggle and the export read them). */
export interface DrawnField {
  readonly field: FieldHandle;
  readonly model: SensorFieldModel;
  readonly built: BuiltModel & { model: SensorFieldModel };
}

export type Mount = (
  target: HTMLElement,
  built: BuiltModel,
  ctx: ViewContext,
  layoutKey: string,
  signal: AbortSignal,
) => Promise<HTMLElement | null>;

/**
 * The page's mounts and the scalp-map handles they hold: one live handle per drawn target. A redraw
 * into the same element (the spectrum's maps at a picked row) ends the one before, and a mount that
 * finishes after its signal aborted ends its own.
 */
export function mapKeeper(
  root: HTMLElement,
  client: () => SensorFieldClient,
  onField: (field: FieldHandle) => void = () => {},
) {
  const fields = new Map<HTMLElement, DrawnField>();
  /** Every handle not yet destroyed (the panel's tests read how many). */
  const live = new Set<FieldHandle>();
  const end = (field: FieldHandle | undefined): void => {
    if (!field) return;
    field.destroy();
    live.delete(field);
  };
  const mount: Mount = async (target, built, ctx, layoutKey, signal) => {
    end(fields.get(target)?.field);
    fields.delete(target);
    const mounted = await mountView(
      target,
      built,
      ctx,
      { client, layoutKey, colors: paintColors(root) },
      signal,
    );
    if (mounted.field) live.add(mounted.field);
    if (signal.aborted) {
      end(mounted.field);
      return null;
    }
    if (mounted.field && built.model.type === "sensor-field") {
      fields.set(target, {
        field: mounted.field,
        model: built.model,
        built: built as BuiltModel & { model: SensorFieldModel },
      });
      onField(mounted.field);
    }
    return mounted.element;
  };
  return {
    fields,
    live,
    mount,
    /** End every drawn map. */
    drop(): void {
      for (const { field } of fields.values()) end(field);
      fields.clear();
      for (const field of live) end(field);
    },
  };
}

/** What a caller draws a view with. */
export interface DrawDeps {
  readonly doc: Document;
  /** The view's element id, before its key (`qp`, `qd`). */
  readonly idPrefix: string;
  /** A declared file's address, for the view's download links. */
  readonly fileUrl: NonNullable<ViewContext["downloadUrl"]>;
  /** The view's files, each checked against its size and SHA-256 as it is read. */
  readonly files: FileSource;
  readonly client: () => SensorFieldClient;
  readonly mount: Mount;
  /** A word's sentence, for a preset's own word under its base. */
  readonly sentence: (word: string) => Promise<string>;
  /** Draw the computed presets (the panel's Signal and Activations tabs). */
  readonly computed?: boolean;
}

/** What a view drew, for its export; undefined when it drew nothing to export. */
export type Drawn = { readonly built: BuiltModel | null; readonly files: FileSource } | undefined;

/** Draw one view into `container` (see the module's docblock for the steps). */
export async function drawView(
  view: ViewDecl,
  record: QualityRecord,
  container: HTMLElement,
  signal: AbortSignal,
  deps: DrawDeps,
): Promise<Drawn> {
  const { doc, files, client, sentence } = deps;
  const ctx = viewContext(view, `${deps.idPrefix}-${view.key}`, deps.fileUrl);
  const refuse = (word: string, downloads = downloadsOf(view)): undefined => {
    if (!signal.aborted) container.replaceChildren(toDom(renderRefusal(word, downloads, ctx), doc));
  };
  const digest = await viewDigest(view);
  if (signal.aborted) return;
  if (digest === null || digest !== record.digests[view.key]) return refuse("view_digest_mismatch");
  const opts = modelOptions(client);
  const layoutKey = layoutKeyOf(view);
  const computed = COMPUTED.includes(view.kind);
  const extras =
    Object.hasOwn(EXTRAS, view.kind) && (deps.computed || !computed) ? EXTRAS[view.kind] : null;
  const loading = extras?.();
  let built: BuiltModel | null = null;
  let figure: HTMLElement | null = null;
  if (!(deps.computed && computed)) {
    try {
      built = await buildModel(view, files, {
        ...opts,
        onLayout: (places) => {
          if (!signal.aborted) void client().prepare({ layoutKey, ...places });
        },
      });
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof ViewRefused)) throw error;
      return refuse(error.word, error.downloads);
    }
    if (signal.aborted) return;
    const target = doc.createElement("div");
    container.replaceChildren(target);
    figure = await deps.mount(target, built, ctx, layoutKey, signal);
    // A base that refused its files shows the fallback; the preset adds nothing to it.
    if (!figure || built.refused !== null) return;
  }
  if (!loading) return { built, files };
  try {
    const own = await loading;
    if (signal.aborted) return;
    await own.draw({
      doc,
      view,
      record,
      built,
      figure,
      container,
      source: files,
      options: opts,
      ctx,
      signal,
      mount: async (target, b, c) => void (await deps.mount(target, b, c, layoutKey, signal)),
      client: client(),
      sentence,
    });
    return { built, files };
  } catch (error) {
    if (signal.aborted) return;
    const word = (error as { word?: unknown }).word;
    if (typeof word !== "string") throw error;
    if (error instanceof ViewRefused) return refuse(word, error.downloads);
    // A preset's own word: the base stays drawn, and says why the extras are missing.
    const { noteOf, intoFigure } = await import("./extras/context");
    intoFigure(figure, await noteOf({ doc, sentence } as ExtraContext, word));
    return { built, files };
  }
}

/** A view that could not be drawn says so in its container, unless its work was aborted since. */
export async function sayFailed(
  container: HTMLElement,
  signal: AbortSignal,
  sentence: (word: string) => Promise<string>,
): Promise<void> {
  if (signal.aborted) return;
  const p = container.ownerDocument.createElement("p");
  p.className = "qv-note";
  p.dataset.word = "failed";
  p.textContent = await sentence("failed");
  if (!signal.aborted) container.replaceChildren(p);
}
