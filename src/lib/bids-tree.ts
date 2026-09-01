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
