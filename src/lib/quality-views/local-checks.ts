/**
 * The declaration and content checks on the page's own thread: for a view the worker does not
 * check (a computed preset, whose schemas are `guards-computed.ts`, loaded only then), when the
 * worker cannot answer, and in the tests. A lazy chunk: a page loads it only in those cases.
 */

import type { ViewChecks } from "./checks";
import { checkContent, checkView } from "./kinds";

export const localChecks: ViewChecks = {
  async view(view) {
    const held = checkView(view);
    if (held) return held;
    const { COMPUTED_SCHEMAS } = await import("./guards-computed");
    return checkView(view, COMPUTED_SCHEMAS)!;
  },
  content: async (schema, content) => checkContent(schema, content),
};
