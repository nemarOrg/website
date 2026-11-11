/**
 * The AI overview panel above Discover's results (board D2, website#518), as a pure function from
 * its state to what it shows, so a unit test can check every state without a DOM. The thin
 * renderer in `./ai-mode-search-client.ts` turns a {@link PanelView} into elements with
 * `textContent`, never `innerHTML`: the overview's words come from a model reading dataset
 * descriptions, and a text segment is plain text whatever it contains.
 */

import {
  type OverviewAnswer,
  type OverviewErrorKind,
  type OverviewPick,
  type OverviewSegment,
  overviewErrorMessage,
} from "./osa-overview";

export type OverviewPanelState =
  | { kind: "off" }
  | { kind: "loading"; reading: number }
  | { kind: "answer"; answer: OverviewAnswer }
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
