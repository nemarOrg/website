/**
 * The fallback (neuroschema 0.6.0 `docs/views/generic-kinds.md`, The fallback; website ADR 0035
 * decision 3): a view this site cannot draw, by its kind or by its base, or whose kind refused its
 * files, shows each readable TSV file as a table of its text and offers every file for download.
 * When a kind refused the files, the page says why, with the word's sentence. Nothing here can
 * refuse: it draws whatever tables the model holds.
 */

import type { BuiltModel, FallbackModel } from "../model";
import { type Element, h } from "../tree";
import { type ViewContext, figure, fileName, textTable } from "./figure";
import { VIEW_SENTENCES, sentence } from "./words";

/** Why the view shows as tables: the kind and its word, or that no renderer here draws it. */
export function fallbackReason(built: Pick<BuiltModel, "refused">, ctx: ViewContext): string {
  if (built.refused) {
    return `${sentence(VIEW_SENTENCES, built.refused.word)} It is shown as tables instead of ${built.refused.kind}.`;
  }
  return `This page does not draw ${ctx.kind} version ${ctx.kindVersion}, so its data are shown as tables.`;
}

/** Said when a renderer failed on a view: nothing of it is drawn, and its files are listed. */
export const RENDER_FAILED =
  "This view could not be drawn on this page; its files are listed below.";

export function renderFallback(
  model: FallbackModel,
  built: Pick<BuiltModel, "refused" | "downloads">,
  ctx: ViewContext,
  why?: string,
): Element {
  const reason = why ?? fallbackReason(built, ctx);
  return figure({
    ctx,
    drawing: null,
    label: `${ctx.caption} ${reason}`,
    notes: [
      h("p", { class: "qv-note", "data-word": built.refused?.word ?? null }, reason),
      ...model.tables.map((table) =>
        textTable(`${fileName(table.location)} (${table.role})`, table.header, table.rows),
      ),
    ],
    downloads: built.downloads,
  });
}
