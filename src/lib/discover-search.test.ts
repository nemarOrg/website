import { describe, expect, it } from "vitest";
import { SEARCH_WINDOW, pageSearch, planSearch } from "./discover-search";
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
