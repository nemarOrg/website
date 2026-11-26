/**
 * The dataset page's idle preload of its quality panel (the owner's rulings of 2026-11-25 on
 * #594: prepare at page load, in idle time, only the default recording's first couple of
 * windows). When the page has loaded, the connection allows it (`shouldPreload`), the viewer's
 * recording list is in and the browser is idle, it:
 *
 * 1. reads the default recording's quality record at low priority (kept for the panel, which then
 *    does not ask again);
 * 2. calls `prepareAhead` with the scope `preloadPlan` gives: the map worker warmed, the layout
 *    fetched, checked and its geometry prepared, and the files of the first windows' views (the
 *    Spectrum tab's and the Components tab's, whose maps are the first batch drawn), each checked
 *    against its size and SHA-256, under a cap of exactly those files' bytes.
 *
 * Everything else (other recordings, other tabs, later maps) loads when it is asked for. It never
 * competes with the viewer: it starts after the page's load event and the viewer's index, skips a
 * page whose viewer is open, and fetches at low priority. Leaving the page aborts it and forgets
 * what it fetched (`forgetPreloads`). It shows nothing and never throws: a failure leaves nothing
 * behind, and the panel does the work when it opens.
 */

import type { FileDecl, ViewDecl } from "./model";
import { type PanelRecording, panelRecordings } from "./panel-bridge";
import { holdRecord } from "./panel-bridge";
import { type TabId, qualityRecordings, tabOf } from "./panel-model";
import {
  type PreloadFile,
  type PrepareAheadInput,
  type PrepareAheadOptions,
  type PrepareAheadOutcome,
  forgetPreloads,
  prepareAhead,
  readLimited,
  shouldPreload,
} from "./prepare-ahead";
import { fetchRecord } from "./quality-api";
import { fileUrl } from "./quality-files";
import type { QualityRecord } from "./record";
import type { SensorFieldClient } from "./worker-client";

export interface PreloadTarget {
  readonly base: string;
  readonly datasetId: string;
  readonly recipe: string;
}

export interface PreloadDeps {
  /** Resolves once the page has loaded (its `load` event). */
  readonly loaded?: Promise<void>;
  /** Runs `run` when the browser is idle (`requestIdleCallback`, else a short timer). */
  readonly idle?: (run: () => void) => void;
  readonly recordings?: () => Promise<readonly PanelRecording[] | null>;
  /** Whether the page's signal viewer is open now. */
  readonly viewerOpen?: () => boolean;
  /** Calls `leave` when the visitor leaves the page. */
  readonly onLeave?: (leave: () => void) => void;
  readonly navigator?: unknown;
  readonly fetch?: typeof fetch;
  readonly client?: SensorFieldClient;
}

/** The panel's first windows: the tabs drawn on first open and the next one, whose scalp maps are
 *  the first batch a panel draws (the owner's ruling: the first couple of windows, first-screen
 *  views and the first map batch). */
export const PRELOAD_TABS: readonly TabId[] = ["spectrum", "components"];

export interface PreloadPlan {
  readonly layout: { readonly view: ViewDecl; readonly file: PreloadFile } | null;
  readonly files: readonly PreloadFile[];
  /** The bytes of exactly these files: the cap follows the scope. */
  readonly maxBytes: number;
}

/** A view whose scalp maps are placed by a layout role, with that layout's file. */
function layoutOf(view: ViewDecl): FileDecl | null {
  const values = view.data?.find((d) => d.role === "values");
  const sensor = values?.dims?.find((d) => d.name === "sensor");
  if (!sensor || !("role" in sensor.coords) || sensor.coords.role !== "layout") return null;
  return view.data?.find((d) => d.role === "layout") ?? null;
}

/** What the idle preload fetches of a record: the layout of the first window that places maps by
 *  one, and every data file of the first windows' views, each once, the default tab's first. */
export function preloadPlan(record: QualityRecord, url: (file: FileDecl) => string): PreloadPlan {
  const views = record.views as unknown as ViewDecl[];
  const first = PRELOAD_TABS.flatMap((tab) => views.filter((v) => tabOf(v.kind) === tab));
  let layout: PreloadPlan["layout"] = null;
  for (const view of first) {
    const file = layoutOf(view);
    if (file) {
      layout = { view, file: { ...pick(file), url: url(file) } };
      break;
    }
  }
  const seen = new Set<string>(layout ? [layout.file.sha256] : []);
  const files: PreloadFile[] = [];
  for (const view of first) {
    for (const entry of view.data ?? []) {
      if (seen.has(entry.sha256)) continue;
      seen.add(entry.sha256);
      files.push({ ...pick(entry), url: url(entry) });
    }
  }
  const maxBytes = files.reduce((sum, f) => sum + f.size, layout?.file.size ?? 0);
  return { layout, files, maxBytes };
}

const pick = (f: FileDecl): FileDecl => ({ location: f.location, size: f.size, sha256: f.sha256 });

export type PreloadRun =
  | { readonly kind: "skipped"; readonly reason: string }
  | {
      readonly kind: "ran";
      readonly recording: string;
      readonly outcome: PrepareAheadOutcome | null;
    };

const browserIdle = (run: () => void): void => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
    .requestIdleCallback;
  if (ric) ric(run);
  else setTimeout(run, 500);
};

const pageLoaded = (): Promise<void> =>
  document.readyState === "complete"
    ? Promise.resolve()
    : new Promise((resolve) => addEventListener("load", () => resolve(), { once: true }));

/** What `prepareAhead` is asked for: warm the worker, prepare the plan's layout, fetch its files,
 *  under a cap of exactly their bytes. */
export function preloadInput(plan: PreloadPlan, signal?: AbortSignal): PrepareAheadInput {
  return {
    warm: true,
    layout: plan.layout ?? undefined,
    files: plan.files,
    maxBytes: plan.maxBytes,
    signal,
  };
}

function preloadOptions(deps: PreloadDeps): PrepareAheadOptions {
  const own = deps.fetch;
  return {
    ...(deps.client ? { client: deps.client } : {}),
    ...(own
      ? {
          fetchBytes: async (url: string, signal?: AbortSignal, limit?: number) =>
            readLimited(await own(url, { signal, priority: "low" } as RequestInit), limit),
        }
      : {}),
  };
}

/** Start the idle preload. Resolves with what it did; never rejects. `cancel` stops it. */
export function startIdlePreload(
  target: PreloadTarget,
  deps: PreloadDeps = {},
): { readonly done: Promise<PreloadRun>; readonly cancel: () => void } {
  const controller = new AbortController();
  const { signal } = controller;
  const leave = (): void => {
    controller.abort();
    forgetPreloads();
    holdRecord(null);
  };
  (deps.onLeave ?? ((go) => addEventListener("pagehide", go, { once: true })))(leave);
  const done = (async (): Promise<PreloadRun> => {
    if (!shouldPreload(deps.navigator ?? globalThis.navigator)) {
      return { kind: "skipped", reason: "connection" };
    }
    await (deps.loaded ?? pageLoaded());
    const list = await (deps.recordings ?? panelRecordings)();
    const first = qualityRecordings(list ?? [])[0];
    if (!first) return { kind: "skipped", reason: "no recording" };
    await new Promise<void>((resolve) => (deps.idle ?? browserIdle)(resolve));
    if (signal.aborted) return { kind: "skipped", reason: "cancelled" };
    const viewerOpen = deps.viewerOpen ?? (() => document.querySelector(".eegv") !== null);
    if (viewerOpen()) return { kind: "skipped", reason: "viewer open" };
    const ask = { ...target, recording: first.path };
    const outcome = fetchRecord(ask, { signal, priority: "low", fetch: deps.fetch });
    holdRecord({ path: first.path, outcome });
    const read = await outcome;
    if (read.kind !== "ok" || signal.aborted) {
      return { kind: "ran", recording: first.path, outcome: null };
    }
    const plan = preloadPlan(read.record, (file) => fileUrl(target.base, read.record, file));
    const prepared = await prepareAhead(preloadInput(plan, signal), preloadOptions(deps));
    return { kind: "ran", recording: first.path, outcome: prepared };
  })().catch((): PreloadRun => {
    // An abort or any fault: nothing is shown and nothing is kept; the panel does the work.
    if (signal.aborted) holdRecord(null);
    return { kind: "skipped", reason: signal.aborted ? "cancelled" : "failed" };
  });
  return { done, cancel: leave };
}
