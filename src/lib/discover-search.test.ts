import { describe, expect, it } from "vitest";
import fixture from "../../test/fixtures/search-corrected-query.json";
import { SEARCH_WINDOW, correctionNotice, pageSearch, planSearch } from "./discover-search";
import { filterStateFromURL } from "./filters";
import type { DatasetSearchResponse, SearchResult } from "./types";

const hit = (id: string, over: Partial<SearchResult> = {}): SearchResult =>
  ({
    id,
    name: id,
    modalities: "eeg",
    participants: 20,
    authors: "",
    doi: null,
    has_hed: false,
    tasks: "",
    score: 1,
    snippet: "",
    ...over,
  }) as SearchResult;
const answer = (rows: SearchResult[], count: number, ceiling?: number): DatasetSearchResponse =>
  ({
    results: rows,
    count,
    method: "semantic",
    min_score: 0.6,
    candidate_ceiling: ceiling,
  }) as DatasetSearchResponse;
const url = (qs: string) => filterStateFromURL(new URLSearchParams(qs));

describe("planSearch", () => {
  it("lets the endpoint page when only server-enforced filters are set", () => {
    const plan = planSearch(url("q=eeg&license=public&page=3&modality=MEG&has_hed=1"));
    expect(plan).toEqual({
      mode: "server",
      params: {
        limit: 10,
        offset: 20,
        filters: { modality: "MEG", license: "public", has_hed: true, has_zarr: undefined },
      },
    });
  });

  it.each(["p_min=5", "p_max=5", "modality=EEG&modality=MEG"])(
    "reads the best-100 window and pages locally for %s",
    (qs) => {
      const plan = planSearch(url(`q=eeg&page=2&${qs}`));
      expect(plan.mode).toBe("window");
      expect(plan.params.limit).toBe(100);
      expect("offset" in plan.params).toBe(false);
    },
  );

  it("pins the window to the most the endpoint will return", () => {
    // The live API clamps any `limit` over 100, so a larger number only looks bigger.
    expect(SEARCH_WINDOW).toBe(100);
  });

  it.each(["density=high", "es=10-20", "c_min=32", "c_max=64"])(
    "ignores %s while searching: search rows carry no channel facts, and it must not force a window",
    (qs) => {
      const plan = planSearch(url(`q=eeg&page=2&${qs}`));
      expect(plan.mode).toBe("server");
      expect(plan.params).toMatchObject({ limit: 10, offset: 10 });
    },
  );

  it("still uses the window for a range when a channel filter is also stale", () => {
    expect(planSearch(url("q=eeg&density=high&p_min=5")).mode).toBe("window");
  });

  it("honors page_size for the endpoint's own paging", () => {
    expect(planSearch(url("q=eeg&page=2&page_size=25")).params).toMatchObject({
      limit: 25,
      offset: 25,
    });
  });
});

describe("pageSearch: the endpoint pages", () => {
  const state = url("q=eeg&page=2");
  const plan = planSearch(state);

  it("shows the true count with no note when everything is pageable", () => {
    const r = pageSearch(plan, answer([hit("a")], 42, 42), state);
    expect(r).toMatchObject({ totalReturned: 42, pageableTotal: 42, countNote: "" });
  });

  it("stops the pager at candidate_ceiling and says so", () => {
    const r = pageSearch(plan, answer([hit("a")], 754, 317), state);
    expect(r).toMatchObject({
      totalReturned: 754,
      pageableTotal: 317,
      countNote: "showing the best 317",
    });
  });

  it("treats a missing candidate_ceiling as 'all pageable'", () => {
    expect(pageSearch(plan, answer([hit("a")], 30), state)).toMatchObject({
      pageableTotal: 30,
      countNote: "",
    });
  });

  it("is empty and quiet for zero matches", () => {
    expect(pageSearch(plan, answer([], 0, 0), state)).toMatchObject({
      totalReturned: 0,
      pageableTotal: 0,
      countNote: "",
    });
  });
});

describe("pageSearch: client-only filters over the best window", () => {
  it("filters the window as a unit, pages the filtered list, and counts what it kept", () => {
    const state = url("q=eeg&p_min=10&page=2&page_size=2");
    const rows = [5, 11, 12, 13, 3, 14].map((n, i) => hit(`r${i}`, { participants: n }));
    const r = pageSearch(planSearch(state), answer(rows, 400), state);
    expect(r.slice.map((x) => x.id)).toEqual(["r3", "r5"]);
    expect(r).toMatchObject({
      totalReturned: 4,
      pageableTotal: 4,
      countNote: "filtered from the 6 best matches",
    });
  });

  it("has no note when the window held every match", () => {
    const state = url("q=eeg&p_min=10");
    const rows = [hit("a", { participants: 20 })];
    expect(pageSearch(planSearch(state), answer(rows, 1), state).countNote).toBe("");
  });

  it("checks the modality by exact token: an iEEG-only dataset is not an EEG one", () => {
    const state = url("q=brain&modality=EEG&p_min=1");
    const rows = [
      hit("eeg-only", { modalities: "EEG" }),
      hit("both", { modalities: "EEG,iEEG" }),
      hit("ieeg-only", { modalities: "iEEG" }),
    ];
    const r = pageSearch(planSearch(state), answer(rows, 3), state);
    expect(r.slice.map((x) => x.id)).toEqual(["eeg-only", "both"]);
  });

  it("does not let a stale channel filter prune a window by a fact search rows do not carry", () => {
    const state = url("q=eeg&density=high&p_min=1");
    const rows = [hit("a"), hit("b")];
    expect(pageSearch(planSearch(state), answer(rows, 2), state).slice).toHaveLength(2);
  });
});

// A search answer recorded from api.nemar.org for "bilinugual" (test/fixtures).
const typoAnswer = fixture as unknown as DatasetSearchResponse;

describe("correctionNotice", () => {
  it("reads the recorded fixture the way the API shapes it", () => {
    expect(typoAnswer.corrected_query).toBe("bilingual");
    expect(typoAnswer.results.length).toBeGreaterThan(0);
    expect(typoAnswer.count).toBeGreaterThanOrEqual(typoAnswer.returned);
    expect(typeof typoAnswer.method).toBe("string");
  });

  it("gives the corrected words and a link to the original ones, keeping the filters and dropping the page", () => {
    const state = url("q=bilinugual&modality=EEG&license=public&has_hed=1&page=3");
    const notice = correctionNotice(state, typoAnswer);
    expect(notice?.corrected).toBe("bilingual");
    const href = new URL(notice?.originalHref ?? "", "https://nemar.org");
    expect(href.pathname).toBe("/discover");
    expect(href.searchParams.get("q")).toBe("bilinugual");
    expect(href.searchParams.get("exact")).toBe("1");
    expect(href.searchParams.get("modality")).toBe("EEG");
    expect(href.searchParams.get("license")).toBe("public");
    expect(href.searchParams.get("has_hed")).toBe("1");
    expect(href.searchParams.has("page")).toBe(false);
  });

  it("links to a query whose address means the original words, not the corrected ones", () => {
    const state = url("q=bilinugual%20eeg&page=2");
    const href = correctionNotice(state, typoAnswer)?.originalHref ?? "";
    const back = filterStateFromURL(new URL(href, "https://nemar.org").searchParams);
    expect(back.q).toBe("bilinugual eeg");
    expect(back.exact).toBe(true);
    expect(back.page).toBe(1);
  });

  it("is null when the answer carries no correction", () => {
    const { corrected_query: _drop, ...plain } = typoAnswer;
    expect(correctionNotice(url("q=bilinugual"), plain as DatasetSearchResponse)).toBeNull();
    expect(correctionNotice(url("q=eeg"), answer([hit("a")], 1))).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   \t "],
    ["a number", 7],
    ["null", null],
    ["an object", { text: "bilingual" }],
  ])("is null when corrected_query is %s", (_name, value) => {
    const res = { ...typoAnswer, corrected_query: value } as unknown as DatasetSearchResponse;
    expect(correctionNotice(url("q=bilinugual"), res)).toBeNull();
  });

  it.each([
    ["trimmed", "q=sleep+spindles", "sleep spindles"],
    ["spaces collapsed", "q=sleep+++spindles", "sleep spindles"],
    ["case folded", "q=Sleep+SPINDLES", "sleep spindles"],
    ["accents folded", "q=caf%C3%A9+r%C3%AAve", "cafe reve"],
    ["all four at once", "q=++Caf%C3%A9+++R%C3%8AVE+", "cafe reve"],
  ])("is null when the correction is the query once %s", (_name, qs, corrected) => {
    const res = { ...typoAnswer, corrected_query: corrected } as DatasetSearchResponse;
    expect(correctionNotice(url(qs), res)).toBeNull();
  });

  it("is not null when a word really changed", () => {
    const res = { ...typoAnswer, corrected_query: "cafe reve" } as DatasetSearchResponse;
    expect(correctionNotice(url("q=cafe+revee"), res)?.corrected).toBe("cafe reve");
  });

  it("in exact mode keeps the line but offers no link, because the API ignored correct=0", () => {
    const notice = correctionNotice(url("q=bilinugual&exact=1&modality=EEG"), typoAnswer);
    expect(notice).toEqual({ corrected: "bilingual", originalHref: null });
  });

  it("in exact mode says nothing when the API honored correct=0", () => {
    const { corrected_query: _drop, ...plain } = typoAnswer;
    expect(
      correctionNotice(url("q=bilinugual&exact=1"), plain as DatasetSearchResponse),
    ).toBeNull();
  });
});

describe("pageSearch: correction", () => {
  it("rides along when the endpoint pages", () => {
    const state = url("q=bilinugual");
    const r = pageSearch(planSearch(state), typoAnswer, state);
    expect(r.correction?.corrected).toBe("bilingual");
  });

  it("rides along over the window", () => {
    const state = url("q=bilinugual&p_min=1");
    const plan = planSearch(state);
    expect(plan.mode).toBe("window");
    expect(pageSearch(plan, typoAnswer, state).correction?.corrected).toBe("bilingual");
  });

  it("is null when there is none", () => {
    const state = url("q=eeg");
    expect(pageSearch(planSearch(state), answer([hit("a")], 1), state).correction).toBeNull();
    const w = url("q=eeg&p_min=1");
    expect(pageSearch(planSearch(w), answer([hit("a")], 1), w).correction).toBeNull();
  });
});
