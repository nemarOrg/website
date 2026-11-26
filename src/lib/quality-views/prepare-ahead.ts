/**
 * Preload what the first screen of a recording's quality views needs, in idle time, before their
 * panel opens (the owner's rulings on #594: prepare at page load underneath the page's own work,
 * and no more than the first couple of windows). Phase W6 calls `prepareAhead` from
 * `requestIdleCallback` on the dataset page, naming exactly the views drawn on first open, so the
 * panel opened afterwards only draws:
 *
 * - `warm`: start the shared map worker and compile its loops (`SensorFieldClient.warm`);
 * - `layout`: fetch and check a scalp map's layout file, read it, and build its geometry in the
 *   worker (`prepare` on `warmInput`'s rows), keyed by the layout's SHA-256 as the draw is;
 * - `files`: fetch the first windows' view files and check each against its declared size and
 *   SHA-256, kept for the panel's `buildModel` (`preloadedSource`), so it does not fetch them again.
 *
 * Everything else (other recordings, later windows, maps off screen) loads when it is asked for.
 * Bounded and quiet: a byte cap (`maxBytes`, which W6 sets from the files it names), an
 * `AbortSignal` that stops it between steps and cancels its fetches (low priority, so they do not
 * compete with the viewer's), and no preload on a data-saving or slow connection (`shouldPreload`).
 * It never throws and never shows anything: a step that fails leaves nothing behind, and the panel
 * does that work when it opens, as it would anyway. It is idempotent: a file or a layout already
 * fetched or prepared, or on its way, is not fetched or prepared again.
 *
 * W6 owns the trigger and its gate ("panel opened after page load"); nothing here is wired to a
 * page.
 */

import type { FileDecl, FileSource, ViewDecl } from "./model";
import { subtleSha256, warmInput } from "./model";
import { readTsv } from "./read";
import {
  type PrepareOutcome,
  type SensorFieldClient,
  sharedSensorFieldClient,
} from "./worker-client";

/** A file to preload: where it is served, and what the view declares of it. */
export interface PreloadFile extends FileDecl {
  readonly url: string;
}

export interface PrepareAheadInput {
  /** Warm the map worker. */
  readonly warm?: boolean;
  /** A scalp map whose geometry to prepare: its view and its layout file. */
  readonly layout?: { readonly view: ViewDecl; readonly file: PreloadFile };
  /** The first windows' view files to fetch and check, in order, within `maxBytes`. */
  readonly files?: readonly PreloadFile[];
  /** The most bytes this call fetches; a file that would pass it is left for the panel. */
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface PrepareAheadOptions {
  /** The client to warm and prepare in; the page's shared one by default. */
  readonly client?: SensorFieldClient;
  /** Fetch a file's bytes, null when it is not there; a low-priority `fetch` by default. */
  readonly fetchBytes?: (url: string, signal?: AbortSignal) => Promise<Uint8Array | null>;
}

export type Skipped = { readonly kind: "skipped"; readonly reason: string };

export interface PrepareAheadOutcome {
  /** Whether a warm-up was started (it runs on; a panel's draw cancels what is left of it). */
  readonly warm: "started" | null;
  readonly layout: PrepareOutcome | Skipped | null;
  /** Each file's outcome by SHA-256: preloaded, or why not. */
  readonly files: ReadonlyMap<string, "preloaded" | Skipped>;
}

/** Whether the connection allows a preload: not on data saving, not on a 2G-class link. */
export function shouldPreload(nav: unknown = globalThis.navigator): boolean {
  const connection = (nav as { connection?: { saveData?: boolean; effectiveType?: string } })
    ?.connection;
  if (!connection) return true;
  if (connection.saveData) return false;
  return !["slow-2g", "2g"].includes(connection.effectiveType ?? "");
}

async function defaultFetch(url: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  const response = await fetch(url, { signal, priority: "low" } as RequestInit);
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
}

/** Checked bytes by SHA-256, and the layouts prepared per client: shared by every call. */
const checked = new Map<string, Promise<Uint8Array | null>>();
const prepared = new WeakMap<SensorFieldClient, Map<string, Promise<PrepareOutcome | Skipped>>>();

const skipped = (reason: string): Skipped => ({ kind: "skipped", reason });
const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The bytes of `file`, checked against its size and SHA-256 once per page, or null. */
function checkedBytes(
  file: PreloadFile,
  fetchBytes: NonNullable<PrepareAheadOptions["fetchBytes"]>,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const held = checked.get(file.sha256);
  if (held) return held;
  const pending = (async () => {
    const bytes = await fetchBytes(file.url, signal);
    if (!bytes || bytes.length !== file.size) return null;
    return (await subtleSha256(bytes)) === file.sha256 ? bytes : null;
  })();
  checked.set(file.sha256, pending);
  // A failed or cancelled fetch is forgotten, so the panel or a later preload can try again.
  pending.then(
    (bytes) => {
      if (!bytes && checked.get(file.sha256) === pending) checked.delete(file.sha256);
    },
    () => {
      if (checked.get(file.sha256) === pending) checked.delete(file.sha256);
    },
  );
  return pending;
}

export async function prepareAhead(
  input: PrepareAheadInput,
  options: PrepareAheadOptions = {},
): Promise<PrepareAheadOutcome> {
  const files = new Map<string, "preloaded" | Skipped>();
  let warm: PrepareAheadOutcome["warm"] = null;
  let layout: PrepareAheadOutcome["layout"] = null;
  const { signal } = input;
  const stopped = (): boolean => signal?.aborted === true;
  const fetchBytes = options.fetchBytes ?? defaultFetch;
  const client = (): SensorFieldClient => options.client ?? sharedSensorFieldClient();
  let budget = input.maxBytes ?? Number.POSITIVE_INFINITY;
  const spend = (file: PreloadFile): boolean => {
    if (checked.has(file.sha256)) return true;
    if (file.size > budget) return false;
    budget -= file.size;
    return true;
  };

  if (input.warm && !stopped()) {
    // Not awaited: the worker warms while the files download, and a panel's draw cancels it.
    void client().warm();
    warm = "started";
  }
  if (input.layout && !stopped()) {
    const { view, file } = input.layout;
    const byClient = prepared.get(client()) ?? new Map<string, Promise<PrepareOutcome | Skipped>>();
    prepared.set(client(), byClient);
    let pending = byClient.get(file.sha256);
    if (!pending) {
      if (!spend(file)) {
        pending = Promise.resolve(skipped("over the preload's byte cap"));
      } else {
        pending = (async (): Promise<PrepareOutcome | Skipped> => {
          const bytes = await checkedBytes(file, fetchBytes, signal);
          if (!bytes) return skipped("the layout file is not there or not the one recorded");
          if (stopped()) return skipped("cancelled");
          const places = warmInput(view, readTsv(bytes));
          if (!places) return skipped("the layout places no sensor of this view");
          return client().prepare({ layoutKey: file.sha256, ...places });
        })().catch((error: unknown) => skipped(reasonOf(error)));
        byClient.set(file.sha256, pending);
        void pending.then((result) => {
          if (result.kind !== "prepared") byClient.delete(file.sha256);
        });
      }
    }
    layout = await pending;
  }
  for (const file of input.files ?? []) {
    if (stopped()) {
      files.set(file.sha256, skipped("cancelled"));
      continue;
    }
    if (!spend(file)) {
      files.set(file.sha256, skipped("over the preload's byte cap"));
      continue;
    }
    try {
      const bytes = await checkedBytes(file, fetchBytes, signal);
      files.set(file.sha256, bytes ? "preloaded" : skipped("not there or not the one recorded"));
    } catch (error) {
      files.set(file.sha256, skipped(reasonOf(error)));
    }
  }
  return { warm, layout, files };
}

/** A file source that serves preloaded bytes, and fetches any other file with `fallback`. */
export function preloadedSource(fallback: FileSource): FileSource {
  return async (file) => {
    const held = checked.get(file.sha256);
    const bytes = held ? await held.catch(() => null) : null;
    return bytes ?? fallback(file);
  };
}

/** Forget every preloaded file (a page that leaves the dataset; the tests). */
export function forgetPreloads(): void {
  checked.clear();
}
