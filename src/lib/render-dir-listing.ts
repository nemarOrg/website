/**
 * Browser-side renderer for `DirListing` payloads. Mirrors the CSS class
 * shapes the old `render-tree.ts` emitted (`.tree__row`, `.tree__row--dir`,
 * `.tree__name`, `.tree__chevron`, etc.) so the existing global styles in
 * `BidsTree.astro` apply unchanged.
 *
 * No tree-building: each `DirListing` is naturally one level. Recursion
 * happens through user clicks + the native `<details>` toggle event,
 * fetched on-demand from `data.nemar.org/<id>/<v>/<path>/?format=json`.
 * Per-file sizes come straight from the listing entry — no synthesis.
 */

import { type FileClassification, classifyFile } from "./bids-tree";
import type { DirListing, DirListingEntry } from "./dir-listing";
import { fileDownloadUrl } from "./dir-listing";
import { formatBytes } from "./format";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Sort numerically (sub-2 before sub-10) so the rendered order matches
 *  what data.nemar.org's HTML view gives — keeps muscle memory consistent
 *  for users who navigate between the two surfaces. */
function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function sortChildren(children: DirListingEntry[]): DirListingEntry[] {
  return [...children].sort((a, b) => {
    // Files-after-dirs is the convention the old renderer used. Within
    // each kind, numeric-aware compare.
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return compareNames(a.name, b.name);
  });
}

/** Map a `FileClassification` to the `data-preview-type` token consumed
 *  by the inline-preview click delegate in `src/pages/dataset/[id].astro`.
 *  Returns null for files we don't know how to preview today (e.g.,
 *  CHANGES, .gitattributes, LICENSE) — those rows fall back to a plain
 *  name span + download icon. The `eeg` token wires the same click flow
 *  to the future visualizer; today it shows a "coming soon" stub. */
function previewTypeFor(
  filename: string,
  cls: FileClassification,
): "md" | "json" | "tsv" | "eeg" | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (cls.isReadme || ext === "md") return "md";
  if (cls.isJSON) return "json";
  if (cls.isTSV) return "tsv";
  if (cls.isEEG) return "eeg";
  return null;
}

const DOWNLOAD_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/>' +
  "</svg>";

function renderFileRow(
  entry: DirListingEntry & { kind: "file" },
  datasetId: string,
  version: string,
  parentPath: string,
  depth: number,
  isRoot: boolean,
): string {
  const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  const href = fileDownloadUrl(datasetId, version, fullPath);
  const cls = classifyFile(entry.name);
  const previewType = previewTypeFor(entry.name, cls);
  // Type narrowing on the discriminated union (`entry: DirListingEntry &
  // { kind: "file" }`) guarantees `entry.size` is a number — no runtime
  // guard needed. If the upstream ever ships a file entry without size we
  // want the type system to flag it, not a silent ""-render.
  const size = formatBytes(entry.size);
  // Root rows use the tree__list--root flat layout (no indent); nested rows
  // get inline padding scaled by depth, matching the old renderDirChildren.
  const indentStyle = isRoot
    ? ""
    : ` style="padding-inline-start: calc(var(--space-5) + ${depth} * var(--space-5) + 16px)"`;
  // The displayed name: root rows show the full path (single-level dataset
  // root); nested rows show just the basename.
  const displayName = esc(isRoot ? fullPath : entry.name);

  const row: string[] = [];
  row.push(`<div class="tree__row${isRoot ? "" : " tree__row--file"}"${indentStyle}>`);
  if (isRoot) {
    row.push(`<span class="tree__icon" aria-hidden="true">▪</span>`);
  }
  if (previewType) {
    // Clicking the name opens the inline preview; the document-level
    // click delegate fetches lazily on the first open. data-file-size
    // gates the 512 KB cap before the fetch runs.
    row.push(
      `<button class="tree__preview-btn" type="button" data-preview-path="${esc(fullPath)}" data-preview-type="${previewType}" data-file-size="${entry.size}" data-file-name="${esc(entry.name)}" aria-expanded="false" title="Preview ${esc(entry.name)}"><span class="tree__name">${displayName}</span></button>`,
    );
  } else {
    // No preview affordance for unknown formats — the name is a plain
    // label; only the download icon is interactive.
    row.push(`<span class="tree__name">${displayName}</span>`);
  }
  row.push(`<span class="tree__size">${esc(size)}</span>`);
  appendTags(row, cls, isRoot);
  row.push(
    `<a class="tree__dl" href="${esc(href)}" rel="external" download="${esc(entry.name)}" title="Download ${esc(entry.name)}" aria-label="Download ${esc(entry.name)}">${DOWNLOAD_ICON_SVG}</a>`,
  );
  row.push("</div>");

  // Wrap the row in an <li> that also carries the lazy preview slot for
  // the on-click expansion. The slot stays hidden until the user opens
  // the preview; once filled, data-loaded prevents re-fetches.
  return [
    `<li class="tree__file-wrap" data-preview-wrap>`,
    row.join(""),
    previewType
      ? `<div class="tree__preview" data-preview-slot hidden aria-live="polite"></div>`
      : "",
    "</li>",
  ].join("");
}

function appendTags(out: string[], cls: FileClassification, isRoot: boolean): void {
  if (cls.isReadme) out.push(`<span class="tree__tag">README</span>`);
  if (cls.isJSON) out.push(`<span class="tree__tag">JSON</span>`);
  // TSV gets a plain format badge (mirrors JSON): the inline table preview
  // shipped, so the row's click-to-preview button already works — the old
  // "View · soon" hint was stale. Nested-rows-only, like the EEG hint below,
  // so the root view stays calm (root rarely holds raw data files).
  if (!isRoot && cls.isTSV) out.push(`<span class="tree__tag">TSV</span>`);
  // EEG/MEG/iEEG/EMG recordings now open in the interactive Zarr signal viewer
  // (epic nemar-cli#684) -- a plain format badge like JSON/TSV, no "soon" hint.
  if (!isRoot && cls.isEEG)
    out.push(`<span class="tree__tag tree__tag--vis" title="Open the signal viewer">Vis</span>`);
}

function renderDirRow(
  entry: DirListingEntry & { kind: "dir" },
  parentPath: string,
  depth: number,
): string {
  const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  const indentStyle =
    depth === 0
      ? ""
      : ` style="padding-inline-start: calc(var(--space-5) + ${depth} * var(--space-5))"`;
  // Every directory is lazy. The `<details data-dir-path="...">` carries the
  // path the client toggle handler will fetch + render into the empty
  // `[data-dir-target]` slot. data-loaded guards against re-fetches on
  // subsequent collapse/expand cycles.
  return [
    "<li>",
    `<details class="tree__dir" data-dir-path="${esc(fullPath)}" data-depth="${depth}">`,
    `<summary class="tree__row tree__row--dir"${indentStyle}>`,
    `<svg class="tree__chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
    `<span class="tree__icon" aria-hidden="true">▸</span>`,
    `<span class="tree__name">${esc(entry.name)}/</span>`,
    "</summary>",
    `<div class="tree__lazy" data-dir-target></div>`,
    "</details></li>",
  ].join("");
}

/** Default cap on the number of top-level directory rows rendered on first
 *  paint. HBN-class datasets (on005509 = 330 subjects) flood the layout
 *  otherwise; most users only expand a handful. The remainder is revealed
 *  in same-size chunks via the "Show next N" button rendered by
 *  `renderShowMoreFooter`. */
export const DEFAULT_DIR_CHUNK_SIZE = 50;

export interface RenderTopLevelOptions {
  /** Override the default `DEFAULT_DIR_CHUNK_SIZE` cap. Used by tests and
   *  could be wired to a user preference later. */
  dirChunkSize?: number;
}

/** Footer rendered when the directory count exceeds the initial chunk.
 *  Carries the state the client-side click handler reads + updates: how
 *  many rows are visible now (`data-rendered`), the total available
 *  (`data-total`), and how many to reveal per click (`data-chunk`). */
function renderShowMoreFooter(rendered: number, total: number, chunkSize: number): string {
  const nextCount = Math.min(chunkSize, total - rendered);
  return [
    `<div class="tree__more" data-tree-more data-rendered="${rendered}" data-total="${total}" data-chunk="${chunkSize}">`,
    `<button class="tree__more-btn" type="button">`,
    `Show next ${nextCount} <span class="tree__more-counter">(${rendered} of ${total} shown)</span>`,
    "</button>",
    "</div>",
  ].join("");
}

/**
 * Render the entire `<section class="tree">` for a top-level directory
 * listing (path === ""). Files appear at the top in the flat `--root` list;
 * directories follow as collapsed lazy rows, capped at `dirChunkSize`. When
 * the cap trips, a "Show next N" footer is appended after the dir list and
 * the client script reveals subsequent chunks in place via
 * `renderDirChunkRows`.
 */
export function renderTopLevel(listing: DirListing, opts: RenderTopLevelOptions = {}): string {
  const chunkSize = opts.dirChunkSize ?? DEFAULT_DIR_CHUNK_SIZE;
  const sorted = sortChildren(listing.children);
  const files = sorted.filter((c): c is DirListingEntry & { kind: "file" } => c.kind === "file");
  const dirs = sorted.filter((c): c is DirListingEntry & { kind: "dir" } => c.kind === "dir");
  const totalBytes = files.reduce((acc, f) => acc + (f.size ?? 0), 0);
  const out: string[] = [];
  out.push(`<section class="tree" aria-label="Dataset file tree">`);
  out.push(`<header class="tree__head">`);
  out.push("<h2>Files</h2>");
  out.push(
    `<span class="tree__meta">${sorted.length} top-level entries · ${esc(formatBytes(totalBytes))} root total</span>`,
  );
  out.push("</header>");
  if (files.length > 0) {
    out.push(`<ul class="tree__list tree__list--root" role="list">`);
    for (const f of files)
      out.push(renderFileRow(f, listing.dataset_id, listing.version, "", 0, true));
    out.push("</ul>");
  }
  if (dirs.length > 0) {
    // aria-live="polite" so screen readers announce the chunk appended by
    // the "Show next N" click without preempting other speech. role="list"
    // stays explicit because the dir rows use <details>/<summary> markup
    // that some screen readers don't recognize as list items by default.
    out.push(`<ul class="tree__list" role="list" aria-live="polite" data-dir-list>`);
    const initialCount = Math.min(dirs.length, chunkSize);
    for (let i = 0; i < initialCount; i++) out.push(renderDirRow(dirs[i], "", 0));
    out.push("</ul>");
    if (dirs.length > chunkSize) {
      out.push(renderShowMoreFooter(initialCount, dirs.length, chunkSize));
    }
  }
  out.push("</section>");
  return out.join("");
}

/**
 * Emit dir rows for a slice of the already-fetched listing. The client
 * "Show next" handler calls this on each click; the function sorts
 * internally so the order matches what `renderTopLevel` emitted (numeric-
 * aware compare, dirs only). Returns the rendered count + total so the
 * caller can update the footer's running counter and decide when to
 * remove the footer entirely.
 */
export function renderDirChunkRows(
  listing: DirListing,
  fromIndex: number,
  count: number,
): { html: string; rendered: number; total: number } {
  const dirs = sortChildren(listing.children).filter(
    (c): c is DirListingEntry & { kind: "dir" } => c.kind === "dir",
  );
  const end = Math.min(fromIndex + count, dirs.length);
  const rows: string[] = [];
  for (let i = fromIndex; i < end; i++) rows.push(renderDirRow(dirs[i], "", 0));
  return { html: rows.join(""), rendered: end - fromIndex, total: dirs.length };
}

/**
 * Render the inner `<ul class="tree__children">` for a subdirectory the
 * user just expanded. Goes into the matching `[data-dir-target]` slot. The
 * children may themselves include further directories that are still
 * collapsed; clicking them fetches deeper listings via the same toggle
 * handler.
 */
export function renderSubdir(listing: DirListing, depth: number): string {
  const sorted = sortChildren(listing.children);
  const out: string[] = [];
  out.push(`<ul class="tree__children" role="list" style="--depth: ${depth}">`);
  for (const child of sorted) {
    if (child.kind === "dir") {
      out.push(renderDirRow(child, listing.path, depth));
    } else {
      out.push(
        renderFileRow(child, listing.dataset_id, listing.version, listing.path, depth, false),
      );
    }
  }
  out.push("</ul>");
  return out.join("");
}
