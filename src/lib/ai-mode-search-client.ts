/**
 * The browser half of the AI Mode toggle in search (website#518 on Discover, #519 on Home): it
 * finds the toggles `AiModeToggle.astro` renders hidden, reveals them once the widget can open,
 * keeps `ai=1` in the address, the form and the page's own links, and runs the AI overview panel
 * above Discover's results.
 *
 * What is decided in a tested module: the panel's transitions (`OverviewController` in
 * `./ai-overview-panel`: off, on, a kept answer, abort, stale responses, retry, failure kinds), what
 * each state shows (`panelView`), the request, its limits and the answer (`./osa-overview`, among
 * them `parseOverviewRequest`), the preference, the address parameter, the link rewrite
 * (`aiLinkHref`) and the follow-up call (`./osa-ai-mode`). What is not: this file's DOM glue,
 * which turns those results into elements, moves focus back to the panel's heading when a button
 * the reader used is replaced, and keeps the `ai=1` input in the form ({@link syncAiInput}). That
 * part is checked in a browser and by the source guards in `test/ai-mode-search.test.ts`.
 *
 * Nothing here writes markup from a string: the overview's text is set with `textContent` and its
 * ids become anchors whose `href` is built from the tested `/dataset/<id>` helper.
 */

import {
  FOLLOW_UP_FAILED,
  OverviewController,
  type PanelView,
  followUpText,
  panelView,
} from "./ai-overview-panel";
import {
  type AiModeLoadTarget,
  type AiModePageWindow,
  type AiModeWindow,
  aiLinkHref,
  aiModeSearchAvailable,
  askFollowUp,
  initialAiModeSearch,
  setAiModeSearch,
  whenDocumentReady,
  withAiModeParam,
} from "./osa-ai-mode";
import { type OverviewRequest, parseOverviewRequest, requestOverview } from "./osa-overview";

/** Names `ai` in a form the field submits with, so a search, a filter or a sort keeps AI Mode. */
const AI_INPUT = "input[data-ai-input]";

/** Adds or removes the hidden `ai=1` input of the form the toggle's field submits with. Off, the
 *  form is exactly what it was: no input, so nothing extra is submitted. */
export function syncAiInput(doc: Document, toggle: HTMLElement, on: boolean): void {
  const formId = toggle.dataset.aiForm;
  const form = formId ? doc.getElementById(formId) : toggle.closest("form");
  if (!(form instanceof HTMLFormElement)) return;
  const existing = doc.querySelector<HTMLInputElement>(AI_INPUT);
  if (!on) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const input = doc.createElement("input");
  input.type = "hidden";
  input.name = "ai";
  input.value = "1";
  input.setAttribute("data-ai-input", "");
  if (formId) input.setAttribute("form", formId);
  form.append(input);
}

/** Sets or removes `ai=1` on the page's own /discover links, whose server-rendered hrefs (cached
 *  at the edge for every reader) cannot know the preference. */
export function carryAiOnLinks(doc: Document, on: boolean): void {
  const root = doc.getElementById("main") ?? doc;
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = aiLinkHref(anchor.getAttribute("href"), doc.baseURI, doc.location.origin, on);
    if (href !== null) anchor.setAttribute("href", href);
  }
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderBody(
  doc: Document,
  body: HTMLElement,
  view: PanelView,
  onFollowUp: (button: HTMLElement) => void,
  onRetry: () => void,
) {
  body.replaceChildren();
  if (view.skeleton) {
    for (const width of ["92%", "78%", "64%"]) {
      const line = element(doc, "div", "ai-overview__skeleton");
      line.style.inlineSize = width;
      body.append(line);
    }
    return;
  }
  if (view.error) {
    body.append(element(doc, "p", "ai-overview__error", view.error.message));
    const retry = element(
      doc,
      "button",
      "ai-overview__button ai-overview__button--quiet",
      view.error.retry,
    );
    retry.type = "button";
    retry.addEventListener("click", onRetry);
    body.append(retry);
    return;
  }
  if (view.summary.length === 0) return;

  const summary = element(doc, "p", "ai-overview__summary");
  for (const segment of view.summary) {
    if (segment.kind === "text") {
      summary.append(doc.createTextNode(segment.text));
    } else {
      const link = element(doc, "a", "ai-overview__link", segment.id);
      link.href = segment.href;
      summary.append(link);
    }
  }
  body.append(summary);

  if (view.picks.length > 0) {
    const list = element(doc, "ol", "ai-overview__picks");
    for (const pick of view.picks) {
      const item = doc.createElement("li");
      const id = element(doc, "a", "ai-overview__id", pick.id);
      id.href = pick.href;
      item.append(id, element(doc, "span", "", pick.reason));
      list.append(item);
    }
    body.append(list);
  }

  const foot = element(doc, "div", "ai-overview__foot");
  if (view.followUp) {
    const ask = element(doc, "button", "ai-overview__button", view.followUp);
    ask.type = "button";
    ask.addEventListener("click", () => onFollowUp(ask));
    foot.append(ask);
  }
  if (view.footnote) foot.append(element(doc, "span", "ai-overview__note", view.footnote));
  body.append(foot);
}

/** The overview panel above the results: the DOM around an {@link OverviewController}, which
 *  decides when to ask, what to keep and what a failure is. */
class OverviewPanel {
  private readonly controller: OverviewController;

  constructor(
    private readonly win: Window,
    private readonly doc: Document,
    private readonly section: HTMLElement,
    private readonly request: OverviewRequest,
    endpoint: string,
  ) {
    this.controller = new OverviewController({
      reading: request.results.length,
      fetchOverview: (signal) => requestOverview(endpoint, request, { signal }),
      onState: (state) => this.render(panelView(state)),
    });
  }

  setOn(on: boolean): void {
    void this.controller.setOn(on);
  }

  private render(view: PanelView): void {
    const { doc, section } = this;
    const hadFocus = section.contains(doc.activeElement) && doc.activeElement !== section;
    section.hidden = !view.visible;
    section.setAttribute("aria-busy", String(view.busy));
    // The live region is a sibling of the section (hidden, it is out of the accessibility tree);
    // the line beside the heading is the drawn copy.
    const live = doc.querySelector<HTMLElement>("[data-ai-status]");
    if (live) live.textContent = view.status;
    const status = section.querySelector<HTMLElement>("[data-ai-status-text]");
    if (status) {
      status.textContent = view.status;
      status.classList.toggle("ai-overview__status--quiet", !view.statusVisible);
    }
    const badge = section.querySelector<HTMLElement>("[data-ai-badge]");
    if (badge) {
      badge.hidden = view.badge === null;
      if (view.badge) badge.textContent = view.badge;
    }
    const body = section.querySelector<HTMLElement>("[data-ai-body]");
    if (body) {
      renderBody(
        doc,
        body,
        view,
        (button) => this.followUp(button),
        () => void this.controller.retry(),
      );
    }
    // A button the reader used was replaced; keep their place at the panel's heading.
    if (hadFocus && !section.contains(doc.activeElement)) {
      section.querySelector<HTMLElement>("[data-ai-heading]")?.focus();
    }
  }

  /** Hands the question to the widget; when it cannot take it, says so under the button. */
  private followUp(button: HTMLElement): void {
    const state = this.controller.state;
    if (state.kind !== "answer") return;
    const took = askFollowUp(
      this.win as unknown as AiModeWindow,
      followUpText(this.request.query, state.answer),
    );
    const foot = button.parentElement;
    foot?.querySelector("[data-ai-follow-up-failed]")?.remove();
    if (took || !foot) return;
    const note = element(this.doc, "p", "ai-overview__error", FOLLOW_UP_FAILED);
    note.setAttribute("role", "status");
    note.setAttribute("data-ai-follow-up-failed", "");
    foot.append(note);
  }
}

// ---------------------------------------------------------------------------
// The toggles
// ---------------------------------------------------------------------------

/** The wrapper a toggle sits in, which carries the ring. */
function fieldOf(toggle: HTMLElement): HTMLElement | null {
  return toggle.closest<HTMLElement>("[data-ai-field]");
}

/** Home's example searches, shown while AI Mode is on: each fills the field and submits it. */
function bindExamples(doc: Document, field: HTMLElement | null): void {
  const form = field?.closest("form");
  const input = field?.querySelector<HTMLInputElement>("input[type=search]");
  for (const button of doc.querySelectorAll<HTMLButtonElement>("[data-ai-try-item]")) {
    button.addEventListener("click", () => {
      if (!input || !form) return;
      input.value = button.textContent?.trim() ?? "";
      form.requestSubmit();
    });
  }
}

export function initAiModeSearch(win: Window, doc: Document): void {
  const toggles = [...doc.querySelectorAll<HTMLButtonElement>("[data-ai-toggle]")];
  if (toggles.length === 0) return;
  const pageWindow = win as unknown as AiModePageWindow;
  const widgetWindow = win as unknown as AiModeWindow;

  whenDocumentReady(
    doc,
    () => {
      const ready = toggles.filter((t) =>
        aiModeSearchAvailable(widgetWindow, t.dataset.aiEndpoint),
      );
      if (ready.length === 0) return;

      const section = doc.querySelector<HTMLElement>("[data-ai-overview]");
      const request = parseOverviewRequest(
        doc.querySelector("script[data-ai-overview-request]")?.textContent,
      );
      const endpoint = ready[0].dataset.aiEndpoint ?? "";
      const panel =
        section && request ? new OverviewPanel(win, doc, section, request, endpoint) : null;

      const apply = (on: boolean) => {
        for (const toggle of ready) {
          toggle.setAttribute("aria-pressed", String(on));
          const field = fieldOf(toggle);
          if (field) field.dataset.ai = on ? "on" : "off";
          const input = field?.querySelector<HTMLInputElement>("input[type=search]");
          if (input?.dataset.aiPlaceholder) {
            input.dataset.aiPlaceholderOff ??= input.placeholder;
            input.placeholder = on
              ? input.dataset.aiPlaceholder
              : (input.dataset.aiPlaceholderOff ?? "");
          }
          const label = field?.querySelector<HTMLElement>("[data-ai-label]");
          if (label?.dataset.aiLabel) {
            label.dataset.aiLabelOff ??= label.textContent ?? "";
            label.textContent = on ? label.dataset.aiLabel : (label.dataset.aiLabelOff ?? "");
          }
          syncAiInput(doc, toggle, on);
          if (toggle.hasAttribute("data-ai-links")) carryAiOnLinks(doc, on);
        }
        for (const row of doc.querySelectorAll<HTMLElement>("[data-ai-try]")) row.hidden = !on;
        for (const note of doc.querySelectorAll<HTMLElement>("[data-ai-note]")) note.hidden = !on;
        for (const note of doc.querySelectorAll<HTMLElement>("[data-ai-disclosure]")) {
          note.hidden = !on;
        }
        panel?.setOn(on);
      };

      for (const toggle of ready) {
        toggle.hidden = false;
        const field = fieldOf(toggle);
        if (field) field.dataset.aiReady = "";
        toggle.addEventListener("click", () => {
          const on = toggle.getAttribute("aria-pressed") !== "true";
          setAiModeSearch(pageWindow, on);
          apply(on);
        });
      }
      bindExamples(doc, fieldOf(ready[0]));
      apply(initialAiModeSearch(pageWindow));
    },
    win as unknown as AiModeLoadTarget,
  );
}
