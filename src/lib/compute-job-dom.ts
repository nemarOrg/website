/**
 * Browser-side nodes for the job page (website ADR 0030 phase E3, issue #496). The server renders the
 * first view from `jobDetailView` in the Astro components; this module renders every later view from
 * the SAME view models, so the two are thin renderers over one place (the precedent is
 * `compute-jobs-dom.ts`). It builds DOM with `createElement`, `createElementNS` and `textContent`
 * ONLY: a job's name, a log line or a file name is therefore a text node and can never become markup.
 * `test/compute-job-ui.test.ts` forbids every markup-writing API in the job files.
 *
 * The class names are the contract with the global styles in the components (Astro's scoped styles do
 * not reach script-built nodes); keep them in step with `ComputeJobTimeline.astro`,
 * `ComputeJobResults.astro` and the page.
 */
import type { FailureView } from "./compute-failure";
import type { DetailRow, ResultRow, TimelineView } from "./compute-job-view";
import { iconPaths } from "./status-icons";

const SVG_NS = "http://www.w3.org/2000/svg";

export function el<K extends keyof HTMLElementTagNameMap>(
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

function icon(doc: Document, name: string, size = 14): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of iconPaths(name)) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function timeElement(
  doc: Document,
  text: string,
  iso: string | null,
  title: string,
): HTMLTimeElement {
  const t = el(doc, "time", undefined, text);
  if (iso) t.setAttribute("datetime", iso);
  t.setAttribute("title", title);
  return t;
}

/** The items of the timeline `<ol>`; empty for a state this build does not know. */
export function timelineItems(doc: Document, view: TimelineView): HTMLLIElement[] {
  return view.steps.map((step) => {
    const li = el(doc, "li", `compute-job-step compute-job-step--${step.status}`);
    li.dataset.step = step.key;
    if (step.status === "current") li.setAttribute("aria-current", "step");
    li.append(icon(doc, step.icon, 16));
    const text = el(doc, "span", "compute-job-step__text");
    text.append(el(doc, "span", "compute-job-step__label", step.label));
    text.append(" ", el(doc, "span", "visually-hidden", `(${step.statusWord})`));
    if (step.time) {
      const when = el(doc, "span", "compute-job-step__time");
      if (step.time.label) when.append(`${step.time.label} `);
      when.append(timeElement(doc, step.time.text, step.time.iso, step.time.title));
      text.append(when);
    }
    li.append(text);
    return li;
  });
}

/** The rows of the details `<dl>`, then the charge row. */
export function detailRows(
  doc: Document,
  rows: readonly DetailRow[],
  charge: { label: string; text: string; kind: string },
): HTMLDivElement[] {
  const make = (label: string, kind?: string): [HTMLDivElement, HTMLElement] => {
    const wrap = el(doc, "div", "compute-job-row");
    const dd = el(doc, "dd", "compute-job-row__value");
    if (kind) dd.dataset.chargeKind = kind;
    wrap.append(el(doc, "dt", "compute-job-row__label", label), dd);
    return [wrap, dd];
  };
  const out: HTMLDivElement[] = rows.map((row) => {
    const [wrap, dd] = make(row.label);
    wrap.dataset.row = row.key;
    if (row.time) dd.append(timeElement(doc, row.value, row.time.iso, row.time.title));
    else dd.textContent = row.value;
    return wrap;
  });
  const [wrap, dd] = make(charge.label, charge.kind);
  wrap.dataset.row = "charged";
  dd.textContent = charge.text;
  out.push(wrap);
  return out;
}

/** The failure sentence, and the log pointer where the log can help. */
export function failureNodes(doc: Document, failure: FailureView): Node[] {
  const out: Node[] = [el(doc, "p", "compute-job-failure__sentence", failure.sentence)];
  if (failure.logHint) {
    const p = el(doc, "p", "compute-job-failure__hint", failure.logHint.lead);
    p.append(el(doc, "code", undefined, failure.logHint.command), ".");
    out.push(p);
  }
  out.push(el(doc, "p", "compute-job-failure__code", `Code: ${failure.code}`));
  return out;
}

/**
 * One result file. The address reaches `href` only if `row.href` (from `safeResultHref`) is non-null; the
 * link opens in a new tab with no opener and no referrer, and is never copied anywhere else.
 */
export function resultRowElement(
  doc: Document,
  row: ResultRow,
  words: { download: string; unavailable: string; sha: string },
): HTMLLIElement {
  const li = el(doc, "li", "compute-job-result");
  li.append(el(doc, "span", "compute-job-result__path", row.path));
  const meta = el(doc, "span", "compute-job-result__meta", row.size);
  const sha = el(doc, "code", "compute-job-result__sha", row.shaShort);
  sha.title = `${words.sha} ${row.sha}`;
  meta.append(" ", sha);
  li.append(meta);
  if (row.href) {
    const a = el(doc, "a", "compute-job-result__link", words.download);
    a.setAttribute("href", row.href);
    a.setAttribute("rel", "noopener noreferrer");
    a.setAttribute("referrerpolicy", "no-referrer");
    a.setAttribute("target", "_blank");
    li.append(a);
  } else {
    li.append(el(doc, "span", "compute-job-result__none", words.unavailable));
  }
  return li;
}
