import type { TreeNode } from "./bids-tree";
import { classifyFile } from "./bids-tree";
import { formatBytes } from "./format";

const MAX_AUTO_OPEN_DEPTH = 1;
const AUTO_OPEN_CHILD_CAP = 6;

// BIDS subject directory naming: `sub-` followed by alphanumeric label.
// Used by the skeleton path to identify which top-level directories should
// be rendered collapsed (with a lazy-load slot) instead of inlined. The
// same regex also gates the `?subject=` query parameter on the tree
// endpoint so a malformed value can't pass through as a tree key.
const SUBJECT_RE = /^sub-[A-Za-z0-9]+$/;
export function isSubjectDir(name: string): boolean {
  return SUBJECT_RE.test(name);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function countFilesDeep(n: TreeNode): number {
  let total = n.files.length;
  for (const c of n.children) total += countFilesDeep(c);
  return total;
}

function renderDirChildren(node: TreeNode, basePath: string, depth: number): string {
  const out: string[] = [];
  out.push(`<ul class="tree__children" role="list" style="--depth: ${depth}">`);
  for (const child of node.children) {
    const open = depth < MAX_AUTO_OPEN_DEPTH && node.children.length <= AUTO_OPEN_CHILD_CAP;
    const childFiles = countFilesDeep(child);
    const dirCount = child.children.length;
    out.push("<li>");
    out.push(`<details class="tree__dir"${open ? " open" : ""}>`);
    out.push(
      `<summary class="tree__row tree__row--dir" style="padding-inline-start: calc(var(--space-5) + ${depth} * var(--space-5))">`,
    );
    out.push(
      `<svg class="tree__chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
    );
    out.push(`<span class="tree__name">${esc(child.name)}/</span>`);
    out.push(
      `<span class="tree__counts">${dirCount > 0 ? `${dirCount} dirs · ` : ""}${childFiles} files</span>`,
    );
    out.push(`<span class="tree__size">${esc(formatBytes(child.totalSize))}</span>`);
    out.push("</summary>");
    out.push(renderDirChildren(child, basePath, depth + 1));
    out.push("</details></li>");
  }
  for (const f of node.files) {
    const name = f.path.split("/").pop() ?? f.path;
    const cls = classifyFile(name);
    out.push(
      `<li class="tree__row tree__row--file" style="padding-inline-start: calc(var(--space-5) + ${depth} * var(--space-5) + 16px)">`,
    );
    out.push(
      `<a class="tree__name" href="${esc(`${basePath}/${encodeURI(f.path)}`)}" rel="external" download="${esc(name)}" title="Download ${esc(f.path)}">${esc(name)}</a>`,
    );
    out.push(`<span class="tree__size">${esc(formatBytes(f.size))}</span>`);
    if (cls.isEEG)
      out.push(
        `<span class="tree__tag tree__tag--soon" title="Visualizer coming soon">Vis · soon</span>`,
      );
    if (cls.isTSV)
      out.push(
        `<span class="tree__tag tree__tag--soon" title="TSV viewer coming soon">View · soon</span>`,
      );
    if (cls.isJSON) out.push(`<span class="tree__tag">JSON</span>`);
    out.push("</li>");
  }
  out.push("</ul>");
  return out.join("");
}

/** Render the full <section class="tree"> HTML for a BIDS tree. */
export function renderBidsTree(root: TreeNode, basePath: string): string {
  const out: string[] = [];
  const topLevel = root.children;
  const rootFiles = root.files;
  out.push(`<section class="tree" aria-label="Dataset file tree">`);
  out.push(`<header class="tree__head">`);
  out.push("<h2>Files</h2>");
  out.push(
    `<span class="tree__meta">${root.children.length + root.files.length} top-level entries · ${esc(formatBytes(root.totalSize))} total</span>`,
  );
  out.push("</header>");

  if (rootFiles.length > 0) {
    out.push(`<ul class="tree__list tree__list--root" role="list">`);
    for (const f of rootFiles) {
      const cls = classifyFile(f.path);
      out.push(`<li class="tree__row">`);
      out.push(`<span class="tree__icon" aria-hidden="true">▪</span>`);
      out.push(
        `<a class="tree__name" href="${esc(`${basePath}/${encodeURI(f.path)}`)}" rel="external" download="${esc(f.path.split("/").pop() ?? f.path)}" title="Download ${esc(f.path)}">${esc(f.path)}</a>`,
      );
      out.push(`<span class="tree__size">${esc(formatBytes(f.size))}</span>`);
      if (cls.isReadme) out.push(`<span class="tree__tag">README</span>`);
      if (cls.isJSON) out.push(`<span class="tree__tag">JSON</span>`);
      out.push("</li>");
    }
    out.push("</ul>");
  }

  out.push(`<ul class="tree__list" role="list">`);
  for (const node of topLevel) {
    // Top-level subject directories are deferred: render the row, but emit
    // an empty `[data-subject-target]` placeholder instead of recursing.
    // The client expands the placeholder on first <details> toggle by
    // fetching `/api/dataset/<id>/tree?v=<v>&subject=<name>`. Non-subject
    // dirs (code/, derivatives/, .nemar/, ...) keep the current behavior,
    // including the auto-open heuristic for small top-level fanouts.
    const subjectRow = isSubjectDir(node.name);
    const open = !subjectRow && topLevel.length <= 3;
    out.push("<li>");
    out.push(
      subjectRow
        ? `<details class="tree__dir" data-subject="${esc(node.name)}">`
        : `<details class="tree__dir"${open ? " open" : ""}>`,
    );
    out.push(`<summary class="tree__row tree__row--dir">`);
    out.push(
      `<svg class="tree__chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
    );
    out.push(`<span class="tree__icon" aria-hidden="true">▸</span>`);
    out.push(`<span class="tree__name">${esc(node.name)}</span>`);
    out.push(
      `<span class="tree__counts">${node.children.length} dirs · ${countFilesDeep(node)} files</span>`,
    );
    out.push(`<span class="tree__size">${esc(formatBytes(node.totalSize))}</span>`);
    out.push("</summary>");
    if (subjectRow) {
      out.push(`<div class="tree__lazy" data-subject-target></div>`);
    } else {
      out.push(renderDirChildren(node, basePath, 1));
    }
    out.push("</details></li>");
  }
  out.push("</ul>");
  out.push("</section>");
  return out.join("");
}

/**
 * Render the inner subtree HTML for a single subject node. Used by
 * `GET /api/dataset/<id>/tree?v=<v>&subject=<sub>` so the client can
 * drop the response directly into the matching `[data-subject-target]`
 * placeholder produced by `renderBidsTree`. No `<section>` wrapper, no
 * header — just the same `<ul class="tree__children">` markup that
 * `renderDirChildren` emits for the inline case, so the expanded look
 * matches a non-deferred render byte-for-byte.
 */
export function renderBidsSubtree(node: TreeNode, basePath: string): string {
  return renderDirChildren(node, basePath, 1);
}

export function renderUnpublishedTree(): string {
  return `<section class="detail__no-manifest" role="note">
    <h2>Not yet published</h2>
    <p>No published version exists for this dataset. The file tree will appear here once a version is released.</p>
  </section>`;
}

/** No-manifest empty state HTML. */
export function renderNoManifest(version: string | null): string {
  return `<section class="detail__no-manifest" role="alert">
    <h2>Manifest unavailable</h2>
    <p>The file index for <code>${esc(version ?? "this version")}</code> could not be loaded.
    The version may not yet be published, or the underlying S3 lookup failed.
    Use the <a href="/discover">Discover page</a> to pick another dataset or try a different version above.</p>
  </section>`;
}
