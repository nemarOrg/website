/**
 * The AI overview panel above Discover's results (board D2, website#518), as a pure function from
 * its state to what it shows, so a unit test can check every state without a DOM. The thin
 * renderer in `./ai-mode-search-client.ts` turns a {@link PanelView} into elements with
 * `textContent`, never `innerHTML`: the overview's words come from a model reading dataset
 * descriptions, and a text segment is plain text whatever it contains.
 *
 * It also holds {@link OverviewController}, the state machine behind the panel: toggling off
 * aborts a request, toggling on again reuses a kept answer, a response the reader no longer wants
 * is dropped, and a failure is logged and classified. It has no DOM and takes the request as a
 * function, so a unit test drives it with real `Response` fixtures.
 */

import {
  OVERVIEW_LIMITS,
  type OverviewAnswer,
  OverviewError,
  type OverviewErrorKind,
  type OverviewPick,
  type OverviewSegment,
  overviewDatasetHref,
  overviewErrorMessage,
  queryHasEnoughWords,
} from "./osa-overview";

export type OverviewPanelState =
  | { kind: "off" }
  | { kind: "loading"; reading: number }
  | { kind: "answer"; answer: OverviewAnswer }
  // The search has fewer than three words: no request was made, and this is not a failure. The
  // panel shows nothing; the line under the search field says why (`aiHintShown`).
  | { kind: "too_short" }
  // The endpoint answered 422 for the search: its word count differs from ours. Same as above.
  | { kind: "refused" }
  // `invalid` is the `refused` state above, never an error shown in the panel.
  | { kind: "error"; error: Exclude<OverviewErrorKind, "invalid"> };

/** What the panel shows for a state. Every field is data; none is markup. */
export interface PanelView {
  /** Whether the panel is in the page at all. */
  visible: boolean;
  /** `aria-busy` on the section: the overview is being written. */
  busy: boolean;
  /** What the live region says (empty when there is nothing to announce). */
  status: string;
  /** Whether that text is also drawn beside the heading; an answer announces itself and draws none. */
  statusVisible: boolean;
  /** The "Experimental" mark beside the heading. */
  badge: string | null;
  /** Grey placeholder lines in place of the text. */
  skeleton: boolean;
  summary: OverviewSegment[];
  picks: OverviewPick[];
  footnote: string | null;
  followUp: string | null;
  error: { message: string; retry: string } | null;
}

export const PANEL_HEADING = "AI overview";
export const PANEL_FOOTNOTE =
  "Written by AI from these search results. Check a dataset before you rely on it.";
export const FOLLOW_UP_LABEL = "Ask a follow-up";
export const RETRY_LABEL = "Try again";

const OFF: PanelView = {
  visible: false,
  busy: false,
  status: "",
  statusVisible: false,
  badge: null,
  skeleton: false,
  summary: [],
  picks: [],
  footnote: null,
  followUp: null,
  error: null,
};

/**
 * What the panel shows for a state. `canFollowUp` is whether the widget on the page has `seed`
 * (`aiModeSeedAvailable`), checked each time the panel is drawn; without it there is no
 * "Ask a follow-up", and nothing stands in for it.
 */
export function panelView(state: OverviewPanelState, canFollowUp = true): PanelView {
  switch (state.kind) {
    case "off":
      return { ...OFF };
    case "loading": {
      const reading =
        state.reading > 0
          ? `Reading the top ${state.reading} ${state.reading === 1 ? "match" : "matches"}…`
          : "Reading the matches…";
      return {
        ...OFF,
        visible: true,
        busy: true,
        status: reading,
        statusVisible: true,
        skeleton: true,
      };
    }
    case "answer":
      return {
        ...OFF,
        visible: true,
        status: "AI overview ready.",
        badge: "Experimental",
        summary: state.answer.segments,
        picks: state.answer.picks,
        footnote: PANEL_FOOTNOTE,
        followUp: canFollowUp ? FOLLOW_UP_LABEL : null,
      };
    // Nothing in the panel: the line under the search field says why (website#525).
    case "too_short":
    case "refused":
      return { ...OFF };
    case "error": {
      const message = overviewErrorMessage(state.error);
      return {
        ...OFF,
        visible: true,
        status: message,
        statusVisible: false,
        error: { message, retry: RETRY_LABEL },
      };
    }
  }
}

/** The most `OSAChatWidget.seed` takes: OSA's `RESEED_TURN_MAX_CHARS`, which it checks as the
 *  text's `length` (UTF-16 code units) and refuses a longer text for. The message built here stays
 *  within it, so it is never refused for its size. */
export const SEED_MAX_CHARS = 2000;

/** What a Markdown renderer reads as markup in a search the reader typed: emphasis, code, links,
 *  images, HTML, headings, tables. Each becomes a space, so what is quoted is the words. A web
 *  address is broken too (see {@link neutralise}). */
const QUERY_MARKDOWN = /[\\`*_[\]()<>#~|!]/g;
/** What turns written prose into a link, an image, emphasis or code in the widget's Markdown. The
 *  overview is a model's text about dataset descriptions, so a link in it would be a link the page
 *  made: each becomes a space, and a sentence stays a sentence. */
const PROSE_MARKDOWN = /[\\`*[\]]/g;
/** A web address: the widget turns any `http://` or `https://` run into a link on its own, with no
 *  Markdown around it. */
const WEB_SCHEME = /\b(https?):\/\//gi;

/** `text` with `markdown` characters blanked and web addresses broken (`https://x` reads
 *  `https x`), so the only links in the message are the page's own dataset links. Both are done
 *  here, for the overview's prose and the typed search alike. */
function neutralise(text: string, markdown: RegExp): string {
  return text.replace(markdown, " ").replace(WEB_SCHEME, "$1 ").replace(/\s+/g, " ");
}

/** `[id](<origin>/dataset/<id>)`: absolute, on the page's own origin, because the widget draws
 *  links to http and https addresses only and the dialog is not part of the page's address space.
 *  An origin that is not one (`null` for a file, say) leaves the id as plain text. */
function datasetLink(id: string, origin: string): string {
  const base = origin.replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+$/.test(base) ? `[${id}](${base}${overviewDatasetHref(id)})` : id;
}

/** The summary as Markdown with each dataset id a link, and where the links are (a cut never lands
 *  inside one). */
function summaryMarkdown(
  answer: OverviewAnswer,
  origin: string,
): { text: string; links: Array<[number, number]> } {
  let text = "";
  const links: Array<[number, number]> = [];
  const append = (piece: string) => {
    const trimmed = text === "" || text.endsWith(" ") ? piece.replace(/^ /, "") : piece;
    text += trimmed;
  };
  for (const segment of answer.segments) {
    if (segment.kind === "text") {
      append(neutralise(segment.text, PROSE_MARKDOWN));
    } else {
      const link = datasetLink(segment.id, origin);
      const start = text.length;
      text += link;
      links.push([start, text.length]);
    }
  }
  return { text: text.trimEnd(), links };
}

/** `text` cut to at most `room` characters: at the last sentence end that fits and is not inside a
 *  link, else at the last space outside one, with an ellipsis. */
function trimSummary(summary: { text: string; links: Array<[number, number]> }, room: number) {
  const { text, links } = summary;
  if (text.length <= room) return text;
  if (room <= 0) return "";
  const inLink = (index: number) => links.some(([from, to]) => index > from && index < to);
  let cut = -1;
  for (const end of text.matchAll(/[.!?](?=\s|$)/g)) {
    const at = end.index + 1;
    if (at <= room && !inLink(at)) cut = at;
  }
  if (cut > 0) return text.slice(0, cut).trimEnd();
  const limit = room - 1;
  let at = text.lastIndexOf(" ", limit);
  while (at > 0 && inLink(at)) at = text.lastIndexOf(" ", at - 1);
  if (at <= 0) {
    // One unbroken run: cut it, and not inside a link.
    const link = links.find(([from, to]) => limit > from && limit < to);
    at = link ? link[0] : limit;
    // Not between the two halves of a character outside the Basic Multilingual Plane.
    if (!link && /[\uD800-\uDBFF]/.test(text[at - 1] ?? "")) at -= 1;
  }
  return `${text.slice(0, at).trimEnd()}…`;
}

/**
 * The message "Ask a follow-up" seeds the assistant's dialog with, in Markdown. The widget shows it
 * as the assistant's own first reply and sends nothing, so it has to read as a message on its own:
 *
 * ```
 * **AI overview** for "<the search>"
 *
 * <the summary, each dataset id a link>
 *
 * **Top picks**
 * 1. [id](<origin>/dataset/<id>): why
 * ```
 *
 * The search is quoted with its Markdown characters and newlines turned to spaces, and neither it
 * nor the overview's prose nor a pick's reason can make a link: a web address in them is broken
 * (`https://x` reads `https x`), so the dataset links are the only ones. At most {@link SEED_MAX_CHARS} characters
 * (`OSAChatWidget.seed` refuses more). When it does not fit, the picks lose their reasons first,
 * then go, and then the summary is cut at a sentence.
 */
export function seedText(query: string, answer: OverviewAnswer, origin: string): string {
  let words = neutralise(query, QUERY_MARKDOWN).trim();
  if (words.length > OVERVIEW_LIMITS.queryMax) {
    let cut = OVERVIEW_LIMITS.queryMax - 1;
    // Not between the two halves of a character outside the Basic Multilingual Plane.
    if (/[\uD800-\uDBFF]/.test(words[cut - 1] ?? "")) cut -= 1;
    words = `${words.slice(0, cut).trimEnd()}…`;
  }
  const head = words === "" ? "**AI overview**" : `**AI overview** for "${words}"`;
  const summary = summaryMarkdown(answer, origin);

  const picks = (reasons: boolean): string => {
    if (answer.picks.length === 0) return "";
    const lines = answer.picks.map((pick, index) => {
      const reason = reasons ? neutralise(pick.reason, PROSE_MARKDOWN).trim() : "";
      return `${index + 1}. ${datasetLink(pick.id, origin)}${reason ? `: ${reason}` : ""}`;
    });
    return `**Top picks**\n${lines.join("\n")}`;
  };
  const compose = (summaryPart: string, picksPart: string) =>
    [head, summaryPart, picksPart].filter((part) => part !== "").join("\n\n");

  for (const picksPart of [picks(true), picks(false)]) {
    const whole = compose(summary.text, picksPart);
    if (whole.length <= SEED_MAX_CHARS) return whole;
  }
  // The picks go; the summary is cut at a sentence to fit under the head and its blank line.
  const room = SEED_MAX_CHARS - head.length - 2;
  return compose(trimSummary(summary, room), "");
}

/** Said under "Ask a follow-up" when the assistant widget could not take the question. */
export const FOLLOW_UP_FAILED =
  "The assistant could not be opened from here. Reload the page and try again.";

/** The kind a failure is shown as: the service's own for an {@link OverviewError}, `unexpected`
 *  for anything else (a bug on this page, which "check your connection" would misdescribe). */
export function overviewFailureKind(err: unknown): OverviewErrorKind {
  return err instanceof OverviewError ? err.kind : "unexpected";
}

/** What the controller needs: how to ask for the overview, and where to show a state. */
export interface OverviewControllerOptions {
  /** The search the overview is written for; under three words, no request is ever made. */
  query: string;
  /** The number of results the overview reads, for the loading line. */
  reading: number;
  /** Asks for the overview; rejects with the signal's own abort error when it is aborted. */
  fetchOverview: (signal: AbortSignal) => Promise<OverviewAnswer>;
  /** Shows a state; may throw, which the controller treats as a failure of the page. */
  onState: (state: OverviewPanelState) => void;
}

/**
 * The panel's transitions. Off: nothing shown, any request aborted, a kept answer remembered.
 * On: the kept answer again if there is one, else a request (a second "on" while one runs does
 * nothing); a search under three words makes no request and the panel stays hidden (the line under
 * the field says why). A 422 does the same, since a server may count words differently. A
 * request's result counts only while it is the current one: a response for a request the reader
 * switched off, or replaced, is dropped and never kept. Every failure is logged with its kind (and
 * status, for the service's), so a drifted contract or a bug is not only a message in the panel.
 */
export class OverviewController {
  private current: OverviewPanelState = { kind: "off" };
  private kept: OverviewAnswer | null = null;
  private abort: AbortController | null = null;

  constructor(private readonly options: OverviewControllerOptions) {}

  get state(): OverviewPanelState {
    return this.current;
  }

  /** The answer kept for a later switch back on, if there is one. */
  get answer(): OverviewAnswer | null {
    return this.kept;
  }

  /** Follows the reader's AI Mode choice; resolves when a request this call started has settled. */
  setOn(on: boolean): Promise<void> {
    if (!on) {
      this.abort?.abort();
      this.abort = null;
      this.show({ kind: "off" });
      return Promise.resolve();
    }
    if (this.current.kind === "loading") return Promise.resolve();
    if (this.kept) {
      this.show({ kind: "answer", answer: this.kept });
      return Promise.resolve();
    }
    return this.load();
  }

  /** "Try again": asks again, replacing a request still running. */
  retry(): Promise<void> {
    return this.load();
  }

  private show(state: OverviewPanelState): void {
    this.current = state;
    this.options.onState(state);
  }

  private async load(): Promise<void> {
    this.abort?.abort();
    this.abort = null;
    if (!queryHasEnoughWords(this.options.query)) {
      this.show({ kind: "too_short" });
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    try {
      this.show({ kind: "loading", reading: this.options.reading });
      const answer = await this.options.fetchOverview(controller.signal);
      if (controller.signal.aborted) return;
      this.show({ kind: "answer", answer });
      // Kept only once it was shown: an answer the page failed to draw is asked for again.
      this.kept = answer;
    } catch (err) {
      if (controller.signal.aborted) return;
      const error = overviewFailureKind(err);
      if (err instanceof OverviewError) {
        console.warn("[ai-overview]", error, err.status ?? "", err.message);
      } else {
        console.warn("[ai-overview] unexpected failure:", err);
      }
      try {
        this.show(error === "invalid" ? { kind: "refused" } : { kind: "error", error });
      } catch (renderErr) {
        console.warn("[ai-overview] the failure could not be shown:", renderErr);
      }
    }
  }
}
