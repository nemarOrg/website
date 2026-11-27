/** `nemar.ic-maps`' components table and `nemar.ic-classes`' content checks (presets.md). */

import {
  CAPS,
  type FileSource,
  type ModelOptions,
  Reader,
  type ViewDecl,
  subtleSha256,
} from "./model";
import { IC_CLASSES_CONTENT, PresetRefused } from "./preset-refused";
import { KindRefused, cells, readJson } from "./read";

const readerOf = (view: ViewDecl, source: FileSource, options: ModelOptions): Reader =>
  new Reader(view, source, options.caps ?? CAPS, options.sha256 ?? subtleSha256, options.checks);

/** One component's text row: its cells of the components table, by column, as stored text. */
export interface ComponentRow {
  readonly component: string;
  readonly cells: readonly {
    readonly name: string;
    readonly unit: string | null;
    readonly text: string;
  }[];
}

/** `nemar.ic-maps`: the components table, read as a data file, names the values' components in
 *  order. Returns each component's text row; `PresetRefused` (outcome `base`) otherwise. */
export async function icMapsRows(
  view: ViewDecl,
  source: FileSource,
  options: ModelOptions,
): Promise<ComponentRow[]> {
  const reader = readerOf(view, source, options);
  const names = (reader.entry("values")?.columns ?? []).map((c) => c.name);
  const entry = reader.entry("components");
  let table: Awaited<ReturnType<Reader["tsv"]>>;
  try {
    if (!entry) throw new KindRefused("column_missing", "component");
    table = await reader.tsv(entry);
    if (table.rows.length * table.header.length > reader.caps.cells_per_role) {
      throw new KindRefused("cap_exceeded", `${table.rows.length} rows`);
    }
    if (!table.header.includes("component")) throw new KindRefused("column_missing", "component");
  } catch (error) {
    if (error instanceof KindRefused) throw new PresetRefused(error.word, "base");
    throw error;
  }
  const labels = cells(table, "component");
  if (labels.length !== names.length || labels.some((label, i) => label !== names[i])) {
    throw new PresetRefused("components_mismatch", "base");
  }
  const declared = (entry.columns ?? []).filter(
    (c) => c.name !== "component" && table.header.includes(c.name),
  );
  return labels.map((component, k) => ({
    component,
    cells: declared.map((c) => ({
      name: c.name,
      unit: c.unit ?? null,
      text: cells(table, c.name)[k],
    })),
  }));
}

/** The content of an ic-classes view, with what the preset prints per class. */
export interface IcClasses {
  readonly classifier: string;
  readonly categories: readonly string[];
  readonly counts: readonly number[];
  readonly summed_variance_pct: readonly number[];
  readonly n_components: number;
}

/** `nemar.ic-classes`: the content meets its schema, has one summed variance per category, and its
 *  counts sum to `n_components`. `PresetRefused` (outcome `base`) otherwise. */
export async function icClassesContent(
  view: ViewDecl,
  source: FileSource,
  options: ModelOptions,
): Promise<IcClasses> {
  const reader = readerOf(view, source, options);
  const entry = reader.entry("histogram");
  if (!entry) throw new PresetRefused("content_invalid", "base");
  const content = readJson(await reader.verified(entry)) as IcClasses;
  if (!(await options.checks.content(IC_CLASSES_CONTENT, content))) {
    throw new PresetRefused("content_invalid", "base");
  }
  if (content.summed_variance_pct.length !== content.categories.length) {
    throw new PresetRefused("variance_length", "base");
  }
  if (content.counts.reduce((a, b) => a + b, 0) !== content.n_components) {
    throw new PresetRefused("components_total", "base");
  }
  return content;
}
