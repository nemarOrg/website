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
  const out: string[] = [];
  out.push(`<li class="tree__row${isRoot ? "" : " tree__row--file"}"${indentStyle}>`);
  if (isRoot) {
    out.push(`<span class="tree__icon" aria-hidden="true">▪</span>`);
  }
  out.push(
    `<a class="tree__name" href="${esc(href)}" rel="external" download="${esc(entry.name)}" title="Download ${esc(fullPath)}">${esc(isRoot ? fullPath : entry.name)}</a>`,
  );
  out.push(`<span class="tree__size">${esc(size)}</span>`);
  appendTags(out, cls, isRoot);
  out.push("</li>");
  return out.join("");
}

function appendTags(out: string[], cls: FileClassification, isRoot: boolean): void {
  if (cls.isReadme) out.push(`<span class="tree__tag">README</span>`);
  if (cls.isJSON) out.push(`<span class="tree__tag">JSON</span>`);
  // EEG / TSV viewer hints are nested-rows-only — the root rarely contains
  // raw data files; suppressing the badges there keeps the top-level view
  // calm. Same UX the pre-#76 renderer had.
  if (!isRoot && cls.isEEG)
    out.push(
      `<span class="tree__tag tree__tag--soon" title="Visualizer coming soon">Vis · soon</span>`,
    );
  if (!isRoot && cls.isTSV)
    out.push(
      `<span class="tree__tag tree__tag--soon" title="TSV viewer coming soon">View · soon</span>`,
    );
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

/**
 * Render the entire `<section class="tree">` for a top-level directory
 * listing (path === ""). Files appear at the top in the flat `--root` list;
 * directories follow as collapsed lazy rows.
 */
export function renderTopLevel(listing: DirListing): string {
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
    out.push(`<ul class="tree__list" role="list">`);
    for (const d of dirs) out.push(renderDirRow(d, "", 0));
    out.push("</ul>");
  }
  out.push("</section>");
  return out.join("");
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
