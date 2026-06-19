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
