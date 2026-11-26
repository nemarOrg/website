/**
 * The dataset page's per-recording quality panel (website phase W6, #588; nemar-cli ADR 0137
 * decision 9, website ADR 0035): a recording picker built from the signal viewer's recording list,
 * tabs for the Spectrum, the Components and the Signal, the views of the recording's record drawn
 * through `buildModel` and `mountView` on the page's one map client, deep links
 * (`#quality/<recording>/<view key>`) and a Turbo toggle. Loaded on demand, when its tab first opens
 * or a deep link names it.
 *
 * Each view is drawn by the steps the admin drill-down shares (`draw-view.ts`): before a view is
 * drawn its declaration's digest is recomputed and compared with the one the route sent
 * (`view_digest_mismatch` draws nothing), and its files are checked against their sizes and
 * SHA-256 before they are parsed (`model.ts`). A record the panel cannot show says why in one
 * of three states (`quality-api.ts`): none, not on this server yet, or failed with a word.
 */

import { drawView, mapKeeper, sayFailed } from "./draw-view";
import { attachExport } from "./export-hook";
import type { SensorFieldModel, ViewDecl } from "./model";
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
import { type SensorFieldClient, sharedSensorFieldClient } from "./worker-client";

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
  let turbo = readTurbo(storage);
  /** The scalp maps drawn, by the element they were drawn into: one live handle per target. */
  const maps = mapKeeper(root, client, (field) => {
    if (turbo) field.setColorMap("turbo");
  });
  const { fields } = maps;
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

  /** The address bar's hash names the recording and view on show: the deep link to copy. */
  const showLink = (key: string | null): void =>
    history.replaceState(history.state ?? null, "", formatQualityHash({ recording: path, key }));

  const source = (r: QualityRecord, signal: AbortSignal) =>
    preloadedSource(recordFiles(base, r, { signal, fetch: deps.fetch }));

  /** Draw one view as the admin drill-down draws it (`draw-view.ts`), the computed ones too. */
  const draw = (view: ViewDecl, r: QualityRecord, container: HTMLElement, signal: AbortSignal) =>
    drawView(view, r, container, signal, {
      doc,
      idPrefix: "qp",
      fileUrl: (file) => fileUrl(base, r, file),
      files: source(r, signal),
      client,
      mount: maps.mount,
      sentence,
      computed: true,
    });

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
        return draw(view, r, container, signal).then(
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
          (error: unknown) => {
            if (signal.aborted) return;
            console.error("[quality-views] a view of the panel could not be drawn:", error);
            return sayFailed(container, signal, sentence);
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
    maps.drop();
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
    liveMaps: () => maps.live.size,
    destroy() {
      controller.abort();
      removeEventListener("hashchange", onHash);
      maps.drop();
    },
  };
}
