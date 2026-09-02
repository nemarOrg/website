/**
 * After #76's pivot to canonical sources, this file only houses the
 * filename-classification helper used by the dir-listing renderer to attach
 * `JSON` / `EEG` / `TSV` / `README` tags. Tree-building from manifest /
 * summary.paths went away with the partial-endpoint pipeline; the JSON
 * directory listings now carry per-file sizes natively so we never
 * reconstruct trees client-side either.
 */

export interface FileClassification {
  isEEG: boolean;
  isTSV: boolean;
  isJSON: boolean;
  isReadme: boolean;
  ext: string;
}

/**
 * BIDS-aware classification used to decide which UI affordances to attach
 * (the per-row badges in the file tree).
 */
export function classifyFile(filename: string): FileClassification {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot === -1 ? "" : lower.slice(dot + 1);
  return {
    isEEG: ext === "set" || ext === "edf" || ext === "bdf" || ext === "vhdr" || ext === "fif",
    isTSV: ext === "tsv",
    isJSON: ext === "json",
    isReadme: /^readme(\.md|\.txt)?$/i.test(filename),
    ext,
  };
}

/**
 * Directory-keyed signal recordings (website#252). A MEF3 iEEG recording is a
 * DIRECTORY (`..._ieeg.mefd/`), as is a CTF MEG recording (`..._meg.ds/`), so
 * `classifyFile` never sees them; the dir-row renderer asks this instead.
 * 4D/BTi directory recordings carry no extension at all and are recognized at
 * annotate time from the zarr index (mirroring the producer's content-keyed
 * detection in nemar-cli's `generate_zarr.py`), not here. Returns the
 * lowercase extension or null for an ordinary directory. A bare `.mefd`/`.ds`
 * (no stem) is not a recording name and returns null.
 */
export function signalDirExt(dirname: string): "mefd" | "ds" | null {
  const m = /^(.+)\.(mefd|ds)$/.exec(dirname.toLowerCase());
  return m ? (m[2] as "mefd" | "ds") : null;
}

/**
 * True when a recording named by the Zarr index is a DIRECTORY rather than a
 * single file (website#252), decided from the name alone.
 *
 * Asked by callers that have a recording path but no tree row to read
 * `data-dir-recording` off — the viewer's recording navigation (website#253)
 * can reach a recording in a directory the tree never rendered. It is the
 * complement of `classifyFile().isEEG` rather than `signalDirExt() !== null`
 * on purpose: that covers `.mefd`/`.ds` AND the extensionless 4D/BTi case,
 * which has no name-derived marker at all. Safe as a complement only because
 * every path it is asked about came from the index, which lists recordings
 * and nothing else.
 */
export function isDirRecordingName(name: string): boolean {
  return !classifyFile(name).isEEG;
}

/**
 * Stable DOM id for a recording's row in the file tree, keyed by its BIDS
 * path (website#277 decision 2 — the coverage panel links a failed/pending
 * recording to its row here). `render-dir-listing.ts` stamps this onto every
 * file row and directory-recording row it renders (both the initial SSR-
 * triggered fetch and a later lazy-loaded subdirectory); the client script's
 * `upgradeDirRecordingRow` (a BTi directory recognized only after the Zarr
 * index resolves) stamps the same id for parity, so a row is addressable
 * regardless of which path built it.
 *
 * `_` is escaped too (to `_5f`), not left alone: `_` doubles as the escape
 * marker for every OTHER disallowed character (`.` -> `_2e`, `/` -> `_2f`,
 * ...), so leaving a literal `_` unescaped makes the scheme ambiguous --
 * `"a_2e"` and `"a."` collided on the same id before this (PR #278 review).
 * Escaping `_` itself means `_` never appears in the output except as part
 * of a `_XX` escape sequence, which keeps the mapping injective.
 *
 * Not a CSS-selector-safe id (BIDS paths contain `/`) — always resolve it
 * with `document.getElementById`, never `querySelector('#...')`.
 */
export function bidsRowId(path: string): string {
  return `rec-${path.replace(/[^A-Za-z0-9-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}`)}`;
}
