import { describe, expect, it } from "vitest";
import { PREVIEW_ROW_CAP, parseTsv, renderTsvPreview } from "./render-file-preview-tsv";

const SAMPLE_TSV = [
  "participant_id\tage\tsex",
  "sub-001\t8\tM",
  "sub-002\t11\tF",
  "sub-003\t10\tM",
].join("\n");

describe("parseTsv", () => {
  it("splits the header row and data rows on tabs", () => {
    const { headers, rows } = parseTsv(SAMPLE_TSV);
    expect(headers).toEqual(["participant_id", "age", "sex"]);
    expect(rows).toEqual([
      ["sub-001", "8", "M"],
      ["sub-002", "11", "F"],
      ["sub-003", "10", "M"],
    ]);
  });

  it("returns empty for empty input", () => {
    expect(parseTsv("")).toEqual({ headers: [], rows: [] });
  });

  it("handles CRLF line endings", () => {
    const tsv = "a\tb\r\n1\t2\r\n3\t4\r\n";
    const { headers, rows } = parseTsv(tsv);
    expect(headers).toEqual(["a", "b"]);
    expect(rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("renderTsvPreview", () => {
  it("renders a sticky-header table inside .preview__tsv", () => {
    const html = renderTsvPreview(SAMPLE_TSV);
    expect(html).toContain(`<div class="preview__tsv">`);
    expect(html).toContain(`<table class="preview__tsv-table">`);
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>participant_id</th>");
    expect(html).toContain("<th>age</th>");
    expect(html).toContain("<th>sex</th>");
    expect(html).toContain("<tbody>");
    expect(html).toContain("<td>sub-001</td>");
  });

  it("returns the empty-file message on empty input", () => {
    expect(renderTsvPreview("")).toContain("This file is empty");
  });

  it("returns 'no data rows' when the file has only a header line", () => {
    expect(renderTsvPreview("hello world")).toContain("No data rows");
  });

  it("escapes HTML in headers and cell values", () => {
    const tsv = "<th>\t<td>\nrow1\t<script>";
    const html = renderTsvPreview(tsv);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;th&gt;");
  });

  it("caps at PREVIEW_ROW_CAP rows and emits a [data-tsv-show-all] button when exceeded", () => {
    const rows = Array.from({ length: 150 }, (_, i) => `sub-${i + 1}\t${i + 1}\tM`).join("\n");
    const tsv = `participant_id\tage\tsex\n${rows}`;
    const html = renderTsvPreview(tsv);
    const tableRows = html.match(/<tr>/g) ?? [];
    // 1 header tr + PREVIEW_ROW_CAP body trs
    expect(tableRows.length).toBe(PREVIEW_ROW_CAP + 1);
    expect(html).toContain("data-tsv-show-all");
    expect(html).toContain("Show all 150 rows");
  });

  it("omits the show-all button when row count fits the cap", () => {
    const html = renderTsvPreview(SAMPLE_TSV);
    expect(html).not.toContain("data-tsv-show-all");
  });

  it("pads ragged rows to the header column count (no silent misalignment)", () => {
    // Header has 3 columns; second row only carries 2 cells. Each <tr>
    // must still have 3 <td> so the table visually aligns.
    const tsv = ["a\tb\tc", "1\t2\t3", "4\t5"].join("\n");
    const html = renderTsvPreview(tsv);
    const tds = html.match(/<td>/g) ?? [];
    expect(tds.length).toBe(6);
    // The padded cell is empty.
    expect(html).toContain("<td>4</td><td>5</td><td></td>");
  });

  it("renders all rows when cap is Infinity", () => {
    const rows = Array.from({ length: 150 }, (_, i) => `sub-${i + 1}\t${i + 1}`).join("\n");
    const tsv = `participant_id\tage\n${rows}`;
    const html = renderTsvPreview(tsv, Number.POSITIVE_INFINITY);
    const tableRows = html.match(/<tr>/g) ?? [];
    expect(tableRows.length).toBe(150 + 1);
    expect(html).not.toContain("data-tsv-show-all");
  });
});
