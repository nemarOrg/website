/**
 * Typed client for `data.nemar.org/<id>/<v>/<path>/?format=json` — the JSON
 * directory-listing endpoint shipped in nemar-cli#636 (v0.8.37). Returns the
 * names + per-file sizes of every entry in a single directory; subdirectories
 * are lazy-loaded per click by hitting the same endpoint with a deeper path.
 *
 * This replaces the website's pre-#76 reconstruction of the file tree from
 * `summary.json` (which had no per-file sizes) and `manifest.json` (multi-MB
 * blob the summary fast-path was designed to avoid). The listing endpoint is
 * the right primary source: 14 KB per directory, real sizes, native lazy.
 *
 * CORS: data.nemar.org's Hono middleware allows `https://ww2.nemar.org`,
 * `https://app.nemar.org`, and `http://localhost:4321` (verified via
 * preflight 2026-05-27). Safe to fetch client-side.
 */

import { resolveDataBase } from "./data-base";

/** Discriminated by `kind` so TypeScript narrows inside `if (entry.kind === "file")`. */
export type DirListingEntry =
  | { kind: "file"; name: string; size: number }
  | { kind: "dir"; name: string };

export interface DirListing {
  dataset_id: string;
  version: string;
  /** "" for the version root, e.g. "sub-NDARAA947ZG5/eeg" for nested paths. */
  path: string;
  kind: "directory";
  children: DirListingEntry[];
}

export interface DirListingInit {
  signal?: AbortSignal;
  dataBase?: string;
}

/**
 * Build the URL for a directory listing fetch. Exported so tests can pin the
 * construction without driving fetch. `path` is the slash-separated path
 * relative to the version root; pass "" for the root listing. Internal
 * slashes are kept (we want `sub-01/eeg` to map to the nested directory),
 * but the path is percent-encoded segment-by-segment to survive odd names.
 */
export function dirListingUrl(
  datasetId: string,
  version: string,
  path: string,
  base?: string,
): string {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = trimmed.length === 0 ? [] : trimmed.split("/").map(encodeURIComponent);
  const suffix = segments.length === 0 ? "" : `${segments.join("/")}/`;
  const root = (base ?? resolveDataBase()).replace(/\/$/, "");
  return `${root}/${encodeURIComponent(datasetId)}/${encodeURIComponent(version)}/${suffix}?format=json`;
}

/**
 * Fetch a directory listing. Returns the parsed JSON on success, or `null`
 * on any failure. The caller's render path treats null as "show retry-prompt
 * error" — the same UX the old partial endpoint surfaced.
 *
 * Parse errors are logged at `console.error` because a 200 with non-JSON
 * body means the CLI worker's contract has drifted, not that the network
 * blipped — retrying never clears it and developers need to see it. The
 * outer catch (network / abort) stays silent because those are routine
 * transient failures the user can retry through. Pre-#76's `jsonFetch`
 * tagged these as a distinct `parse_error` outcome kind; we preserve the
 * same observability split inside this simpler null-or-value API.
 *
 * `Accept: application/json` is set explicitly so the upstream content
 * negotiation picks the JSON branch even if a future client somehow
 * arrives without the `?format=json` query string. Belt and suspenders.
 */
export async function fetchDirListing(
  datasetId: string,
  version: string,
  path: string,
  init: DirListingInit = {},
): Promise<DirListing | null> {
  const url = dirListingUrl(datasetId, version, path, init.dataBase);
  try {
    const res = await fetch(url, {
      signal: init.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    try {
      return (await res.json()) as DirListing;
    } catch (parseErr) {
      console.error(`[dir-listing] parse error for ${url} (likely CLI contract drift):`, parseErr);
      return null;
    }
  } catch {
    // Network error or AbortError. Both are routine transient failures; no
    // log so navigation-during-fetch doesn't spam the console.
    return null;
  }
}

/**
 * Compose the public download URL for a file inside the version tree. The
 * worker at data.nemar.org turns this into a 302 to a presigned S3 URL
 * (with Content-Disposition handling and the BIDS-shaped filename rewrite
 * tracked in nemar-cli#513). Pure URL construction, no fetch.
 */
export function fileDownloadUrl(
  datasetId: string,
  version: string,
  path: string,
  base?: string,
): string {
  const trimmed = path.replace(/^\/+/, "");
  const segments = trimmed.split("/").map(encodeURIComponent);
  const root = (base ?? resolveDataBase()).replace(/\/$/, "");
  return `${root}/${encodeURIComponent(datasetId)}/${encodeURIComponent(version)}/${segments.join("/")}`;
}
