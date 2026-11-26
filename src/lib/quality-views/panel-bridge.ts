/**
 * What the dataset page tells its quality panel, and the one thing the panel asks of the page
 * (website phase W6, #588). Both import this module, so they share its state; it imports nothing,
 * so the page's own script carries a few hundred bytes for it.
 *
 * - The recording list is the signal viewer's: the paths of the dataset's Zarr index, in the
 *   visitor's navigation order (`orderedRecordings`), published once the index has loaded. The
 *   panel lists the recordings a quality record can name (`isQualityRecordingPath`), and its
 *   default recording, the one the idle preload warms, is the first of them.
 * - The Signal tab opens a recording in the page's signal viewer with the floor's decisions marked
 *   (`openSignal`), through the page's viewer session.
 * - The Activations tab reads a recording's serving copy at the address the page gives
 *   (`storeUrlOf`), with the viewer's own reader (website phase W7).
 */

export interface PanelRecording {
  /** The recording's path in the dataset, as the Zarr index lists it. */
  readonly path: string;
  /** Its file name, shown in the picker. */
  readonly name: string;
}

/** Marks the signal viewer draws over a recording: the floor's decisions over one window. */
export interface SignalMarks {
  /** The store's channel group the view names. */
  readonly group: string | null;
  /** Prepare the marks once the store's group is open: the view's checks, then the marks or the
   *  sentence the viewer shows in place of the traces. */
  readonly prepare: (store: {
    readonly labels: readonly string[];
    readonly samples: number;
    readonly rate: number;
  }) => Promise<
    | {
        readonly ok: true;
        readonly startS: number;
        readonly durationS: number;
        readonly badChannels: readonly string[];
        readonly segments: readonly { onset: number; duration: number; label: string }[];
        readonly note: string;
      }
    | { readonly ok: false; readonly sentence: string }
  >;
}

type Opener = (path: string, marks: SignalMarks) => Promise<boolean>;

/** One channel group of a recording's serving copy, as the Activations tab reads it
 *  (`activations.ts`; neuroschema `docs/views/ic-activity.md`, The store). */
export interface ServingStore {
  /** One entry per store row, in store order; null where the store states none. */
  readonly labels: readonly (string | null)[];
  readonly units: readonly (string | null)[];
  readonly scale: readonly number[];
  readonly offset: readonly number[];
  readonly rate: number;
  /** Samples per row. */
  readonly samples: number;
  /** The group's content digest as the serving copy publishes it; null until it publishes one
   *  (nemarOrg/nemar-cli#2343). */
  readonly published_sha256: string | null;
  /** The stored integers of `rows` over samples `[from, to)`, row after row in `rows`' order. */
  read(
    rows: readonly number[],
    from: number,
    to: number,
    signal: AbortSignal,
  ): Promise<ArrayLike<number>>;
}

let storeUrl: ((path: string) => string) | null = null;

/** The page: the address of a recording's serving copy, where its signal viewer reads it. */
export function registerStoreUrl(url: (path: string) => string): void {
  storeUrl = url;
}

/** The panel: that address, or null when the page has none (the Activations tab, W7). */
export const storeUrlOf = (path: string): string | null => (storeUrl ? storeUrl(path) : null);

let published: ((list: readonly PanelRecording[] | null) => void) | null = null;
let list: Promise<readonly PanelRecording[] | null> = new Promise((resolve) => {
  published = resolve;
});
let opener: Opener | null = null;

/** The page: the viewer's recordings, in its order, or null when the index could not be read. */
export function publishRecordings(recordings: readonly PanelRecording[] | null): void {
  if (published) {
    published(recordings);
    published = null;
  } else {
    list = Promise.resolve(recordings);
  }
}

/** The panel and the preload: the viewer's recordings, once the page has them. */
export const panelRecordings = (): Promise<readonly PanelRecording[] | null> => list;

/** The page: how a recording is opened in its signal viewer with marks. */
export function registerSignalOpener(open: Opener): void {
  opener = open;
}

/** The panel: open a recording in the page's signal viewer, marked; false when the page has no
 *  viewer to open it in. */
export function openSignal(path: string, marks: SignalMarks): Promise<boolean> {
  return opener ? opener(path, marks) : Promise.resolve(false);
}

/** The record the idle preload read for its recording, which the panel takes rather than ask
 *  again (an outcome of `quality-api.ts`'s `fetchRecord`, typed loosely to keep this file
 *  import-free). */
let held: { readonly path: string; readonly outcome: Promise<unknown> } | null = null;

export function holdRecord(
  record: { readonly path: string; readonly outcome: Promise<unknown> } | null,
): void {
  held = record;
}

export function heldRecord(path: string): Promise<unknown> | null {
  return held && held.path === path ? held.outcome : null;
}

/** Whether the idle preload has read a record (and so warmed the map worker). */
export const preloaded = (): boolean => held !== null;

/**
 * A recording's record for the panel: the idle preload's when it read one that settles the
 * question (`ok`, or `none`), otherwise `fresh()`. A preload that failed or was cancelled is not
 * final: it is forgotten, and the record asked for again.
 */
export async function recordFor<T extends { readonly kind: string }>(
  path: string,
  fresh: () => Promise<T>,
): Promise<T> {
  const pending = heldRecord(path) as Promise<T> | null;
  const kept = pending ? await pending.catch(() => null) : null;
  if (kept && (kept.kind === "ok" || kept.kind === "none")) return kept;
  if (pending && held?.outcome === pending) held = null;
  return fresh();
}
