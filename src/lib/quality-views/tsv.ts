/**
 * A view's TSV role read under the live-views plan's C3 (neuroschema 0.6.0 `docs/views.md`,
 * Formats): `read.ts` holds the file grammar (strict UTF-8, LF line endings and a final LF, one
 * header, unique names, no ragged row) and the cell grammar; this file holds what a role adds to
 * it. A role reads only the columns it declares, each present once in the header, and every cell of
 * such a column meets the column's declared type. So one file can serve two roles, and a column no
 * role declares is never read.
 *
 * Each refusal is a `KindRefused` with the specification's word (`column_repeated`,
 * `column_missing`, and the cell words of `read.ts`).
 */

import { type CellType, KindRefused, type Tsv, cellValue, cells, readTsv } from "./read";

/** One declared column of a role. */
export interface ColumnDecl {
  readonly name: string;
  readonly type: CellType;
  readonly unit?: string;
}

/** A declared column read: the binary64 of each cell (its text for a `string` column) and the
 *  stored text of each, top to bottom. */
export interface TypedColumn {
  readonly values: number[];
  readonly text: string[];
}

/** The role's declared columns, each named once and present in the header. */
export function declaredColumns(
  columns: readonly ColumnDecl[] | undefined,
  tsv: Tsv,
): ColumnDecl[] {
  const declared = [...(columns ?? [])];
  const names = declared.map((c) => c.name);
  if (new Set(names).size !== names.length) throw new KindRefused("column_repeated");
  for (const name of names) {
    if (!tsv.header.includes(name)) throw new KindRefused("column_missing", name);
  }
  return declared;
}

/** One declared column's cells, each checked against the column's type. */
export function typedColumn(tsv: Tsv, column: ColumnDecl): TypedColumn {
  const text = cells(tsv, column.name);
  return { values: text.map((t) => cellValue(t, column.type) as number), text };
}

/** A TSV role's file read whole: the grammar, its declared columns, and every cell they hold. */
export function readDeclaredTsv(
  bytes: Uint8Array,
  columns: readonly ColumnDecl[] | undefined,
): { readonly tsv: Tsv; readonly columns: ReadonlyMap<string, TypedColumn> } {
  const tsv = readTsv(bytes);
  const read = new Map<string, TypedColumn>();
  for (const column of declaredColumns(columns, tsv))
    read.set(column.name, typedColumn(tsv, column));
  return { tsv, columns: read };
}
