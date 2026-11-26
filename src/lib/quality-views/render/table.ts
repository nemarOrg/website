/**
 * `nemar.table` version 1 (neuroschema 0.6.0 `docs/views/generic-kinds.md`): the declared columns in
 * declared order, each with its unit in its header, and each cell as its stored text. The table is
 * its own text alternative, so it needs no drawing, no toggle and no readout.
 */

import type { Download, TableModel } from "../model";
import type { Element } from "../tree";
import { type ViewContext, figure, textTable } from "./figure";

export const columnHeader = (name: string, unit: string | null): string =>
  unit ? `${name} (${unit})` : name;

export function renderTable(
  model: TableModel,
  downloads: readonly Download[],
  ctx: ViewContext,
): Element {
  return figure({
    ctx,
    drawing: null,
    label: ctx.caption,
    table: textTable(
      ctx.caption,
      model.columns.map((c) => columnHeader(c.name, c.unit)),
      model.rows,
    ),
    downloads,
  });
}
