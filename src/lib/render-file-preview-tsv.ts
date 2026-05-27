/**
 * TSV preview renderer. Returns HTML for a sticky-header table that fills
 * a `.tree__preview` slot when the user clicks a `.tsv` file.
 *
 * Capped at `PREVIEW_ROW_CAP` rows on first render (datasets like
 * `participants.tsv` carry hundreds of rows; rendering all of them blocks
 * the main thread and crowds the panel). When the file exceeds the cap, a
 * `[data-tsv-show-all]` button reveals the rest via the document-level
 * click delegate in `src/pages/dataset/[id].astro`.
 *
 * BIDS TSV files are tab-separated and disallow tabs inside cell values,
 * so a naive `split("\t")` is sufficient. No quoting / escaping logic
 * needed.
 */

export const PREVIEW_ROW_CAP = 100;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface ParsedTsv {
  headers: string[];
  rows: string[][];
}

export function parseTsv(text: string): ParsedTsv {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split("\t");
  const rows = lines.slice(1).map((line) => line.split("\t"));
  return { headers, rows };
}

function renderTableHead(headers: string[]): string {
  return `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>`;
}

function renderTableRows(rows: string[][]): string {
  return [
    "<tbody>",
    ...rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell ?? "")}</td>`).join("")}</tr>`),
    "</tbody>",
  ].join("");
}

/**
 * Render a TSV preview. `cap` controls how many rows render initially;
 * when set to `Infinity` the entire file renders (used by the "Show all"
 * reveal handler).
 */
export function renderTsvPreview(rawText: string, cap = PREVIEW_ROW_CAP): string {
  if (rawText.trim().length === 0) {
    return `<p class="preview__empty">This file is empty.</p>`;
  }
  const { headers, rows } = parseTsv(rawText);
  if (headers.length === 0) {
    return `<p class="preview__empty">No tab-separated content detected.</p>`;
  }
  if (rows.length === 0) {
    return `<p class="preview__empty">No data rows in this file.</p>`;
  }
  const shown = rows.slice(0, cap);
  const moreFooter =
    rows.length > shown.length
      ? `<div class="preview__tsv-more"><button class="preview__tsv-more-btn" type="button" data-tsv-show-all>Show all ${rows.length} rows</button></div>`
      : "";
  return [
    `<div class="preview__tsv">`,
    `<table class="preview__tsv-table">`,
    renderTableHead(headers),
    renderTableRows(shown),
    "</table>",
    "</div>",
    moreFooter,
  ].join("");
}
