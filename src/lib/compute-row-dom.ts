/**
 * The one place the decide flow's page script changes a request row in place (website ADR 0030;
 * epic nemarOrg/website#493 phase E4). Thin on purpose: every word and every rule comes from the
 * pure `RequestRowModel` (`compute-admin-view.ts`, tested), and this only writes it into the
 * elements `ComputeRequestRow.astro` marked with `data-*` attributes. Every value is set as
 * `textContent` or an attribute, never as markup (website ADR 0029).
 */

import type { RequestRowModel, RowAction } from "./compute-admin-view";
import { iconPaths } from "./status-icons";

const SVG_NS = "http://www.w3.org/2000/svg";

function pick<T extends Element>(root: Element, selector: string): T | null {
  return root.querySelector<T>(selector);
}

/** Draw the pill's icon: the same path data the server-rendered pill uses. */
function setIcon(svg: SVGElement, icon: string): void {
  svg.replaceChildren();
  for (const d of iconPaths(icon)) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
}

function setText(root: Element, selector: string, text: string | null): void {
  const el = pick<HTMLElement>(root, selector);
  if (!el) return;
  el.textContent = text ?? "";
  el.hidden = text === null || text === "";
}

/** A decision button, as the page script finds it by `data-decision`. */
export function actionButton(action: RowAction, accountId: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `compute-row__btn compute-row__btn--${action.decision}`;
  button.dataset.decision = action.decision;
  button.dataset.accountId = String(accountId);
  button.textContent = action.label;
  if (action.disabled) {
    button.disabled = true;
    if (action.why) button.title = action.why;
  }
  return button;
}

/** Rebuild the row's buttons from the model. A note under them says why one is disabled. */
function setActions(row: HTMLElement, model: RequestRowModel): void {
  const bar = pick<HTMLElement>(row, "[data-row-actions]");
  if (!bar) return;
  bar.replaceChildren(...model.actions.map((a) => actionButton(a, model.id)));
  const why = model.actions.find((a) => a.why !== null)?.why ?? null;
  setText(row, "[data-row-disabled-why]", why);
}

/**
 * Write a row model into the row: the state pill, the facts that depend on the state (who
 * granted, whether anyone was told) and the buttons. The person's own fields are not touched:
 * a decision changes the state and nothing about who they are.
 */
export function applyRowModel(row: HTMLElement, model: RequestRowModel): void {
  const pill = pick<HTMLElement>(row, "[data-compute-pill]");
  if (pill) {
    pill.dataset.tone = model.state.tone;
    const svg = pick<SVGElement>(pill, "svg");
    if (svg) setIcon(svg, model.state.icon);
    const label = pick<HTMLElement>(pill, "[data-compute-pill-label]");
    if (label) label.textContent = model.state.label;
  }
  row.dataset.computeState = model.state.word;
  setText(row, "[data-row-granted]", model.granted);
  const notified = pick<HTMLElement>(row, "[data-row-not-notified]");
  if (notified) notified.hidden = !model.notNotified;
  setActions(row, model);
}

/** While a decision is out: every button of the row is disabled and the row says so. */
export function setRowWorking(row: HTMLElement, working: boolean, text: string): void {
  row.setAttribute("aria-busy", working ? "true" : "false");
  for (const b of row.querySelectorAll<HTMLButtonElement>("[data-decision]")) {
    if (working) b.disabled = true;
  }
  const status = pick<HTMLElement>(row, "[data-row-status]");
  if (status) {
    status.textContent = working ? text : "";
    status.hidden = !working;
  }
}

/** The result or the failure of a decision, kept on the row until the next load. */
export function setRowNote(row: HTMLElement, lines: readonly string[], tone: "ok" | "error"): void {
  const status = pick<HTMLElement>(row, "[data-row-status]");
  if (!status) return;
  status.replaceChildren(
    ...lines
      .filter((l) => l.length > 0)
      .map((line) => {
        const p = document.createElement("span");
        p.textContent = line;
        p.className = "compute-row__note-line";
        return p;
      }),
  );
  status.dataset.tone = tone;
  status.hidden = lines.every((l) => l.length === 0);
}

/** An account that is not there any more: nothing can be decided on this row. */
export function markRowStale(row: HTMLElement): void {
  row.dataset.stale = "true";
  for (const b of row.querySelectorAll<HTMLButtonElement>("[data-decision]")) b.disabled = true;
}
