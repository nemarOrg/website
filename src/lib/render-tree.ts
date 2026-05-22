import type { TreeNode } from "./bids-tree";
import { classifyFile } from "./bids-tree";
import { formatBytes } from "./format";

const MAX_AUTO_OPEN_DEPTH = 1;
const AUTO_OPEN_CHILD_CAP = 6;

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
    const open = topLevel.length <= 3;
    out.push("<li>");
    out.push(`<details class="tree__dir"${open ? " open" : ""}>`);
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
    out.push(renderDirChildren(node, basePath, 1));
    out.push("</details></li>");
  }
  out.push("</ul>");
  out.push("</section>");
  return out.join("");
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
