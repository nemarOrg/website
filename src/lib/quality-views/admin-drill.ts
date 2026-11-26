/**
 * The admin run drill-down's views (website phase W9, #588; nemar-cli ADR 0137 decision 7): one
 * recording of one run, its record and files read through the site's same-origin proxy of the
 * admin mount (`admin-proxy.ts`), drawn by the same renderers as the dataset page's panel (W4,
 * W6). Loaded on demand by `src/pages/admin/pipelines/runs/[stamp]/quality.astro`.
 *
 * STORED DATA ONLY. A view that declares `inputs` is computed from the dataset's signal
 * (`nemar.ic-activity`, `nemar.signal-window`): it is listed with the words "drawn on the dataset
 * page once promoted" and never drawn here, so this page reads no signal store and needs no change
 * to the site's content security policy. The views drawn are the Spectrum, the component maps and
 * the class histogram, and any other stored view under its own heading.
 *
 * The checks are the panel's: the record's text checked whole (`readRecordAnswer`, the run's
 * dataset, recipe and recording), each view's `nemar.view-digest.v1` compared before it is drawn,
 * and each file's size and SHA-256 before it is parsed (`buildModel`). The admin mount sends no
 * `ETag` (nothing of it may be cached), so a record is read without one, and checked against one
 * when it comes with one. The views the record says were not written (`views_skipped`) are said
 * in their group, in the public panel's words. Panel overlap: `panel.ts` holds the same drawing
 * steps for the public route; they are repeated here, not shared, while W7 and W8 change that
 * file. nemarOrg/website#600 lifts one shared `drawView` out of both once W7 and W8 land.
 */

import { ADMIN_VIEW_SENTENCES, PIPELINE_QUALITY_LABELS } from "../pipeline-quality-labels";
import { siteAdminFilePath, siteAdminRecordPath } from "./admin-route-contract";
import type { ExtraContext } from "./extras/context";
import {
  type BuiltModel,
  type FileSource,
  type ModelOptions,
  type ViewDecl,
  ViewRefused,
  buildModel,
  downloadsOf,
} from "./model";
import { TABS, type TabId, tabOf } from "./panel-model";
import { readLimited } from "./preloaded";
import { type QualityRecord, readRecordAnswer } from "./record";
import { type MountedView, mountView, renderRefusal, viewContext } from "./render/index";
import { QUALITY_RECORD_MAX_BYTES } from "./route-contract";
import { toDom } from "./tree";
import { viewDigest } from "./verify";
import { type SensorFieldClient, sharedSensorFieldClient } from "./worker-client";

type FieldHandle = NonNullable<MountedView["field"]>;

const EXTRAS: Readonly<Record<string, () => Promise<{ draw(x: ExtraContext): Promise<void> }>>> = {
  "nemar.spectrum": () => import("./extras/spectrum"),
  "nemar.ic-maps": () => import("./extras/components"),
  "nemar.ic-classes": () => import("./extras/components"),
};

/** A word's sentence: the admin mount's and the proxy's, else the panel's. */
export async function adminSentence(word: string): Promise<string> {
  if (Object.hasOwn(ADMIN_VIEW_SENTENCES, word)) return ADMIN_VIEW_SENTENCES[word];
  return (await import("./panel-words")).sentenceOf(word);
}

/** The views a record says the run did not write (`views_skipped`), by the panel's tab of their kind. */
export function skippedByTab(
  skipped: QualityRecord["skipped"],
): Map<TabId, { key: string; kind: string; reason: string }[]> {
  const out = new Map<TabId, { key: string; kind: string; reason: string }[]>();
  for (const s of skipped) {
    const tab = tabOf(s.kind);
    out.set(tab, [...(out.get(tab) ?? []), s]);
  }
  return out;
}

/**
 * The drill-down's groups, in the panel's tab order: each tab with the stored views it draws and the
 * views the run did not write; a tab with neither is left out.
 */
export function drillGroups<V extends { readonly kind: string }>(
  stored: readonly V[],
  skipped: QualityRecord["skipped"],
): {
  tab: (typeof TABS)[number];
  views: V[];
  skipped: { key: string; kind: string; reason: string }[];
}[] {
  const notWritten = skippedByTab(skipped);
  return TABS.map((tab) => ({
    tab,
    views: stored.filter((v) => tabOf(v.kind) === tab.id),
    skipped: notWritten.get(tab.id) ?? [],
  })).filter((g) => g.views.length > 0 || g.skipped.length > 0);
}

/** A skipped view's sentence, the public panel's (`panel.ts`), its reason from the panel's words. */
export async function skippedText(s: { key: string; reason: string }): Promise<string> {
  const { sentenceOf } = await import("./panel-words");
  return `The view ${s.key} was not written for this recording: ${sentenceOf(s.reason, "skipped_unknown")}.`;
}

export type AdminRecordOutcome =
  | { readonly kind: "ok"; readonly record: QualityRecord }
  | { readonly kind: "failed"; readonly word: string };

export interface DrillAsk {
  readonly stampId: number;
  readonly datasetId: string;
  readonly recipe: string;
  readonly recording: string;
}

/** The `{ "error": <word> }` of a refusal, or null. Any word is kept: its sentence decides. */
function errorWord(bytes: Uint8Array | null): string | null {
  if (!bytes) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { error?: unknown };
    return typeof body?.error === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(body.error)
      ? body.error
      : null;
  } catch {
    return null;
  }
}

/** Read one recording's record of the run through the proxy. Never rejects but on abort. */
export async function fetchAdminRecord(
  ask: DrillAsk,
  options: { readonly signal?: AbortSignal; readonly fetch?: typeof fetch } = {},
): Promise<AdminRecordOutcome> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(siteAdminRecordPath(ask.stampId, ask.recording), {
      signal: options.signal,
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { kind: "failed", word: "network" };
  }
  if (!response.ok) {
    const body = await readLimited(new Response(response.body), 4096).catch(() => null);
    return { kind: "failed", word: errorWord(body) ?? `http_${response.status}` };
  }
  const bytes = await readLimited(response, QUALITY_RECORD_MAX_BYTES).catch((error: unknown) => {
    if (options.signal?.aborted) throw error;
    return null;
  });
  if (!bytes) return { kind: "failed", word: "record_too_large" };
  const record = await readRecordAnswer(bytes, response.headers.get("ETag"), ask, false);
  return typeof record === "string" ? { kind: "failed", word: record } : { kind: "ok", record };
}

/** The model's file source: each declared file through the proxy, read no further than its size. */
export function adminFiles(
  stampId: number,
  record: QualityRecord,
  options: { readonly signal?: AbortSignal; readonly fetch?: typeof fetch } = {},
): FileSource {
  const held = new Map<string, Promise<Uint8Array | null>>();
  return (file) => {
    let pending = held.get(file.sha256);
    if (!pending) {
      pending = (options.fetch ?? fetch)(
        siteAdminFilePath(stampId, file.sha256, record.recording),
        { signal: options.signal, credentials: "same-origin" },
      ).then(
        (response) => readLimited(response, file.size),
        (error: unknown) => {
          if (options.signal?.aborted) throw error;
          return null;
        },
      );
      held.set(file.sha256, pending);
    }
    return pending;
  };
}

export interface DrillConfig {
  readonly root: HTMLElement;
  readonly stampId: number;
  readonly datasetId: string;
  readonly recipe: string;
}

export interface DrillDeps {
  readonly client?: () => SensorFieldClient;
  readonly fetch?: typeof fetch;
}

export interface DrillHandle {
  ready(): Promise<void>;
  show(recording: string): Promise<void>;
  destroy(): void;
}

function paintColors(root: HTMLElement) {
  const style = getComputedStyle(root);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    foreground: token("--qv-head-line", "#334155"),
    background: token("--color-bg", "#ffffff"),
    contour: token("--qv-contour-line", "rgb(15 23 42 / 45%)"),
  };
}

/** Mount the drill-down on `root`: its `[data-qd-recording]` picker, status, views and computed list. */
export function mountAdminDrill(config: DrillConfig, deps: DrillDeps = {}): DrillHandle {
  const { root, stampId, datasetId, recipe } = config;
  const doc = root.ownerDocument;
  const client = deps.client ?? sharedSensorFieldClient;
  const select = root.querySelector<HTMLSelectElement>("[data-qd-recording]");
  const status = root.querySelector<HTMLElement>("[data-qd-status]")!;
  const views = root.querySelector<HTMLElement>("[data-qd-views]")!;
  const computed = root.querySelector<HTMLElement>("[data-qd-computed]")!;
  const live = new Set<FieldHandle>();
  let controller = new AbortController();
  let current: Promise<void> = Promise.resolve();

  const say = async (word: string | null): Promise<void> => {
    status.textContent = word === null ? "" : await adminSentence(word);
    status.hidden = word === null;
    if (word !== null) status.dataset.word = word;
    else delete status.dataset.word;
  };

  const dropFields = (): void => {
    for (const field of live) field.destroy();
    live.clear();
  };

  const options = (): ModelOptions => ({
    checks: client().checks(),
    montage: (name) => import("./montage-loader").then((m) => m.loadMontage(name)),
  });

  async function drawView(
    view: ViewDecl,
    record: QualityRecord,
    files: FileSource,
    container: HTMLElement,
    signal: AbortSignal,
  ): Promise<void> {
    const ctx = viewContext(view, `qd-${view.key}`, (file) =>
      siteAdminFilePath(stampId, file.sha256, record.recording),
    );
    const refuse = (word: string, downloads = downloadsOf(view)): void => {
      if (!signal.aborted)
        container.replaceChildren(toDom(renderRefusal(word, downloads, ctx), doc));
    };
    const digest = await viewDigest(view);
    if (signal.aborted) return;
    if (digest === null || digest !== record.digests[view.key])
      return refuse("view_digest_mismatch");
    const opts = options();
    const layoutKey = view.data?.find((d) => d.role === "layout")?.sha256 ?? `view:${view.key}`;
    const loading = Object.hasOwn(EXTRAS, view.kind) ? EXTRAS[view.kind]() : null;
    let built: BuiltModel;
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
    const mount = async (target: HTMLElement, b: BuiltModel, c: ReturnType<typeof viewContext>) => {
      const mounted = await mountView(
        target,
        b,
        c,
        { client, layoutKey, colors: paintColors(root) },
        signal,
      );
      if (mounted.field) live.add(mounted.field);
      return mounted.element;
    };
    const target = doc.createElement("div");
    container.replaceChildren(target);
    const figure = await mount(target, built, ctx);
    if (!figure || built.refused !== null || !loading) return;
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
        mount: async (t, b, c) => void (await mount(t, b, c)),
        sentence: adminSentence,
      });
    } catch (error) {
      if (signal.aborted) return;
      const word = (error as { word?: unknown }).word;
      if (typeof word !== "string") throw error;
      if (error instanceof ViewRefused) return refuse(word, error.downloads);
      const { noteOf, intoFigure } = await import("./extras/context");
      intoFigure(figure, await noteOf({ doc, sentence: adminSentence } as ExtraContext, word));
    }
  }

  function listComputed(list: readonly ViewDecl[]): void {
    if (list.length === 0) {
      const p = doc.createElement("p");
      p.className = "qv-note";
      p.textContent = PIPELINE_QUALITY_LABELS.noComputed;
      computed.replaceChildren(p);
      return;
    }
    const ul = doc.createElement("ul");
    for (const view of list) {
      const li = doc.createElement("li");
      li.dataset.qdComputed = view.key;
      const name = doc.createElement("code");
      name.textContent = view.key;
      li.append(name, ` (${view.kind}): ${PIPELINE_QUALITY_LABELS.computedNote}.`);
      ul.append(li);
    }
    computed.replaceChildren(ul);
  }

  async function show(recording: string): Promise<void> {
    controller.abort();
    controller = new AbortController();
    const { signal } = controller;
    dropFields();
    views.replaceChildren();
    computed.replaceChildren();
    if (select) select.value = recording;
    status.textContent = PIPELINE_QUALITY_LABELS.loading;
    status.hidden = false;
    const outcome = await fetchAdminRecord(
      { stampId, datasetId, recipe, recording },
      { signal, fetch: deps.fetch },
    ).catch((error: unknown) => {
      if (signal.aborted) return null;
      console.error("[admin-quality] the recording's record could not be read:", error);
      return { kind: "failed", word: "failed" } as const;
    });
    if (outcome === null || signal.aborted) return;
    if (outcome.kind !== "ok") return say(outcome.word);
    const record = outcome.record;
    await say(null);
    const all = record.views as unknown as ViewDecl[];
    const stored = all.filter((v) => !Object.hasOwn(v, "inputs"));
    listComputed(all.filter((v) => Object.hasOwn(v, "inputs")));
    const files = adminFiles(stampId, record, { signal, fetch: deps.fetch });
    const work: Promise<void>[] = [];
    for (const { tab, views: mine, skipped: notWritten } of drillGroups(stored, record.skipped)) {
      const section = doc.createElement("section");
      section.className = "qd-group";
      section.dataset.qdGroup = tab.id;
      const h = doc.createElement("h3");
      h.textContent = tab.label;
      section.append(h);
      views.append(section);
      // The views the run did not write, said as the public panel says them.
      for (const s of notWritten) {
        const p = doc.createElement("p");
        p.className = "qv-note";
        p.dataset.word = s.reason;
        p.dataset.qdSkipped = s.key;
        section.append(p);
        work.push(
          skippedText(s).then((text) => {
            if (!signal.aborted) p.textContent = text;
          }),
        );
      }
      for (const view of mine) {
        const container = doc.createElement("div");
        container.className = "qd-view";
        container.dataset.qdView = view.key;
        section.append(container);
        work.push(
          drawView(view, record, files, container, signal).catch(async (error: unknown) => {
            if (signal.aborted) return;
            console.error("[admin-quality] a view could not be drawn:", error);
            const p = doc.createElement("p");
            p.className = "qv-note";
            p.dataset.word = "failed";
            p.textContent = await adminSentence("failed");
            container.replaceChildren(p);
          }),
        );
      }
    }
    await Promise.all(work);
  }

  select?.addEventListener("change", () => {
    current = show(select.value);
  });
  void client().warm();
  const first = select?.value || root.dataset.recording || "";
  current = first ? show(first) : say(null);

  return {
    ready: async () => {
      await current;
    },
    show: (recording) => {
      current = show(recording);
      return current;
    },
    destroy() {
      controller.abort();
      dropFields();
    },
  };
}
