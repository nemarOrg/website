/**
 * `tsv.ts`, the strict C3 reader of a view's TSV role, held to neuroschema's model vectors
 * (`kinds-models.v1.json`): every `nemar.table` case it draws reads to the model's rows, cell for
 * cell as stored text, and every case refused by the TSV or cell grammar, or by the declared
 * columns, is refused with the vector's word.
 */

import { describe, expect, it } from "vitest";
import { KindRefused } from "../src/lib/quality-views/read";
import { type ColumnDecl, readDeclaredTsv } from "../src/lib/quality-views/tsv";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
interface TableCase {
  name: string;
  view: {
    kind: string;
    data?: { role: string; location: string; columns?: ColumnDecl[] }[];
  };
  files: Record<string, { text?: string; base64?: string }>;
  model: {
    refused: { word: string } | null;
    model: { type: string; rows?: string[][] };
  };
}
const models = JSON.parse(
  fs.readFileSync(repoPath("test/fixtures/quality-views/vectors/kinds-models.v1.json"), "utf8"),
) as { cases: TableCase[] };

const TSV_WORDS = new Set([
  "tsv_encoding",
  "tsv_line_endings",
  "tsv_header_repeated",
  "tsv_ragged",
  "column_repeated",
  "column_missing",
  "cell_not_number",
  "cell_not_finite",
  "cell_not_integer",
]);

const tables = models.cases.filter((c) => c.view.kind === "nemar.table");
const roleOf = (c: TableCase) => c.view.data!.find((e) => e.role === "table")!;
const bytesOf = (c: TableCase): Uint8Array => {
  const held = c.files[roleOf(c).location];
  return held.text !== undefined
    ? new TextEncoder().encode(held.text)
    : Uint8Array.from(atob(held.base64!), (ch) => ch.charCodeAt(0));
};
const word = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof KindRefused) return error.word;
    throw error;
  }
};

describe("a table role under C3", () => {
  const drawn = tables.filter((c) => c.model.refused === null && c.model.model.type === "table");
  const refused = tables.filter((c) => c.model.refused && TSV_WORDS.has(c.model.refused.word));

  it("has the vectors' table cases, drawn and refused", () => {
    expect(drawn.length).toBeGreaterThanOrEqual(3);
    expect(refused.length).toBeGreaterThanOrEqual(20);
    // Every word the reader can give is among them.
    expect(new Set(refused.map((c) => c.model.refused!.word))).toEqual(TSV_WORDS);
  });

  it.each(drawn.map((c) => [c.name, c] as const))("reads %s to the model's rows", (_n, c) => {
    const { columns } = readDeclaredTsv(bytesOf(c), roleOf(c).columns);
    const declared = roleOf(c).columns ?? [];
    const rows = (c.model.model.rows ?? []).map((row) => row);
    declared.forEach((column, j) => {
      expect(columns.get(column.name)!.text, column.name).toEqual(rows.map((row) => row[j]));
    });
    // A column no role declares is never read.
    expect([...columns.keys()]).toEqual(declared.map((d) => d.name));
  });

  it.each(refused.map((c) => [c.name, c] as const))("refuses %s with its word", (_n, c) => {
    expect(word(() => readDeclaredTsv(bytesOf(c), roleOf(c).columns))).toBe(c.model.refused!.word);
  });

  it("reads each number as the binary64 nearest its text, and keeps the text", () => {
    const bytes = new TextEncoder().encode("x\tn\n0.1\t7\n-0\t-3\n1e2\t0\n");
    const { columns } = readDeclaredTsv(bytes, [
      { name: "x", type: "number" },
      { name: "n", type: "integer" },
    ]);
    expect(columns.get("x")!.values).toEqual([0.1, 0, 100]);
    expect(Object.is(columns.get("x")!.values[1], -0)).toBe(false);
    expect(columns.get("x")!.text).toEqual(["0.1", "-0", "1e2"]);
    expect(columns.get("n")!.values).toEqual([7, -3, 0]);
  });
});
