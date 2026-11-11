import { afterEach, describe, expect, it, vi } from "vitest";
import RESPONSE from "../../test/fixtures/osa-overview-response.json";
import {
  FOLLOW_UP_FAILED,
  FOLLOW_UP_LABEL,
  OverviewController,
  type OverviewPanelState,
  PANEL_FOOTNOTE,
  RETRY_LABEL,
  SEED_MAX_CHARS,
  overviewFailureKind,
  panelView,
  seedText,
} from "./ai-overview-panel";
import {
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

  it("leaves out the follow-up where the widget cannot seed, and shows it otherwise", () => {
    expect(panelView({ kind: "answer", answer: ANSWER }, true).followUp).toBe(FOLLOW_UP_LABEL);
    expect(panelView({ kind: "answer", answer: ANSWER }, false).followUp).toBeNull();
    // Nothing else about the answer changes.
    const without = panelView({ kind: "answer", answer: ANSWER }, false);
    expect(without.summary).toEqual(ANSWER.segments);
    expect(without.picks).toHaveLength(1);
    expect(without.footnote).toBe(PANEL_FOOTNOTE);
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

  it("shows nothing for a search under three words or a 422: the line under the field says why", () => {
    for (const kind of ["too_short", "refused"] as const) {
      const view = panelView({ kind });
      // Not in the page at all: no heading, no note, nothing to announce or retry.
      expect(view).toEqual(panelView({ kind: "off" }));
      expect(view.visible).toBe(false);
      expect(view.status).toBe("");
      expect(view.error).toBeNull();
      expect(view).not.toHaveProperty("note");
    }
  });

  it("gives every state a distinct view, the hidden ones apart", () => {
    const states = [
      panelView({ kind: "off" }),
      panelView({ kind: "loading", reading: 10 }),
      panelView({ kind: "answer", answer: ANSWER }),
      panelView({ kind: "error", error: "server" }),
    ];
    expect(new Set(states.map((s) => JSON.stringify(s))).size).toBe(4);
  });
});

describe("seedText", () => {
  const ORIGIN = "https://test.nemar.org";
  const link = (id: string, origin = ORIGIN) => `[${id}](${origin}/dataset/${id})`;
  /** An overview whose summary is `sentences` and whose picks carry `reason`. */
  function answerOf(sentences: string[], picks = 3, reason = "r", ids = ["a1", "a2", "a3"]) {
    return parseOverviewResponse(
      {
        summary: [...sentences.map((text) => ({ text: `${text} ` })), { dataset_id: ids[0] }],
        picks: ids.slice(0, picks).map((id) => ({ id, reason })),
      },
      ids,
    );
  }
  /** Every `[` opens a whole link: nothing was cut inside one. */
  const wholeLinks = (text: string) =>
    (text.match(/\[/g) ?? []).length === (text.match(/\[[^\]]*\]\([^)\s]+\)/g) ?? []).length;

  it("reads as a message of its own: the search, the summary with linked ids, and the picks", () => {
    expect(seedText("face recognition", ANSWER, ORIGIN)).toBe(
      [
        '**AI overview** for "face recognition"',
        `For event-related potentials to faces, ${link("on002718")} is the closest match: 18 participants viewed famous and scrambled faces.`,
        `**Top picks**\n1. ${link("on002718")}: Face conditions, HED events.`,
      ].join("\n\n"),
    );
  });

  it("starts with the AI overview line, whatever the search holds", () => {
    expect(seedText("face recognition", ANSWER, ORIGIN).split("\n")[0]).toBe(
      '**AI overview** for "face recognition"',
    );
    // Markdown characters become spaces, so the words are quoted and nothing is formatted.
    const head = seedText(
      "*bold* [x](https://e.example) `c` _u_ #h <b> ~s~ a|b !",
      ANSWER,
      ORIGIN,
    ).split("\n")[0];
    // The address in it is broken too (`https://` reads `https `), so the widget cannot link it.
    expect(head).toBe('**AI overview** for "bold x https e.example c u h b s a b"');
    expect(head.slice('**AI overview** for "'.length)).not.toMatch(/[\\`*_[\]()<>#~|!]/);
    // Newlines and runs of white space are one space, so it stays one line.
    expect(seedText("face\nrecognition\r\n\t  EEG", ANSWER, ORIGIN).split("\n")[0]).toBe(
      '**AI overview** for "face recognition EEG"',
    );
    // Nothing left to quote: the line is the bold words alone.
    expect(seedText(" *_* ", ANSWER, ORIGIN).split("\n")[0]).toBe("**AI overview**");
    // A search at OSA's limit is quoted whole; longer is cut, so the head cannot eat the room.
    const longest = "x".repeat(300);
    expect(seedText(longest, ANSWER, ORIGIN)).toContain(`"${longest}"`);
    expect(seedText("x".repeat(500), ANSWER, ORIGIN).split("\n")[0]).toBe(
      `**AI overview** for "${"x".repeat(299)}…"`,
    );
  });

  it("does not cut a long search of astral characters between a pair's halves", () => {
    // Each is two code units, and two letters in front put the cut at 299 units between a pair's halves.
    const head = seedText(`ab${"\u{1F9E0}".repeat(400)}`, ANSWER, ORIGIN).split("\n")[0];
    expect(head.endsWith('…"')).toBe(true);
    expect(head).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(head).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(head.length).toBeLessThanOrEqual(`**AI overview** for ""`.length + 300);
  });

  it("links each dataset id on the page's own origin with the site's dataset path", () => {
    const text = seedText("a b c", answerOf(["Close match:"], 2, "why"), ORIGIN);
    expect(text).toContain(`Close match: ${link("a1")}`);
    expect(text).toContain(`1. ${link("a1")}: why\n2. ${link("a2")}: why`);
    // Every link is the helper's path under the origin, absolute (the widget draws http and https).
    for (const [, href] of text.matchAll(/\]\(([^)]*)\)/g)) {
      expect(href).toMatch(/^https:\/\/test\.nemar\.org\/dataset\/a\d$/);
    }
    // A trailing slash on the origin, or http (a local server), still gives one clean address.
    expect(seedText("a b c", ANSWER, "https://test.nemar.org/")).toContain(
      "(https://test.nemar.org/dataset/on002718)",
    );
    expect(seedText("a b c", ANSWER, "http://localhost:4321")).toContain(
      "(http://localhost:4321/dataset/on002718)",
    );
    // An origin that is not one (a file page has `null`) leaves the id as plain text, no link.
    const plain = seedText("a b c", ANSWER, "null");
    expect(plain).toContain("faces, on002718 is the closest match");
    expect(plain).not.toContain("](");
  });

  it("keeps an id's own punctuation and percent-encodes what the address needs", () => {
    const ids = ["ds.002718_v2-a", "x y"];
    const answer = parseOverviewResponse(
      { summary: [{ text: "see " }, { dataset_id: ids[0] }], picks: [{ id: ids[0], reason: "" }] },
      ids,
    );
    expect(seedText("a b c", answer, ORIGIN)).toContain(
      `[ds.002718_v2-a](${ORIGIN}/dataset/ds.002718_v2-a)`,
    );
  });

  it("neutralises emphasis and a block marker that opens the summary", () => {
    for (const lead of ["# ", "> ", "- ", "+ ", "1. ", "12) ", "## > "]) {
      const answer = parseOverviewResponse(
        {
          summary: [
            { text: `${lead}Big heading and _emph_ and ~~gone~~ text ` },
            { dataset_id: "a1" },
          ],
          picks: [{ id: "a1", reason: "a _b_ ~c~" }],
        },
        ["a1"],
      );
      const lines = seedText("faces", answer, ORIGIN).split("\n");
      // The summary is the third line (head, blank, summary) and starts with a word.
      expect(lines[2]).toMatch(/^Big heading and emph and gone text /);
      expect(lines[2]).not.toMatch(/[_~]/);
      expect(lines[5]).toBe(`1. ${link("a1")}: a b c`);
    }
  });

  it("lets neither the prose, a pick's reason nor the search make a link of its own", () => {
    const answer = parseOverviewResponse(
      {
        summary: [
          { text: "Read [this](https://evil.example/x) and ![img](https://evil.example/i.png), " },
          {
            text: "or <https://evil2.example> and http://evil3.example/p and HTTPS://EVIL4.example. ",
          },
          { text: "**bold** `code` \\ and *italic* " },
          { dataset_id: "a1" },
        ],
        picks: [
          {
            id: "a1",
            reason: "see [here](https://evil.example/y), https://evil5.example/z and *more*",
          },
        ],
      },
      ["a1"],
    );
    const text = seedText(
      "https://evil6.example/q [s](http://evil7.example) sleep",
      answer,
      ORIGIN,
    );
    // The widget's own rules: a Markdown link or image, and a bare http(s) address.
    const ownLinks = new RegExp(
      `\\[[^\\]]*\\]\\(${ORIGIN.replace(/\./g, "\\.")}/dataset/a1\\)`,
      "g",
    );
    expect(text.match(ownLinks)).toHaveLength(2);
    const rest = text.replace(ownLinks, "");
    expect(rest).not.toMatch(/https?:\/\//i);
    expect(rest).not.toMatch(/\]\(|!\[/);
    // The only http(s) addresses left in the message are the page's own dataset links.
    const addresses = [...text.matchAll(/(?<!\]\()https?:\/\/[^\s)]+/gi)];
    expect(addresses).toHaveLength(0);
    for (const [, href] of text.matchAll(/\]\(([^)]*)\)/g)) {
      expect(href).toMatch(/^https:\/\/test\.nemar\.org\/dataset\/a1$/);
    }
    expect(text).not.toMatch(/`|\\|\*italic\*|\*\*bold\*\*/);
    // The words are still there, so the sentences read.
    expect(text).toContain("evil.example/x");
    expect(wholeLinks(text)).toBe(true);
  });

  it("has no picks block when the panel shows no picks", () => {
    const answer = parseOverviewResponse(
      { summary: [{ text: "Nothing close. " }, { dataset_id: "a1" }] },
      ["a1"],
    );
    const text = seedText("a b c", answer, ORIGIN);
    expect(text).not.toContain("Top picks");
    expect(text.endsWith(link("a1"))).toBe(true);
  });

  it("is at most 2000 characters, the most OSA's seed takes", () => {
    expect(SEED_MAX_CHARS).toBe(2000);
    for (const size of [0, 5, 50, 100, 150, 400, 1000, 1900, 1990, 2500, 8000]) {
      for (const picks of [0, 1, 3]) {
        for (const reason of ["", "short", "reason ".repeat(60)]) {
          const answer = answerOf(
            ["Some words here."].concat(
              Array(size ? Math.ceil(size / 17) : 0).fill("Some words here."),
            ),
            picks,
            reason,
          );
          const text = seedText("q ".repeat(150), answer, ORIGIN);
          expect(text.length, `${size}/${picks}/${reason.length}`).toBeLessThanOrEqual(2000);
          expect(wholeLinks(text), `${size}/${picks}/${reason.length}`).toBe(true);
        }
      }
    }
  });

  it("counts characters the way the widget does, in UTF-16 code units", () => {
    // Each of these is two code units: Array.from would count 1000 and miss that the text is 2000+.
    const emoji = parseOverviewResponse(
      { summary: [{ text: "\u{1F9E0}".repeat(1500) }, { dataset_id: "a1" }] },
      ["a1"],
    );
    const text = seedText("a b c", emoji, ORIGIN);
    expect(text.length).toBeLessThanOrEqual(2000);
    // No half of a pair is left at the cut.
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("shortens in order: the picks' reasons first, then the picks, then the summary at a sentence", () => {
    const reason = "Because it has the conditions and events you asked about. ".repeat(6);
    // 1. Everything fits only without the reasons.
    const middle = answerOf(Array(40).fill("A sentence of the overview."), 3, reason);
    const full = seedText("a b c", middle, ORIGIN);
    expect(full).toContain("**Top picks**");
    expect(full).not.toContain("Because it has");
    expect(full).toContain(`1. ${link("a1")}\n2. ${link("a2")}\n3. ${link("a3")}`);
    expect(full.length).toBeLessThanOrEqual(2000);
    // With a short reason, nothing is dropped.
    const kept = seedText("a b c", answerOf(["A sentence of the overview."], 3, "why"), ORIGIN);
    expect(kept).toContain(`1. ${link("a1")}: why`);
    // 2. The picks go when the summary alone nearly fills the message.
    const long = answerOf(Array(66).fill("A sentence of the overview."), 3, "why");
    const noPicks = seedText("a b c", long, ORIGIN);
    expect(noPicks).not.toContain("Top picks");
    expect(noPicks.length).toBeLessThanOrEqual(2000);
    // The whole summary is still there.
    expect(noPicks.split("A sentence of the overview.").length - 1).toBe(66);
    // 3. A summary too long even alone is cut at a sentence, never in a word, with no ellipsis.
    const huge = answerOf(Array(200).fill("A sentence of the overview."), 3, "why");
    const cut = seedText("a b c", huge, ORIGIN);
    expect(cut.length).toBeLessThanOrEqual(2000);
    expect(cut).not.toContain("Top picks");
    expect(cut.endsWith("A sentence of the overview.")).toBe(true);
    expect(cut).not.toContain("…");
    expect(cut.length).toBeGreaterThan(2000 - 40);
  });

  it("cuts one unbroken run at a character with an ellipsis, and never inside a link", () => {
    const run = parseOverviewResponse(
      { summary: [{ text: "x".repeat(3000) }, { dataset_id: "a1" }] },
      ["a1"],
    );
    const cut = seedText("a b c", run, ORIGIN);
    expect(cut.length).toBeLessThanOrEqual(2000);
    expect(cut.endsWith("…")).toBe(true);
    expect(wholeLinks(cut)).toBe(true);
    // A link right at the limit is dropped whole rather than cut.
    for (let pad = 1900; pad < 1990; pad += 3) {
      const edge = parseOverviewResponse(
        {
          summary: [{ text: `${"x".repeat(pad)} ` }, { dataset_id: "a1" }, { text: " tail words" }],
        },
        ["a1"],
      );
      const text = seedText("a b c", edge, ORIGIN);
      expect(text.length, `pad ${pad}`).toBeLessThanOrEqual(2000);
      expect(wholeLinks(text), `pad ${pad}`).toBe(true);
    }
  });

  it("says nothing that resembles a question the reader did not ask", () => {
    const text = seedText("face recognition", ANSWER, ORIGIN);
    expect(text).not.toMatch(/I searched|NEMAR for|Can you help|\?/);
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

  it("sends no request under three words and keeps the panel hidden, again after off and on", async () => {
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

  it("keeps the panel hidden, not an error, when the endpoint answers 422", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "query too short" }), {
        status: 422,
      })) as unknown as typeof fetch;
    const { controller, kinds } = build();
    await controller.setOn(true);
    expect(kinds()).toEqual(["loading", "refused"]);
    expect(controller.answer).toBeNull();
    // Still logged, so a server whose count disagrees is not only a quiet line.
    expect(String(warn.mock.calls[0].join(" "))).toMatch(/invalid.*422/);
    expect(panelView(controller.state).error).toBeNull();
    expect(panelView(controller.state).visible).toBe(false);
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
