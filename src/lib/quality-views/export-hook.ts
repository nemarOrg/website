/**
 * A drawn view's Export toggle (website phase W8): a native `details` whose body the export's own
 * chunk (`export/controls.ts`) fills the first time it opens, so no export code is on a panel's
 * first screen (`scripts/check-quality-views-size.mjs` fails a build where it is). Kept small: it
 * loads with the panel, whose budget is nearly spent.
 */

import type { ExportInput } from "./export/controls";
import { h, toDom } from "./tree";

export function attachExport(container: HTMLElement, input: ExportInput): void {
  // A view drawn from stored files: a computed view (the Signal tab's window) has none to export.
  if (!input.view.data?.length) return;
  const details = toDom(
    h("details", { class: "qv-export" }, h("summary", {}, "Export this view"), h("div", {})),
    container.ownerDocument,
  ) as HTMLDetailsElement;
  const body = details.lastChild as HTMLElement;
  details.addEventListener("toggle", () => {
    if (!details.open || body.firstChild) return;
    body.textContent = "Loading…";
    import("./export/controls").then(
      (m) => m.fillExport(body, input),
      (error: unknown) => {
        console.error("[quality-views] export:", error);
        body.textContent = "The export could not be loaded; reload the page to try again.";
      },
    );
  });
  container.append(details);
}
