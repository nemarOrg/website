import type { ZarrIndex } from "./zarr-index";

/**
 * Tells the Open Science Assistant (OSA) widget which dataset, if any, is on screen (OSA issue
 * #436, the three-icon launcher: chat, a notebook button, and HPC). The notebook button opens a
 * hosted JupyterLite notebook for the dataset on screen, but only when that dataset has a Zarr
 * copy; the widget has no view into this site's own routing, so the dataset page is the one
 * thing that can tell it.
 *
 * `announceOsaDataset` is the one function that does the telling: it records the latest value on
 * `window[OSA_DATASET_WINDOW_PROPERTY]` and, if the widget has already loaded and exposes
 * `setDataset` (feature-detected: today's pinned widget build does not have one), calls it
 * immediately with the same value.
 *
 * The widget's `<script>` and the dataset page's own inline script are two independently loading
 * tags with no ordering guarantee between them. If the widget loads first, its `onload` handler
 * runs before the page has announced anything; if the page's script runs first, `setDataset`
 * does not exist yet to call. Recording the value on `window` closes that gap from this side:
 * `renderOsaWidgetScript` (`./osa-widget.ts`) closes it from the other side, by having its
 * generated `onload` handler read `window[OSA_DATASET_WINDOW_PROPERTY]` itself and replay it into
 * `setDataset` before calling `.init()`. Whichever script runs first, the widget ends up with the
 * latest announced value either way.
 *
 * `value` is `null` (not a dataset page) or `{ id, zarr, subject, task }`, `id` matching
 * {@link OSA_DATASET_ID_PATTERN}, `zarr` `true`/`false`/absent (not yet known), and `subject` and
 * `task` optional BIDS labels ({@link OSA_BIDS_LABEL_PATTERN}) that fill the widget's dataset-page
 * questions (OSA #477; see {@link osaDatasetFacts}). No page on
 * this site calls this with `null` today: only the dataset page calls this at all, and every
 * other page leaves the widget at its own "not a dataset page" default by never calling it.
 *
 * Invalid input -- a malformed id, a non-boolean `zarr`, or a value that is neither `null` nor
 * an `{id, zarr?, subject?, task?}` object -- is dropped with a `console.warn` rather than
 * recorded or forwarded, the same degrade-not-throw posture `resolveOsaWidget` takes for a bad
 * `PUBLIC_OSA_*` value. A `subject` or `task` that is not a label is dropped alone and the rest
 * is announced, as the widget's own `setDataset` does (OSA #477): the two only fill question
 * blanks, and refusing the whole value would leave the notebook button waiting on `zarr`.
 */

/**
 * The one property this module writes on `window`. Exported so `renderOsaWidgetScript`'s
 * generated `onload` handler reads the exact same key rather than a string literal duplicated in
 * two files, and so tests can assert on it the same way.
 */
export const OSA_DATASET_WINDOW_PROPERTY = "__nemarOsaDataset";

/** The id shape the widget's `setDataset` contract requires. */
const OSA_DATASET_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** A BIDS label, as the widget's `setDataset` takes `subject` and `task`: no prefix. */
const OSA_BIDS_LABEL_PATTERN = /^[A-Za-z0-9]{1,64}$/;

export interface OsaDatasetValue {
  id: string;
  /** `true`/`false` once the page knows whether this dataset has a Zarr copy; absent while that
   *  is still being determined (the index fetch is in flight). */
  zarr?: boolean;
  /** The subject label of the recording the page points a reader at first (`001` for `sub-001`). */
  subject?: string;
  /** That recording's task label (`N170` for `task-N170`). */
  task?: string;
}

/** `null` means "not a dataset page"; see the module doc for why nothing here ever passes it. */
export type OsaDatasetAnnouncement = OsaDatasetValue | null;

/** `value` without a `subject` or `task` that is not a plain label, each dropped with a warning. */
function withoutInvalidLabels(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const fact of ["subject", "task"] as const) {
    const label = copy[fact];
    if (label !== undefined && (typeof label !== "string" || !OSA_BIDS_LABEL_PATTERN.test(label))) {
      console.warn(`[osa-dataset] dropping an invalid ${fact} label: ${JSON.stringify(label)}`);
      delete copy[fact];
    }
  }
  return copy;
}

function isValidOsaDatasetAnnouncement(value: unknown): value is OsaDatasetAnnouncement {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !OSA_DATASET_ID_PATTERN.test(candidate.id)) {
    return false;
  }
  if (candidate.zarr !== undefined && typeof candidate.zarr !== "boolean") return false;
  for (const fact of ["subject", "task"] as const) {
    const label = candidate[fact];
    if (label !== undefined && (typeof label !== "string" || !OSA_BIDS_LABEL_PATTERN.test(label))) {
      return false;
    }
  }
  return true;
}

/**
 * Records `value` on `window` and forwards it to the widget's `setDataset` when the widget has
 * already loaded and exposes one. Call this from the dataset page as soon as the dataset id is
 * known, and again whenever the Zarr answer changes.
 *
 * A no-op outside a browser (`typeof window === "undefined"`) -- the same *kind* of existence
 * guard `resolveOsaWidget`'s `envValue` uses for `import.meta.env` (a different global, checked
 * for a different reason), not the same guard. This module is imported by a page script that
 * only ever runs client-side, but a no-op rather than a throw costs nothing and matches the rest
 * of this codebase's degrade posture.
 *
 * The call into `setDataset` is wrapped in its own try/catch: this function runs as the FIRST
 * statement of `hydrateTree` (`src/pages/dataset/[id].astro`), before any `await`, so an
 * exception thrown by a third party's widget code would otherwise propagate out of
 * `announceOsaDataset` and abort the file tree's hydration entirely -- `aria-busy` stuck set,
 * no listing ever fetched -- over a failure in a component this page does not own. A widget bug
 * must not take down dataset browsing.
 */
export function announceOsaDataset(announced: unknown): void {
  const value = withoutInvalidLabels(announced);
  if (!isValidOsaDatasetAnnouncement(value)) {
    console.warn(`[osa-dataset] ignoring invalid dataset announcement: ${JSON.stringify(value)}`);
    return;
  }
  if (typeof window === "undefined") return;
  const target = window as unknown as Record<string, unknown> & {
    OSAChatWidget?: { setDataset?: unknown };
  };
  target[OSA_DATASET_WINDOW_PROPERTY] = value;
  const setDataset = target.OSAChatWidget?.setDataset;
  if (typeof setDataset === "function") {
    try {
      (setDataset as (v: OsaDatasetAnnouncement) => void)(value);
    } catch (err) {
      console.warn("[osa-dataset] widget's setDataset threw:", err);
    }
  }
}

/**
 * The `subject` and `task` to announce with a dataset that has a Zarr copy: the BIDS entities of
 * the first recording in its Zarr index, the one the page points a reader at first. They fill the
 * OSA widget's dataset-page questions ("Plot 10 seconds of sub-001's N170 recording from
 * nm000132"), so they must name a recording that has a Zarr copy, which is why they come from the
 * index and not from the dataset's metadata. An entity the file name does not carry, or one that
 * is not a plain label, is left out rather than guessed; the widget then skips the questions that
 * need it.
 */
export function osaDatasetFacts(
  index: ZarrIndex | null,
): Pick<OsaDatasetValue, "subject" | "task"> {
  const first = index?.stores[0]?.path;
  if (!first) return {};
  const fileName = first.split("/").pop() ?? "";
  const facts: Pick<OsaDatasetValue, "subject" | "task"> = {};
  const subject = /(?:^|_)sub-([^_]+)/.exec(fileName)?.[1];
  const task = /(?:^|_)task-([^_]+)/.exec(fileName)?.[1];
  if (subject && OSA_BIDS_LABEL_PATTERN.test(subject)) facts.subject = subject;
  if (task && OSA_BIDS_LABEL_PATTERN.test(task)) facts.task = task;
  return facts;
}
