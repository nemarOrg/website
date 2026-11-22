/**
 * Browser-side rows for the /compute jobs table's "Load more" (website ADR 0030 phase E2).
 *
 * The server renders the first page from `jobRowView` in `ComputeJobsTable.astro`; this module renders
 * every later page from the SAME `jobRowView`, so the two are thin renderers over one place. It builds
 * DOM with `createElement`, `createElementNS` and `textContent` ONLY. Backend strings (an app id, a
 * partition, an unknown state) are therefore text nodes and can never become markup;
 * `test/compute-dashboard-ui.test.ts` forbids `innerHTML`, `insertAdjacentHTML`, `outerHTML` and
 * `set:html` in every Compute file to keep it that way.
 *
 * The class names are the contract with the table's global styles; keep them in step with
 * `ComputeJobsTable.astro` and `ComputeBadge.astro`.
 */
import { COMPUTE_LABELS } from "./compute-labels";
import type { JobRowView } from "./compute-view";
import { iconPaths } from "./status-icons";

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(doc: Document, name: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of iconPaths(name)) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** The same pill as `ComputeBadge.astro`, as DOM. */
export function badgeElement(
  doc: Document,
  badge: { label: string; tone: string; icon: string },
): HTMLSpanElement {
  const pill = el(doc, "span", `compute-badge compute-badge--${badge.tone}`);
  pill.append(icon(doc, badge.icon), el(doc, "span", undefined, badge.label));
  return pill;
}

function cell(doc: Document, label: string, className: string): HTMLTableCellElement {
  const td = el(doc, "td", className);
  td.dataset.label = label;
  return td;
}

/** One job as a table row. */
export function jobRowElement(doc: Document, row: JobRowView): HTMLTableRowElement {
  const L = COMPUTE_LABELS.jobs;
  const tr = el(doc, "tr", "compute-jobs__row");

  const id = cell(doc, L.job, "compute-jobs__cell compute-jobs__cell--id");
  if (row.href) {
    const a = el(doc, "a", "compute-jobs__link", row.id);
    a.setAttribute("href", row.href);
    id.append(a);
  } else {
    id.append(el(doc, "span", "compute-jobs__id", row.id));
  }

  const state = cell(doc, L.state, "compute-jobs__cell compute-jobs__cell--state");
  state.append(badgeElement(doc, row.state));
  if (row.cancelRequested) {
    state.append(el(doc, "span", "compute-jobs__cancel", L.cancelRequested));
  }

  const app = cell(doc, L.app, "compute-jobs__cell compute-jobs__cell--app");
  app.append(
    el(doc, "span", undefined, row.app),
    " ",
    el(doc, "span", "compute-jobs__version", row.appVersion),
  );

  const partition = cell(doc, L.partition, "compute-jobs__cell");
  partition.textContent = row.partition;

  const door = cell(doc, L.frontDoor, "compute-jobs__cell");
  door.textContent = row.frontDoor;

  const created = cell(doc, L.created, "compute-jobs__cell compute-jobs__cell--created");
  const time = el(doc, "time", undefined, row.createdText);
  if (row.createdIso) time.setAttribute("datetime", row.createdIso);
  time.setAttribute("title", row.createdTitle);
  created.append(time);

  const charged = cell(doc, L.charged, "compute-jobs__cell compute-jobs__cell--charged");
  charged.dataset.chargeKind = row.chargeKind;
  charged.textContent = row.charged;

  tr.append(id, state, app, partition, door, created, charged);
  return tr;
}
