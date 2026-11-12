/**
 * The browser half of the AI Mode toggle in search (website#518 on Discover, #519 on Home): it
 * finds the toggles `AiModeToggle.astro` renders hidden, reveals them once the widget can open,
 * keeps `ai=0` (the off) in the address, the form and the page's own links, and runs the AI overview panel
 * above Discover's results.
 *
 * What is decided in a tested module: the panel's transitions (`OverviewController` in
 * `./ai-overview-panel`: off, on, a kept answer, abort, stale responses, retry, failure kinds), what
 * each state shows (`panelView`), the request, its limits and the answer (`./osa-overview`, among
 * them `parseOverviewRequest`), the preference, the address parameter, the link rewrite
 * (`aiLinkHref`) and the follow-up call (`./osa-ai-mode`). What is not: this file's DOM glue,
 * which turns those results into elements, moves focus back to the panel's heading when a button
 * the reader used is replaced, and keeps the `ai=0` input in the form ({@link syncAiInput}). That
 * part is checked in a browser and by the source guards in `test/ai-mode-search.test.ts`.
 *
 * Nothing here writes markup from a string: the overview's text is set with `textContent` and its
 * ids become anchors whose `href` is built from the tested `/dataset/<id>` helper.
 */

import {
  FOLLOW_UP_FAILED,
  OverviewController,
  type OverviewPanelState,
  type PanelView,
  panelView,
  seedText,
} from "./ai-overview-panel";
import {
  AiHintState,
  type AiHintUpdate,
  type AiModeLoadTarget,
  type AiModePageWindow,
  type AiModeWindow,
  aiLinkHref,
  aiModeSearchAvailable,
  aiModeSeedAvailable,
  initialAiModeSearch,
  seedFollowUp,
  setAiModeSearch,
  whenDocumentReady,
} from "./osa-ai-mode";
import { type OverviewRequest, parseOverviewRequest, requestOverview } from "./osa-overview";

/** Names `ai` in a form the field submits with, so a search, a filter or a sort keeps AI Mode. */
const AI_INPUT = "input[data-ai-input]";

/** Keeps the hidden `ai=0` input of the form the toggle's field submits with. AI Mode is on by
 *  default, so on the form carries nothing (a search then means on) and off carries `ai=0`, which
 *  a search, a filter or a sort keeps, with or without scripts. */
export function syncAiInput(doc: Document, toggle: HTMLElement, on: boolean): void {
  const formId = toggle.dataset.aiForm;
  const form = formId ? doc.getElementById(formId) : toggle.closest("form");
  if (!(form instanceof HTMLFormElement)) return;
  const existing = doc.querySelector<HTMLInputElement>(AI_INPUT);
  if (on) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.value = "0";
    return;
  }
  const input = doc.createElement("input");
  input.type = "hidden";
  input.name = "ai";
  input.value = "0";
  input.setAttribute("data-ai-input", "");
  if (formId) input.setAttribute("form", formId);
  form.append(input);
}

/** Sets `ai=0` on, or takes it off, the page's own /discover links, whose server-rendered hrefs
 *  (cached at the edge for every reader) cannot know the preference. */
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
  // Empty until "Ask a follow-up" fails: a live region that already exists announces a change to
  // its text, one inserted with its text does not.
  if (view.followUp) {
    const failed = element(doc, "p", "ai-overview__error ai-overview__failed");
    failed.setAttribute("role", "status");
    failed.setAttribute("data-ai-follow-up-failed", "");
    body.append(failed);
  }
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
    onState: (state: OverviewPanelState) => void,
  ) {
    this.controller = new OverviewController({
      query: request.query,
      reading: request.results.length,
      fetchOverview: (signal) => requestOverview(endpoint, request, { signal }),
      onState: (state) => {
        this.render(panelView(state, aiModeSeedAvailable(win as unknown as AiModeWindow)));
        onState(state);
      },
    });
  }

  /** Switching off renders synchronously, so a render bug would throw here and skip the rest of
   *  the toggle's steps (the field, the address, the links); it is logged instead. */
  setOn(on: boolean): void {
    try {
      void this.controller.setOn(on);
    } catch (err) {
      console.warn("[ai-overview] the panel could not be updated:", err);
    }
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
        (button) => void this.followUp(button),
        () => void this.controller.retry(),
      );
    }
    // A button the reader used was replaced; keep their place at the panel's heading.
    if (hadFocus && !section.contains(doc.activeElement)) {
      section.querySelector<HTMLElement>("[data-ai-heading]")?.focus();
    }
  }

  /** Seeds the assistant's dialog with the overview, as its own first reply; when the widget cannot
   *  take it (it threw, or its promise rejected), says so under the button. The note is looked up
   *  after the wait, so it is the one in the page now. */
  private async followUp(button: HTMLElement): Promise<void> {
    const state = this.controller.state;
    if (state.kind !== "answer") return;
    const took = await seedFollowUp(
      this.win as unknown as AiModeWindow,
      seedText(this.request.query, state.answer, this.win.location.origin),
    );
    // The status element is in the page from the panel's draw, empty, so its text is announced.
    const note = this.section.querySelector<HTMLElement>("[data-ai-follow-up-failed]");
    if (note) note.textContent = took ? "" : FOLLOW_UP_FAILED;
  }
}

// ---------------------------------------------------------------------------
// The line under the field
// ---------------------------------------------------------------------------

/**
 * The one small line under the search field (website#525), for AI Mode on and a search of one or
 * two words. What decides it is `AiHintState`, from the field's live value, so it follows typing
 * (Home and Discover alike) and, on Discover, starts from the submitted query the field holds.
 * A 422 from the endpoint shows it too ({@link refuse}) until the reader edits the field.
 *
 * The line is a slot that is always in the page (`[data-ai-hint]`, drawn with `visibility`, never
 * `hidden`), so showing it moves nothing. It is `aria-hidden`; the polite live region
 * (`[data-ai-hint-status]`) says it once per appearance, set on the transition only.
 */
class UnderFieldHint {
  private readonly state = new AiHintState();

  constructor(
    private readonly doc: Document,
    private readonly input: HTMLInputElement | null,
  ) {
    input?.addEventListener("input", () => this.apply(this.state.onInput(this.query())));
  }

  setOn(on: boolean): void {
    this.apply(this.state.setOn(on, this.query()));
  }

  /** The endpoint refused `requested` for its length: the line says why, if the field still holds
   *  that search; a refusal that arrives after the reader edited the field is ignored. */
  refuse(requested: string): void {
    this.apply(this.state.refuse(requested, this.query()));
  }

  private query(): string {
    return this.input?.value ?? "";
  }

  private apply({ shown, announcement }: AiHintUpdate): void {
    for (const line of this.doc.querySelectorAll<HTMLElement>("[data-ai-hint]")) {
      line.toggleAttribute("data-ai-visible", shown);
    }
    if (announcement === null) return;
    for (const live of this.doc.querySelectorAll<HTMLElement>("[data-ai-hint-status]")) {
      live.textContent = announcement;
    }
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

  /** What the fields, the Try row and the notes look like for a state. The server renders the on
   *  state for everyone (the page is cached), so this is also what switches an off in. */
  const paint = (all: HTMLButtonElement[], on: boolean) => {
    for (const toggle of all) {
      toggle.setAttribute("aria-pressed", String(on));
      const field = fieldOf(toggle);
      if (field) field.dataset.ai = on ? "on" : "off";
      const input = field?.querySelector<HTMLInputElement>("input[type=search]");
      if (input?.dataset.aiPlaceholder) {
        input.placeholder = on
          ? input.dataset.aiPlaceholder
          : (input.dataset.aiPlaceholderOff ?? "");
      }
      const label = field?.querySelector<HTMLElement>("[data-ai-label]");
      if (label?.dataset.aiLabel) {
        label.textContent = on ? label.dataset.aiLabel : (label.dataset.aiLabelOff ?? "");
      }
    }
    // The Try row and the disclosure are slots that are always laid out (the server renders them
    // whenever the endpoint is set) and drawn with `visibility`, so a switch moves nothing.
    for (const slot of doc.querySelectorAll<HTMLElement>("[data-ai-try], [data-ai-disclosure]")) {
      slot.toggleAttribute("data-ai-visible", on);
    }
    for (const note of doc.querySelectorAll<HTMLElement>("[data-ai-note]")) note.hidden = !on;
  };

  whenDocumentReady(
    doc,
    () => {
      const ready = toggles.filter((t) =>
        aiModeSearchAvailable(widgetWindow, t.dataset.aiEndpoint),
      );
      if (ready.length === 0) {
        // The widget did not load (or is the older one without `open`): the server's on state has
        // nothing behind it, so the fields read as plain search. The slots under the field that
        // were kept for a switch (the line, the Try row, the disclosure) have nothing to show and
        // no toggle to switch them, so they leave the layout instead of staying as blank space;
        // the field does not move, because no toggle is revealed (ADR 0032).
        paint(toggles, false);
        for (const slot of doc.querySelectorAll<HTMLElement>(
          "[data-ai-hint], [data-ai-try], [data-ai-disclosure]",
        )) {
          slot.setAttribute("data-ai-unavailable", "");
        }
        return;
      }

      const section = doc.querySelector<HTMLElement>("[data-ai-overview]");
      const request = parseOverviewRequest(
        doc.querySelector("script[data-ai-overview-request]")?.textContent,
      );
      const endpoint = ready[0].dataset.aiEndpoint ?? "";
      const hint = new UnderFieldHint(
        doc,
        fieldOf(ready[0])?.querySelector<HTMLInputElement>("input[type=search]") ?? null,
      );
      const panel =
        section && request
          ? new OverviewPanel(win, doc, section, request, endpoint, (state) => {
              if (state.kind === "refused") hint.refuse(request.query);
            })
          : null;

      const apply = (on: boolean) => {
        paint(ready, on);
        for (const toggle of ready) {
          syncAiInput(doc, toggle, on);
          if (toggle.hasAttribute("data-ai-links")) carryAiOnLinks(doc, on);
        }
        hint.setOn(on);
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
