/**
 * Zarr serving-copy plumbing: base-URL resolution and the BIDS-path -> store-URL
 * mapping the signal viewer uses. The producer (epic nemarOrg/nemar-cli#684)
 * writes one Zarr v3 store per recording at
 * `s3://nemar/<id>/zarr/<bids-path-with-.zarr>/`, served by the CORS-gated
 * `zarr.nemar.org` Worker (browser gateway; CORS restricted to NEMAR origins).
 */

const DEFAULT_ZARR_BASE = "https://zarr.nemar.org";

/**
 * Resolve the zarr serving host at call time. `PUBLIC_ZARR_BASE_URL` overrides
 * the default (set via `.env` for local dev or the Cloudflare env for prod
 * overrides; not yet added to `wrangler.toml`). The viewer
 * is base-URL agnostic, so this can repoint to a different CDN or to direct S3
 * without touching reader code.
 */
export function zarrBase(): string {
  const fromEnv =
    (typeof import.meta.env !== "undefined" && import.meta.env.PUBLIC_ZARR_BASE_URL) || null;
  return (fromEnv ?? DEFAULT_ZARR_BASE).replace(/\/$/, "");
}

/**
 * Map a BIDS recording path to its store-relative Zarr path: strip the data
 * extension and append `.zarr`, mirroring the producer's `store_rel_for`
 * (`scripts/zarr/generate_zarr.py`). The BIDS suffix is preserved, so the rule
 * is uniform across `.set/.edf/.bdf/.vhdr/.fif`:
 *
 *   `sub-01/eeg/sub-01_task-rest_eeg.set` -> `sub-01/eeg/sub-01_task-rest_eeg.zarr`
 *
 * Path segments are plain BIDS ASCII (`sub-01`, `task-rest`, ...), so they are
 * not URL-encoded here; the slashes are significant.
 */
export function storeRelPath(bidsPath: string): string {
  const segments = bidsPath.split("/").filter(Boolean);
  const file = segments.pop() ?? "";
  const dot = file.lastIndexOf(".");
  const stem = dot <= 0 ? file : file.slice(0, dot);
  return [...segments, `${stem}.zarr`].join("/");
}

/**
 * Full URL of a recording's Zarr store (trailing slash so zarrita's FetchStore
 * resolves `zarr.json` and chunk keys against it correctly).
 */
export function zarrStoreUrl(datasetId: string, bidsPath: string, base = zarrBase()): string {
  return `${base}/${encodeURIComponent(datasetId)}/zarr/${storeRelPath(bidsPath)}/`;
}

/** URL of a dataset's `index.json` store manifest (the recording list). */
export function zarrIndexUrl(datasetId: string, base = zarrBase()): string {
  return `${base}/${encodeURIComponent(datasetId)}/zarr/index.json`;
}
