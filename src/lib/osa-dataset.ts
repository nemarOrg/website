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
 * `value` is `null` (not a dataset page) or `{ id, zarr }`, `id` matching
 * {@link OSA_DATASET_ID_PATTERN} and `zarr` `true`/`false`/absent (not yet known). No page on
 * this site calls this with `null` today: only the dataset page calls this at all, and every
 * other page leaves the widget at its own "not a dataset page" default by never calling it.
 *
 * Invalid input -- a malformed id, a non-boolean `zarr`, or a value that is neither `null` nor an
 * `{id, zarr?}` object -- is dropped with a `console.warn` rather than recorded or forwarded, the
 * same degrade-not-throw posture `resolveOsaWidget` takes for a bad `PUBLIC_OSA_*` value.
 */

/**
 * The one property this module writes on `window`. Exported so `renderOsaWidgetScript`'s
 * generated `onload` handler reads the exact same key rather than a string literal duplicated in
 * two files, and so tests can assert on it the same way.
 */
export const OSA_DATASET_WINDOW_PROPERTY = "__nemarOsaDataset";

/** The id shape the widget's `setDataset` contract requires. */
const OSA_DATASET_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface OsaDatasetValue {
  id: string;
  /** `true`/`false` once the page knows whether this dataset has a Zarr copy; absent while that
   *  is still being determined (the index fetch is in flight). */
  zarr?: boolean;
}

/** `null` means "not a dataset page"; see the module doc for why nothing here ever passes it. */
export type OsaDatasetAnnouncement = OsaDatasetValue | null;

function isValidOsaDatasetAnnouncement(value: unknown): value is OsaDatasetAnnouncement {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !OSA_DATASET_ID_PATTERN.test(candidate.id)) {
    return false;
  }
  if (candidate.zarr !== undefined && typeof candidate.zarr !== "boolean") return false;
  return true;
}

/**
 * Records `value` on `window` and forwards it to the widget's `setDataset` when the widget has
 * already loaded and exposes one. Call this from the dataset page as soon as the dataset id is
 * known, and again whenever the Zarr answer changes.
 *
 * A no-op outside a browser (`typeof window === "undefined"`), the same guard `resolveOsaWidget`'s
 * `envValue` uses for `import.meta.env` -- this module is imported by a page script that only
 * ever runs client-side, but a no-op rather than a throw costs nothing and matches the rest of
 * this codebase's degrade posture.
 */
export function announceOsaDataset(value: unknown): void {
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
    (setDataset as (v: OsaDatasetAnnouncement) => void)(value);
  }
}
