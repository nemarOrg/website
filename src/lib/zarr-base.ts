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
 * the default (a build-time var, inlined by Vite; set in `wrangler.toml`'s
 * `[vars]` for parity and to the `-test` host by the staging build). The viewer
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
 * Sanitize a producer-supplied conversion stamp into a cache-busting token.
 * The stamp is `index.json`'s `updated_utc`, an ISO instant. Its `:` would in
 * fact be legal unescaped in a query value, but the token is only ever compared
 * for *difference*, never parsed back — so reducing it to an unambiguous
 * `[A-Za-z0-9._-]` alphabet costs nothing and keeps the URL free of anything a
 * proxy, log scraper, or cache-key normalizer might rewrite. The length cap
 * bounds the URL against a malformed index. Returns "" for a missing or
 * fully-stripped stamp; callers treat that as "no token" and emit no `?v=`.
 */
export function zarrCacheToken(stamp: string | null | undefined): string {
  if (typeof stamp !== "string") return "";
  return stamp.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
}

/**
 * Full URL of a recording's Zarr store (trailing slash so zarrita's FetchStore
 * resolves `zarr.json` and chunk keys against it correctly).
 *
 * `token` busts stale chunks after a re-conversion (#240). A `--clean` rebuild
 * rewrites chunk bytes at UNCHANGED URLs, while the serving layer gives chunks a
 * far longer TTL than the metadata beside them and purges only the metadata. A
 * browser warm from the previous TTL window therefore pairs fresh metadata (new
 * channel count, new per-channel scale/offset) with pre-rebuild chunk bytes and
 * renders garbage. zarrita's `FetchStore.resolve()` copies `base.search` onto
 * every resolved key, so putting the token here propagates it to `zarr.json` AND
 * every chunk without touching reader code. The Worker derives its S3 key from
 * the path alone and keys its edge cache on the full URL, so the param is inert
 * upstream and busts the edge too.
 *
 * (The exact TTLs and purge scope live in `nemar-cli`'s `zarr-data.ts`
 * `cacheControlFor()` and `cloudflare.ts` `zarrPurgeTargets()`; deliberately not
 * restated here, since nothing keeps a copy of those numbers honest.)
 */
export function zarrStoreUrl(
  datasetId: string,
  bidsPath: string,
  opts: { token?: string; base?: string } = {},
): string {
  const base = opts.base ?? zarrBase();
  const url = `${base}/${encodeURIComponent(datasetId)}/zarr/${storeRelPath(bidsPath)}/`;
  const token = zarrCacheToken(opts.token);
  return token ? `${url}?v=${token}` : url;
}

/**
 * Resolve a store-relative key (`zarr.json`, `eeg_250hz/0/zarr.json`, ...)
 * against a store URL, carrying the cache-busting query across. This mirrors
 * what zarrita's `FetchStore.resolve` does internally, and exists because
 * `zarrStoreUrl` may now end in `?v=...`: naive `storeUrl + key` concatenation
 * would splice the key onto the query string instead of the path.
 */
export function zarrKeyUrl(storeUrl: string, key: string): string {
  const base = new URL(storeUrl);
  // Match zarrita's own `resolve`: without a trailing slash the last path
  // segment is the "file" and `new URL` would replace it instead of descending
  // into it. Every current caller passes a `zarrStoreUrl` (always slash-
  // terminated), so this only guards reuse.
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const resolved = new URL(key, base);
  resolved.search = base.search;
  return resolved.toString();
}

/** URL of a dataset's `index.json` store manifest (the recording list). */
export function zarrIndexUrl(datasetId: string, base = zarrBase()): string {
  return `${base}/${encodeURIComponent(datasetId)}/zarr/index.json`;
}
