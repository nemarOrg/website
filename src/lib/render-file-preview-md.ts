/**
 * Markdown preview renderer for the inline file viewer. Returns the HTML
 * body that fills a `.tree__preview` slot when the user clicks a `.md` file
 * in the BIDS tree. Reuses the existing `renderMarkdown` CommonMark subset
 * so we don't ship a second markdown parser.
 *
 * Wrapping in `.preview__md` lets the global stylesheet in BidsTree.astro
 * scope prose typography to inline previews without bleeding into the
 * dataset-header Readme component.
 */

import { renderMarkdown } from "./markdown";

export function renderMarkdownPreview(source: string): string {
  if (source.trim().length === 0) {
    return `<p class="preview__empty">This file is empty.</p>`;
  }
  return `<div class="preview__md">${renderMarkdown(source)}</div>`;
}
