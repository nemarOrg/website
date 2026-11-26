/**
 * `nemar.ic-maps` and `nemar.ic-classes` extras on the panel (presets.md): one text row per
 * component from the components table, each cell its stored text with its column's name and unit;
 * and each class's count and summed variance as stored, labeled "summed variance of components
 * classed X", never "variance explained by X".
 */

import { icClassesContent, icMapsRows } from "../preset-components";
import { numberText } from "../read";
import { type ExtraContext, intoFigure } from "./context";

function list(x: ExtraContext, tag: "ol" | "ul", label: string, rows: [string, string][]): Node {
  const out = x.doc.createElement(tag);
  out.className = tag === "ol" ? "qp-components" : "qp-classes";
  out.setAttribute("aria-label", label);
  for (const [name, text] of rows) {
    const li = x.doc.createElement("li");
    if (name) li.dataset.item = name;
    li.textContent = text;
    out.append(li);
  }
  return out;
}

export async function draw(x: ExtraContext): Promise<void> {
  if (x.view.kind === "nemar.ic-maps") {
    const rows = await icMapsRows(x.view, x.source, x.options);
    if (x.signal.aborted) return;
    intoFigure(
      x.figure,
      list(
        x,
        "ol",
        "Components",
        rows.map((row) => [
          row.component,
          `${row.component}: ${row.cells.map((c) => `${c.name} ${c.unit ? `${c.text} ${c.unit}` : c.text}`).join(", ")}`,
        ]),
      ),
    );
    return;
  }
  const c = await icClassesContent(x.view, x.source, x.options);
  if (x.signal.aborted) return;
  intoFigure(
    x.figure,
    list(x, "ul", "Classes", [
      ...c.categories.map((name, k): [string, string] => [
        name,
        `${name}: ${numberText(c.counts[k])} components; summed variance of components classed ${name}: ${numberText(c.summed_variance_pct[k])}%`,
      ]),
      ["", `${numberText(c.n_components)} components in all (${c.classifier}).`],
    ]),
  );
}
