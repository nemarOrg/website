import { afterEach, describe, expect, it, vi } from "vitest";
import RESPONSE from "../../test/fixtures/osa-overview-response.json";
import {
  FOLLOW_UP_FAILED,
  FOLLOW_UP_LABEL,
  FOLLOW_UP_MAX_CHARS,
  OverviewController,
  type OverviewPanelState,
  PANEL_FOOTNOTE,
  RETRY_LABEL,
  followUpText,
  overviewFailureKind,
  panelView,
  summaryText,
} from "./ai-overview-panel";
import {
  OVERVIEW_MIN_WORDS_NOTE,
  type OverviewAnswer,
  OverviewError,
  type OverviewRequest,
  overviewErrorMessage,
  parseOverviewResponse,
  requestOverview,
} from "./osa-overview";

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

  it("shows the three-words note as a note, not a failure: no retry, no error, announced", () => {
    const view = panelView({ kind: "too_short" });
    expect(view.visible).toBe(true);
    expect(view.busy).toBe(false);
    expect(view.skeleton).toBe(false);
    expect(view.note).toBe("AI Mode gives an overview for searches of three words or more.");
    expect(view.note).toBe(OVERVIEW_MIN_WORDS_NOTE);
    // The live region says it; the line beside the heading does not repeat it.
    expect(view.status).toBe(view.note);
    expect(view.statusVisible).toBe(false);
    expect(view.error).toBeNull();
    expect(view.badge).toBeNull();
    expect(view.summary).toEqual([]);
    expect(view.followUp).toBeNull();
    expect(view.footnote).toBeNull();
    for (const state of [
      { kind: "loading", reading: 3 },
      { kind: "answer", answer: ANSWER },
      { kind: "error", error: "server" },
    ] as const) {
      expect(panelView(state).note).toBeNull();
    }
  });

  it("gives every state a distinct view", () => {
    const states = [
      panelView({ kind: "too_short" }),
      panelView({ kind: "off" }),
      panelView({ kind: "loading", reading: 10 }),
      panelView({ kind: "answer", answer: ANSWER }),
      panelView({ kind: "error", error: "server" }),
    ];
    expect(new Set(states.map((s) => JSON.stringify(s))).size).toBe(5);
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

describe("overviewFailureKind", () => {
  it("keeps the service's kind and calls anything else unexpected, not a network failure", () => {
    expect(overviewFailureKind(new OverviewError("rate_limited", 429))).toBe("rate_limited");
    expect(overviewFailureKind(new TypeError("x is not a function"))).toBe("unexpected");
    expect(overviewFailureKind(new DOMException("bad", "HierarchyRequestError"))).toBe(
      "unexpected",
    );
    expect(overviewFailureKind("text")).toBe("unexpected");
    expect(overviewErrorMessage("unexpected")).not.toMatch(/connection/i);
  });

  it("has words for a follow-up the widget could not take", () => {
    expect(FOLLOW_UP_FAILED).toMatch(/assistant/i);
  });
});

describe("OverviewController", () => {
  const ENDPOINT = "https://develop-widget.osc.earth/osa/nemar/overview";
  const request: OverviewRequest = {
    query: "face recognition EEG",
    filters: {},
    results: [{ id: "on002718", title: "Faces", description: "d", modalities: "eeg" }],
  };
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** A fetch the test settles by hand; it ignores the abort signal, like a response already on
   *  the wire when the reader switches AI Mode off. */
  function manualFetch() {
    const pending: Array<(response: Response) => void> = [];
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        pending.push(resolve);
      })) as unknown as typeof fetch;
    return {
      calls: () => pending.length,
      answer: (index: number, status = 200, body: unknown = RESPONSE) =>
        pending[index](new Response(JSON.stringify(body), { status })),
    };
  }

  function build(over: { onState?: (s: OverviewPanelState) => void; query?: string } = {}) {
    const states: OverviewPanelState[] = [];
    const controller = new OverviewController({
      query: over.query ?? request.query,
      reading: request.results.length,
      fetchOverview: (signal) => requestOverview(ENDPOINT, request, { signal }),
      onState: (state) => {
        states.push(state);
        over.onState?.(state);
      },
    });
    return { controller, states, kinds: () => states.map((s) => s.kind) };
  }

  it("sends a request for a search of three words", async () => {
    const wire = manualFetch();
    const { controller, kinds } = build({ query: "face recognition EEG" });
    const pending = controller.setOn(true);
    expect(wire.calls()).toBe(1);
    wire.answer(0);
    await pending;
    expect(kinds()).toEqual(["loading", "answer"]);
  });

  it("sends no request under three words and shows the note, again after off and on", async () => {
    const wire = manualFetch();
    for (const query of ["EEG", "P300 speller", "EEG - MEG", "α-band power", ""]) {
      const { controller, kinds } = build({ query });
      await controller.setOn(true);
      expect(controller.state, query).toEqual({ kind: "too_short" });
      expect(kinds()).toEqual(["too_short"]);
      expect(controller.answer).toBeNull();
      await controller.setOn(false);
      await controller.setOn(true);
      expect(kinds()).toEqual(["too_short", "off", "too_short"]);
    }
    expect(wire.calls()).toBe(0);
  });

  it("shows the same note, not an error, when the endpoint answers 422", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "query too short" }), {
        status: 422,
      })) as unknown as typeof fetch;
    const { controller, kinds } = build();
    await controller.setOn(true);
    expect(kinds()).toEqual(["loading", "too_short"]);
    expect(controller.answer).toBeNull();
    // Still logged, so a server whose count disagrees is not only a quiet note.
    expect(String(warn.mock.calls[0].join(" "))).toMatch(/invalid.*422/);
    expect(panelView(controller.state).error).toBeNull();
  });

  it("loads on the first switch on and shows the answer", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(RESPONSE), { status: 200 })) as unknown as typeof fetch;
    const { controller, states, kinds } = build();
    await controller.setOn(true);
    expect(kinds()).toEqual(["loading", "answer"]);
    expect(states[0]).toEqual({ kind: "loading", reading: 1 });
    expect(controller.answer).not.toBeNull();
  });

  it("does nothing more for a second switch on while a request is running", async () => {
    const wire = manualFetch();
    const { controller, kinds } = build();
    const first = controller.setOn(true);
    await controller.setOn(true);
    expect(wire.calls()).toBe(1);
    wire.answer(0);
    await first;
    expect(kinds()).toEqual(["loading", "answer"]);
  });

  it("aborts a request on switch off and drops its late response", async () => {
    const wire = manualFetch();
    const { controller, kinds } = build();
    const pending = controller.setOn(true);
    await controller.setOn(false);
    expect(controller.state).toEqual({ kind: "off" });
    wire.answer(0);
    await pending;
    expect(kinds()).toEqual(["loading", "off"]);
    expect(controller.answer).toBeNull();
  });

  it("asks again after off and on, and the abandoned response never replaces the new one", async () => {
    const wire = manualFetch();
    const { controller, states } = build();
    const first = controller.setOn(true);
    await controller.setOn(false);
    const second = controller.setOn(true);
    expect(wire.calls()).toBe(2);
    wire.answer(1);
    await second;
    // The first request's response, arriving last, is stale.
    wire.answer(0, 502, { detail: "late" });
    await first;
    expect(controller.state.kind).toBe("answer");
    expect(states.at(-1)?.kind).toBe("answer");
  });

  it("shows the kept answer without a new request when switched off and on again", async () => {
    const wire = manualFetch();
    const { controller, kinds } = build();
    const pending = controller.setOn(true);
    wire.answer(0);
    await pending;
    await controller.setOn(false);
    await controller.setOn(true);
    expect(wire.calls()).toBe(1);
    expect(kinds()).toEqual(["loading", "answer", "off", "answer"]);
  });

  it("shows the failure's kind, logs it, and asks again on retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wire = manualFetch();
    const { controller, states } = build();
    const first = controller.setOn(true);
    wire.answer(0, 429, { detail: "slow down" });
    await first;
    expect(states.at(-1)).toEqual({ kind: "error", error: "rate_limited" });
    expect(controller.answer).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(" "))).toMatch(/rate_limited.*429/);

    const second = controller.retry();
    expect(controller.state.kind).toBe("loading");
    wire.answer(1);
    await second;
    expect(controller.state.kind).toBe("answer");
    expect(controller.answer).not.toBeNull();
  });

  it("logs every kind of failure, with the status for the service's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const status of [403, 404, 500, 502, 503]) {
      globalThis.fetch = (async () => new Response("{}", { status })) as unknown as typeof fetch;
      const { controller } = build();
      await controller.setOn(true);
      expect(controller.state.kind).toBe("error");
    }
    expect(warn).toHaveBeenCalledTimes(5);
    // A 200 that is not an overview names its own kind.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ summary: [] }), { status: 200 })) as unknown as typeof fetch;
    const { controller } = build();
    await controller.setOn(true);
    expect(controller.state).toEqual({ kind: "error", error: "bad_response" });
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it("calls a failure of the page itself unexpected, not a network failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(RESPONSE), { status: 200 })) as unknown as typeof fetch;
    let draws = 0;
    const { controller } = build({
      onState: (state) => {
        // Drawing the answer fails (a bug in the renderer); drawing the error works.
        if (state.kind === "answer" && ++draws === 1) throw new TypeError("render bug");
      },
    });
    await controller.setOn(true);
    expect(controller.state).toEqual({ kind: "error", error: "unexpected" });
    expect(controller.answer).toBeNull();
    expect(warn.mock.calls.some((call) => call.some((x) => x instanceof TypeError))).toBe(true);

    // An answer that failed to draw is asked for again, and this time it draws.
    await controller.retry();
    expect(controller.state.kind).toBe("answer");
  });

  it("does not throw when even the error cannot be drawn", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () => new Response("{}", { status: 502 })) as unknown as typeof fetch;
    const { controller } = build({
      onState: (state) => {
        if (state.kind === "error") throw new Error("cannot draw");
      },
    });
    await expect(controller.setOn(true)).resolves.toBeUndefined();
  });
});
