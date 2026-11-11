import { describe, expect, it } from "vitest";
import RESPONSE from "../../test/fixtures/osa-overview-response.json";
import {
  FOLLOW_UP_LABEL,
  FOLLOW_UP_MAX_CHARS,
  PANEL_FOOTNOTE,
  RETRY_LABEL,
  followUpText,
  panelView,
  summaryText,
} from "./ai-overview-panel";
import { type OverviewAnswer, overviewErrorMessage, parseOverviewResponse } from "./osa-overview";

const ANSWER: OverviewAnswer = parseOverviewResponse(RESPONSE, ["on002718"]);

describe("panelView", () => {
  it("is not in the page when AI Mode is off", () => {
    const view = panelView({ kind: "off" });
    expect(view.visible).toBe(false);
    expect(view.busy).toBe(false);
    expect(view.status).toBe("");
    expect(view.summary).toEqual([]);
    expect(view.error).toBeNull();
  });

  it("is busy with placeholders and says how many matches it reads while loading", () => {
    const view = panelView({ kind: "loading", reading: 10 });
    expect(view.visible).toBe(true);
    expect(view.busy).toBe(true);
    expect(view.skeleton).toBe(true);
    expect(view.status).toBe("Reading the top 10 matches…");
    expect(view.statusVisible).toBe(true);
    expect(view.summary).toEqual([]);
    expect(view.followUp).toBeNull();
    expect(panelView({ kind: "loading", reading: 1 }).status).toBe("Reading the top 1 match…");
    expect(panelView({ kind: "loading", reading: 0 }).status).toBe("Reading the matches…");
  });

  it("shows the summary, the picks as links, the footnote and the follow-up for an answer", () => {
    const view = panelView({ kind: "answer", answer: ANSWER });
    expect(view.visible).toBe(true);
    expect(view.busy).toBe(false);
    expect(view.skeleton).toBe(false);
    expect(view.badge).toBe("Experimental");
    expect(view.summary).toEqual(ANSWER.segments);
    expect(view.summary.filter((s) => s.kind === "dataset")).toEqual([
      { kind: "dataset", id: "on002718", href: "/dataset/on002718" },
    ]);
    expect(view.picks).toEqual([
      { id: "on002718", href: "/dataset/on002718", reason: "Face conditions, HED events." },
    ]);
    expect(view.footnote).toBe(PANEL_FOOTNOTE);
    expect(view.footnote).toContain("Written by AI from these search results");
    expect(view.followUp).toBe(FOLLOW_UP_LABEL);
    expect(view.error).toBeNull();
  });

  it("shows at most three picks, each a link to /dataset/<id>", () => {
    const ids = ["a1", "a2", "a3", "a4"];
    const answer = parseOverviewResponse(
      {
        summary: [{ text: "x " }, { dataset_id: "a1" }],
        picks: ids.map((id) => ({ id, reason: "r" })),
      },
      ids,
    );
    const view = panelView({ kind: "answer", answer });
    expect(view.picks.map((p) => p.href)).toEqual(["/dataset/a1", "/dataset/a2", "/dataset/a3"]);
  });

  it("shows the error's words and Try again for a failure, and none of the answer", () => {
    for (const kind of ["rate_limited", "network", "bad_response", "upstream"] as const) {
      const view = panelView({ kind: "error", error: kind });
      expect(view.visible).toBe(true);
      expect(view.busy).toBe(false);
      expect(view.error).toEqual({ message: overviewErrorMessage(kind), retry: RETRY_LABEL });
      expect(view.status).toBe(overviewErrorMessage(kind));
      expect(view.summary).toEqual([]);
      expect(view.picks).toEqual([]);
      expect(view.followUp).toBeNull();
      expect(view.footnote).toBeNull();
    }
    expect(RETRY_LABEL).toBe("Try again");
  });

  it("gives every state a distinct view", () => {
    const states = [
      panelView({ kind: "off" }),
      panelView({ kind: "loading", reading: 10 }),
      panelView({ kind: "answer", answer: ANSWER }),
      panelView({ kind: "error", error: "server" }),
    ];
    expect(new Set(states.map((s) => JSON.stringify(s))).size).toBe(4);
  });
});

describe("followUpText", () => {
  it("names the query and quotes the overview", () => {
    const text = followUpText("face recognition", ANSWER);
    expect(text).toContain('"face recognition"');
    expect(text).toContain(summaryText(ANSWER));
    expect(summaryText(ANSWER)).toBe(
      "For event-related potentials to faces, on002718 is the closest match: 18 participants viewed famous and scrambled faces.",
    );
  });

  it("is at most 1500 characters however long the overview is", () => {
    const long = parseOverviewResponse(
      { summary: [{ text: "word ".repeat(1000) }, { dataset_id: "on002718" }] },
      ["on002718"],
    );
    const text = followUpText("q".repeat(300), long);
    expect(Array.from(text).length).toBeLessThanOrEqual(FOLLOW_UP_MAX_CHARS);
    expect(text).toContain("…");
    expect(text.endsWith("before I use one?")).toBe(true);
  });
});
