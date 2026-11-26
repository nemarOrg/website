/**
 * The dataset page's per-recording quality panel (website phase W6, #588; nemar-cli ADR 0137
 * decision 9, website ADR 0035): a recording picker built from the signal viewer's recording list,
 * tabs for the Spectrum, the Components and the Signal, the views of the recording's record drawn
 * through `buildModel` and `mountView` on the page's one map client, deep links
 * (`#quality/<recording>/<view key>`) and a Turbo toggle. Loaded on demand, when its tab first opens
 * or a deep link names it.
 *
 * Before a view is drawn its declaration's digest is recomputed and compared with the one the
 * route sent (`view_digest_mismatch` draws nothing), and its files are checked against their sizes
 * and SHA-256 before they are parsed (`model.ts`). A record the panel cannot show says why in one
 * of three states (`quality-api.ts`): none, not on this server yet, or failed with a word.
 */

import { attachExport } from "./export-hook";
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
import { type PanelRecording, panelRecordings, preloaded, recordFor } from "./panel-bridge";
import {
  DEFAULT_TAB,
  HASH_PREFIX,
  TABS,
  type TabId,
  formatQualityHash,
  parseQualityHash,
  qualityRecordings,
  readTurbo,
  tabOf,
  viewsByTab,
  writeTurbo,
} from "./panel-model";
import { preloadedSource } from "./preloaded";
import type { RecordOutcome } from "./quality-api";
import { fileUrl, recordFiles } from "./quality-files";
import type { QualityRecord } from "./record";
import { type MountedView, mountView, renderRefusal, viewContext } from "./render/index";

type FieldHandle = NonNullable<MountedView["field"]>;
import { toDom } from "./tree";
import { viewDigest } from "./verify";
import { type SensorFieldClient, sharedSensorFieldClient } from "./worker-client";

/** Each kind's extras beyond its base, a chunk of its own. */
const EXTRAS: Readonly<Record<string, () => Promise<{ draw(x: ExtraContext): Promise<void> }>>> = {
  "nemar.spectrum": () => import("./extras/spectrum"),
  "nemar.ic-maps": () => import("./extras/components"),
  "nemar.ic-classes": () => import("./extras/components"),
  "nemar.signal-window": () => import("./extras/signal"),
};

/** A word's sentence, from the panel's words, loaded the first time one is needed. */
const sentence = (word: string): Promise<string> =>
  import("./panel-words").then((m) => m.sentenceOf(word));

export interface PanelConfig {
  readonly root: HTMLElement;
  readonly datasetId: string;
  readonly version: string | null;
  readonly recipe: string;
  /** The data plane's origin. */
  readonly base: string;
}

export interface PanelDeps {
  readonly client?: () => SensorFieldClient;
  readonly fetch?: typeof fetch;
  readonly recordings?: () => Promise<readonly PanelRecording[] | null>;
  readonly storage?: () => Storage | null;
  /** The page's location, for the deep link (window.location by default). */
  readonly location?: Pick<Location, "hash" | "origin">;
  readonly history?: Pick<History, "replaceState" | "state">;
}

export interface PanelHandle {
  /** Settles when the recording on show is drawn (or has said why it is not). */
  ready(): Promise<void>;
  /** Show a link's recording, tab and view. */
  route(hash: string): Promise<void>;
  /** How many scalp-map handles are live (drawing or drawn, not yet destroyed). */
  liveMaps(): number;
  destroy(): void;
}

/** Paint colors from the page's tokens. */
function paintColors(root: HTMLElement) {
  const style = getComputedStyle(root);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    foreground: token("--qv-head-line", "#334155"),
    background: token("--color-bg", "#ffffff"),
    contour: token("--qv-contour-line", "rgb(15 23 42 / 45%)"),
  };
}

export function mountQualityPanel(config: PanelConfig, deps: PanelDeps = {}): PanelHandle {
  const { root, datasetId, recipe, base } = config;
  const doc = root.ownerDocument;
  const client = deps.client ?? sharedSensorFieldClient;
  const storage = deps.storage ?? (() => globalThis.localStorage ?? null);
  const location = deps.location ?? globalThis.location;
  const history = deps.history ?? globalThis.history;
  const select = root.querySelector<HTMLSelectElement>("[data-qp-recording]")!;
  const turboButton = root.querySelector<HTMLButtonElement>("[data-qp-turbo]");
  const status = root.querySelector<HTMLElement>("[data-qp-status]")!;
  const tabs = new Map<TabId, HTMLButtonElement>();
  const panels = new Map<TabId, HTMLElement>();
  for (const tab of TABS) {
    const button = root.querySelector<HTMLButtonElement>(`[data-qp-tab="${tab.id}"]`);
    const panel = root.querySelector<HTMLElement>(`[data-qp-panel="${tab.id}"]`);
    if (button && panel) {
      tabs.set(tab.id, button);
      panels.set(tab.id, panel);
    }
  }

  let recordings: PanelRecording[] = [];
  let path: string | null = null;
  let active: TabId = DEFAULT_TAB;
  let wanted: string | null = null;
  let record: QualityRecord | null = null;
  /** The recording on show's work: aborted when another recording is shown. Each draw keeps the
   *  signal it started under and stops at its next step once that signal aborts. */
  let controller = new AbortController();
  let drawn = new Map<TabId, Promise<void>>();
  /** The scalp maps drawn, by the element they were drawn into: one live handle per target. */
  const fields = new Map<
    HTMLElement,
    { field: FieldHandle; model: SensorFieldModel; built: BuiltModel & { model: SensorFieldModel } }
  >();
  let turbo = readTurbo(storage);
  let current: Promise<void> = Promise.resolve();

  const say = async (word: string | null): Promise<void> => {
    const text = word ? await sentence(word) : "";
    status.textContent = text;
    status.hidden = word === null;
  };

  const colorOf = (model: SensorFieldModel) =>
    turbo ? "turbo" : model.limits === "absmax" ? "diverging" : "sequential";

  const applyTurbo = (): void => {
    turboButton?.setAttribute("aria-pressed", String(turbo));
    for (const [target, { field, model }] of fields) {
      if (!target.isConnected) continue;
      field.setColorMap(colorOf(model));
    }
    for (const button of root.querySelectorAll(".qv-turbo")) {
      button.setAttribute("aria-pressed", String(turbo));
    }
  };

  /** Every scalp-map handle not yet destroyed: one per drawn target (the tests read it). */
  const live = new Set<FieldHandle>();
  const end = (field: FieldHandle | undefined): void => {
    if (!field) return;
    field.destroy();
    live.delete(field);
  };

  const dropFields = (): void => {
    for (const { field } of fields.values()) end(field);
    fields.clear();
  };

  /** The address bar's hash names the recording and view on show: the deep link to copy. */
  const showLink = (key: string | null): void =>
    history.replaceState(history.state ?? null, "", formatQualityHash({ recording: path, key }));

  const options = (): ModelOptions => ({
    checks: client().checks(),
    // Montages are needed only for template positions: loaded with the first that is.
    montage: (name) => import("./montage-loader").then((m) => m.loadMontage(name)),
  });

  const source = (r: QualityRecord, signal: AbortSignal) =>
    preloadedSource(recordFiles(base, r, { signal, fetch: deps.fetch }));

  const pageDeps = (layoutKey: string) => ({
    client,
    layoutKey,
    colors: paintColors(root),
  });

  const layoutKeyOf = (view: ViewDecl): string =>
    view.data?.find((d) => d.role === "layout")?.sha256 ?? `view:${view.key}`;

  const mountInto = async (
    target: HTMLElement,
    built: BuiltModel,
    ctx: ReturnType<typeof viewContext>,
    layoutKey: string,
    signal: AbortSignal,
  ): Promise<HTMLElement | null> => {
    // A redraw into the same element (the spectrum's maps at a picked row) ends the one before.
    end(fields.get(target)?.field);
    fields.delete(target);
    const mounted = await mountView(target, built, ctx, pageDeps(layoutKey), signal);
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
      if (turbo) mounted.field.setColorMap("turbo");
    }
    return mounted.element;
  };

  /** Draw one view; what it drew, for its export, or nothing when it drew nothing to export. */
  async function drawView(
    view: ViewDecl,
    r: QualityRecord,
    container: HTMLElement,
    signal: AbortSignal,
  ): Promise<{ built: BuiltModel | null; files: FileSource } | undefined> {
    const ctx = viewContext(view, `qp-${view.key}`, (file) => fileUrl(base, r, file));
    const refuse = (word: string, downloads = downloadsOf(view)): undefined => {
      if (!signal.aborted)
        container.replaceChildren(toDom(renderRefusal(word, downloads, ctx), doc));
    };
    const digest = await viewDigest(view);
    if (signal.aborted) return;
    if (digest === null || digest !== r.digests[view.key]) return refuse("view_digest_mismatch");
    const opts = options();
    const files = source(r, signal);
    const layoutKey = layoutKeyOf(view);
    const extras = Object.hasOwn(EXTRAS, view.kind) ? EXTRAS[view.kind] : null;
    const loading = extras?.();
    let built: BuiltModel | null = null;
    let figure: HTMLElement | null = null;
    if (view.kind !== "nemar.signal-window") {
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
      figure = await mountInto(target, built, ctx, layoutKey, signal);
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
        record: r,
        built,
        figure,
        container,
        source: files,
        options: opts,
        ctx,
        signal,
        mount: async (target, b, c) => void (await mountInto(target, b, c, layoutKey, signal)),
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

  function drawTab(tab: TabId): Promise<void> {
    const held = drawn.get(tab);
    if (held) return held;
    const r = record;
    const panel = panels.get(tab);
    if (!r || !panel) return Promise.resolve();
    const { signal } = controller;
    const keys = viewsByTab(r.views as unknown as ViewDecl[]).get(tab) ?? [];
    const skipped = r.skipped.filter((s) => tabOf(s.kind) === tab);
    panel.replaceChildren();
    const said = (word: string, text: (sentence: string) => string): void => {
      const p = doc.createElement("p");
      p.className = "qv-note";
      p.dataset.word = word;
      panel.append(p);
      void import("./panel-words").then((m) => {
        if (!signal.aborted) p.textContent = text(m.sentenceOf(word, "skipped_unknown"));
      });
    };
    if (keys.length === 0 && skipped.length === 0) said("no_view", (t) => t);
    for (const s of skipped) {
      said(s.reason, (t) => `The view ${s.key} was not written for this recording: ${t}.`);
    }
    const work = Promise.all(
      keys.map((key) => {
        const view = r.views.find((v) => v.key === key) as unknown as ViewDecl;
        const container = doc.createElement("div");
        container.className = "qp-view";
        container.dataset.qpView = key;
        panel.append(container);
        return drawView(view, r, container, signal).then(
          (drew) => {
            // The view's Export toggle, its code loaded when first opened (phase W8).
            if (drew && !signal.aborted)
              attachExport(container, {
                ...drew,
                view,
                record: r,
                fields,
                container,
                colorOf,
                version: config.version,
                origin: location.origin,
              });
          },
          async (error: unknown) => {
            if (signal.aborted) return;
            console.error("[quality-views] a view of the panel could not be drawn:", error);
            const p = doc.createElement("p");
            p.className = "qv-note";
            p.dataset.word = "failed";
            p.textContent = await sentence("failed");
            if (!signal.aborted) container.replaceChildren(p);
          },
        );
      }),
    ).then(() => {
      if (!signal.aborted && wanted && keys.includes(wanted)) {
        panel.querySelector(`[data-qp-view="${wanted}"]`)?.scrollIntoView({ block: "nearest" });
      }
    });
    drawn.set(tab, work);
    return work;
  }

  /** The tab of a view of the record on show, or the active tab (`activate` falls back to the
   *  default tab when that one is hidden). */
  const tabOfKey = (key: string | null): TabId => {
    const kind = record?.views.find((v) => v.key === key)?.kind;
    return typeof kind === "string" ? tabOf(kind) : active;
  };

  function activate(tab: TabId, write = true): Promise<void> {
    active = tabs.get(tab)?.hidden ? DEFAULT_TAB : tab;
    for (const [id, button] of tabs) {
      const on = id === active;
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
      panels.get(id)!.hidden = !on;
    }
    if (write && path) {
      const keys = record ? (viewsByTab(record.views as never).get(active) ?? []) : [];
      showLink(wanted && keys.includes(wanted) ? wanted : (keys[0] ?? null));
    }
    return drawTab(active);
  }

  /** The record of a recording: the idle preload's when it settles the question, else asked now. */
  const recordOf = (recording: string, signal: AbortSignal): Promise<RecordOutcome> =>
    recordFor(recording, async () => {
      const { fetchRecord } = await import("./quality-api");
      return fetchRecord({ base, datasetId, recipe, recording }, { signal, fetch: deps.fetch });
    });

  async function show(recording: string, key: string | null, write: boolean): Promise<void> {
    controller.abort();
    controller = new AbortController();
    const { signal } = controller;
    drawn = new Map();
    dropFields();
    path = recording;
    wanted = key;
    record = null;
    select.value = recording;
    for (const panel of panels.values()) panel.replaceChildren();
    status.textContent = "Loading the recording's quality views…";
    status.hidden = false;
    let outcome: RecordOutcome;
    try {
      outcome = await recordOf(recording, signal);
    } catch (error) {
      if (signal.aborted) return;
      console.error("[quality-views] the recording's record could not be read:", error);
      await say("failed");
      return;
    }
    if (signal.aborted) return;
    if (outcome.kind !== "ok") {
      await say(outcome.kind === "failed" ? outcome.word : outcome.kind);
      if (write) showLink(null);
      return;
    }
    record = outcome.record;
    void say(null);
    tabs.get("other")!.hidden = !viewsByTab(record.views as never).get("other")?.length;
    await activate(tabOfKey(key), write);
  }

  async function route(hash: string): Promise<void> {
    const link = parseQualityHash(hash);
    if (!link) return;
    const recording =
      link.recording && recordings.some((r) => r.path === link.recording)
        ? link.recording
        : (recordings[0]?.path ?? null);
    if (!recording) return;
    if (recording === path && record) {
      wanted = link.key;
      current = activate(tabOfKey(link.key), false);
    } else {
      current = show(recording, link.key, false);
    }
    await current;
  }

  // ── Wiring ──────────────────────────────────────────────────────────

  const onTabKey = (event: KeyboardEvent): void => {
    const order = TABS.map((t) => t.id).filter((id) => !tabs.get(id)?.hidden);
    const at = order.indexOf(active);
    const next =
      event.key === "ArrowRight"
        ? order[(at + 1) % order.length]
        : event.key === "ArrowLeft"
          ? order[(at - 1 + order.length) % order.length]
          : event.key === "Home"
            ? order[0]
            : event.key === "End"
              ? order[order.length - 1]
              : null;
    if (!next) return;
    event.preventDefault();
    tabs.get(next)?.focus();
    wanted = null;
    current = activate(next);
  };
  for (const [id, button] of tabs) {
    button.addEventListener("click", () => {
      wanted = null;
      current = activate(id);
    });
    button.addEventListener("keydown", onTabKey);
  }
  select.addEventListener("change", () => {
    current = show(select.value, null, true);
  });
  turboButton?.addEventListener("click", () => {
    turbo = !turbo;
    writeTurbo(storage, turbo);
    applyTurbo();
  });
  turboButton?.setAttribute("aria-pressed", String(turbo));
  // Warm the map worker as the panel mounts, unless the idle preload already did (W4's #592).
  if (!preloaded()) void client().warm();
  const onHash = (): void => void route(location.hash);
  addEventListener("hashchange", onHash);

  const started = (async () => {
    const list = await (deps.recordings ?? panelRecordings)();
    if (list === null) return void (await say("no_index"));
    recordings = qualityRecordings(list);
    if (recordings.length === 0) return void (await say("no_recordings"));
    select.replaceChildren(
      ...recordings.map((r) => {
        const option = doc.createElement("option");
        option.value = r.path;
        option.textContent = r.name;
        return option;
      }),
    );
    select.disabled = false;
    // A link names the recording and view to show; without one, the default recording.
    await route(parseQualityHash(location.hash) ? location.hash : HASH_PREFIX);
  })();

  return {
    ready: async () => {
      await started;
      await current;
      await Promise.all([...drawn.values()]);
    },
    route,
    liveMaps: () => live.size,
    destroy() {
      controller.abort();
      removeEventListener("hashchange", onHash);
      dropFields();
    },
  };
}
