/**
 * What the quality panel hands a preset's extras (website phase W6): each kind's extras are a chunk
 * of their own (`spectrum.ts`, `components.ts`, `signal.ts`), loaded when a view of that kind is
 * drawn, so a tab's first screen carries only its own. Types only.
 */

import type { BuiltModel, FileSource, ModelOptions, ViewDecl } from "../model";
import type { QualityRecord } from "../record";
import type { ViewContext } from "../render/index";

export interface ExtraContext {
  readonly doc: Document;
  readonly view: ViewDecl;
  readonly record: QualityRecord;
  /** The base's model, as drawn (null for a computed preset, which has no data). */
  readonly built: BuiltModel | null;
  /** The base's figure, or null when nothing was drawn. */
  readonly figure: HTMLElement | null;
  /** The view's container in its tab. */
  readonly container: HTMLElement;
  readonly source: FileSource;
  readonly options: ModelOptions;
  readonly ctx: ViewContext;
  /** The recording's work: aborted when another recording is shown; check it after each await. */
  readonly signal: AbortSignal;
  /** Draw a built model into `target` as the panel draws every view (the page's client, Turbo). */
  mount(target: HTMLElement, built: BuiltModel, ctx: ViewContext): Promise<void>;
  /** A word's sentence (`panel-words.ts`). */
  sentence(word: string): Promise<string>;
}

/** Put `node` in a figure before its data table, or at its end. */
export function intoFigure(figure: HTMLElement | null, node: Node): void {
  if (!figure) return;
  figure.insertBefore(node, figure.querySelector(":scope > details.qv-data"));
}

/** A note with a word's sentence. */
export async function noteOf(x: ExtraContext, word: string): Promise<Node> {
  const p = x.doc.createElement("p");
  p.className = "qv-note";
  p.dataset.word = word;
  p.textContent = await x.sentence(word);
  return p;
}
