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
  type OverviewAnswer,
  OverviewError,
  type OverviewErrorKind,
  type OverviewPick,
  type OverviewSegment,
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
  | { kind: "error"; error: OverviewErrorKind };

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

export function panelView(state: OverviewPanelState): PanelView {
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
        followUp: FOLLOW_UP_LABEL,
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

/** The overview as one line of plain text, ids spelled out. */
export function summaryText(answer: OverviewAnswer): string {
  return answer.segments
    .map((s) => (s.kind === "text" ? s.text : s.id))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** The most the follow-up message may hold; the widget sends it as a question. */
export const FOLLOW_UP_MAX_CHARS = 1500;

/**
 * The message "Ask a follow-up" sends: it names the search and quotes the overview, so the
 * assistant knows what the reader is looking at, and asks for help choosing. At most
 * {@link FOLLOW_UP_MAX_CHARS} characters; the quoted overview is what gives way.
 */
export function followUpText(query: string, answer: OverviewAnswer): string {
  const q = query.replace(/\s+/g, " ").trim();
  const head = `I searched NEMAR for "${q}" and was shown this AI overview of the top results: "`;
  const tail =
    '" Can you help me choose between these datasets, and tell me what to check before I use one?';
  const room = Math.max(0, FOLLOW_UP_MAX_CHARS - head.length - tail.length);
  const overview = Array.from(summaryText(answer));
  const quoted =
    overview.length > room
      ? `${overview
          .slice(0, Math.max(0, room - 1))
          .join("")
          .trimEnd()}…`
      : overview.join("");
  return Array.from(`${head}${quoted}${tail}`).slice(0, FOLLOW_UP_MAX_CHARS).join("");
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
 * nothing); a search under three words makes no request and the panel stays hidden (the line under the
 * field says why). A 422 does the same, since a server may count words differently. A request's result counts only while it is the current one: a response for a request
 * the reader switched off, or replaced, is dropped and never kept. Every failure is logged with
 * its kind (and status, for the service's), so a drifted contract or a bug is not only a message
 * in the panel.
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
