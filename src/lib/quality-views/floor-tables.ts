/**
 * The floor's tables as the computed presets read them (neuroschema 0.6.0 `docs/views/presets.md`,
 * The floor's tables): where a recipe writes a recording's tables (`productStem`,
 * `tableIsRecordings`) and how a table is read (`readTable`). Shared by `nemar.signal-window`
 * (`signal-window.ts`, on the page) and `nemar.ic-activity` (`transforms/ic-activity.ts`, in the
 * map worker), so neither chunk carries the other. `neuroschema.views.presets` is the reference.
 */

import { KindRefused, type Tsv, cellValue, cells } from "./read";

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const dirname = (path: string): string => {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at).replace(/\/+$/, "") || path.slice(0, at);
};

/** nemar-process's `naming.product_stem`: the recording's name without its last `_<suffix>.<ext>`,
 *  its first `desc-<x>` becoming `desc-<x><label>`, or `_desc-<label>` appended. */
export function productStem(recording: string, label: string): string {
  const name = basename(recording);
  const parts = name.slice(0, name.includes("_") ? name.lastIndexOf("_") : name.length).split("_");
  const at = parts.findIndex((part) => /^desc-[^_]*$/.test(part));
  if (at >= 0) {
    parts[at] = `${parts[at]}${label}`;
    return parts.join("_");
  }
  return [...parts, `desc-${label}`].join("_");
}

/** Whether a table lies beside the recording, named `<stem>_<suffix>.tsv` with the stem the
 *  recipe of `label` gives the recording's products (`table_stem`); any suffix when none is given. */
export function tableIsRecordings(
  location: string,
  recording: string,
  label: string,
  suffix?: string,
): boolean {
  const found = /^(.+)_([A-Za-z0-9]+)\.tsv$/.exec(basename(location));
  if (!found || dirname(location) !== dirname(recording) || !basename(recording).includes("_")) {
    return false;
  }
  return (
    (suffix === undefined || found[2] === suffix) && found[1] === productStem(recording, label)
  );
}

/** The label of the recipe that wrote a view (`recipe_label`): its name without hyphens, or null
 *  for a view a plugin wrote. */
export const recipeLabel = (view: object): string | null => {
  const name = (view as { source?: { recipe?: { name?: unknown } } }).source?.recipe?.name;
  return typeof name === "string" ? name.replaceAll("-", "") : null;
};

/** One of the floor's tables: at most `cellCap` cells counting every header column, its `columns`
 *  present (looked for in that order), and each of `numbers` a finite number, column by column. */
export function readTable(
  tsv: Tsv,
  columns: readonly string[],
  numbers: readonly string[],
  cellCap: number,
): Record<string, string | number>[] {
  if (tsv.rows.length * tsv.header.length > cellCap) {
    throw new KindRefused("cap_exceeded", `${tsv.rows.length} rows`);
  }
  for (const name of columns) {
    if (!tsv.header.includes(name)) throw new KindRefused("column_missing", name);
  }
  const values: Record<string, (string | number)[]> = {};
  for (const name of columns) values[name] = cells(tsv, name);
  for (const name of numbers)
    values[name] = values[name].map((t) => cellValue(String(t), "number"));
  return tsv.rows.map((_, k) => Object.fromEntries(columns.map((name) => [name, values[name][k]])));
}

/** The floor's `_badsegments.tsv` (`read_segments`): onset and duration in seconds and a label,
 *  each duration above 0 (`duration_not_positive`). */
export function readSegments(
  tsv: Tsv,
  cellCap: number,
): { onset: number; duration: number; label: string }[] {
  const rows = readTable(tsv, ["onset", "duration", "label"], ["onset", "duration"], cellCap);
  for (const row of rows) {
    if (!((row.duration as number) > 0)) {
      throw new KindRefused("duration_not_positive", String(row.duration));
    }
  }
  return rows as unknown as { onset: number; duration: number; label: string }[];
}
