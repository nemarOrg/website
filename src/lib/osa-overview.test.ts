import { afterEach, describe, expect, it, vi } from "vitest";
import SUGGESTION from "../../test/fixtures/osa-overview-response-suggestion.json";
import RESPONSE from "../../test/fixtures/osa-overview-response.json";
import SEARCH from "../../test/fixtures/search-corrected-query.json";
import { type FilterState, defaultFilterState } from "./filters";
import {
  AI_MODE_HINT,
  OVERVIEW_ENDPOINTS,
  OVERVIEW_LIMITS,
  OVERVIEW_MIN_WORDS,
  OVERVIEW_TIMEOUT_MS,
  OverviewError,
  type OverviewRequest,
  PICKS_MAX,
  PICK_TITLE_MAX,
  buildOverviewRequest,
  countQueryWords,
  hitDescription,
  overviewEndpoint,
  overviewErrorMessage,
  overviewFilters,
  overviewRequestForPage,
  parseOverviewRequest,
  parseOverviewResponse,
  queryHasEnoughWords,
  requestOverview,
  resolveOverviewEndpoint,
  sanitizeOverviewFilters,
  snippetText,
} from "./osa-overview";

const DEV = "https://develop-widget.osc.earth/osa/nemar/overview";
const PROD = "https://widget.osc.earth/osa/nemar/overview";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("countQueryWords", () => {
  it("is three words at least, as OSA requires", () => {
    expect(OVERVIEW_MIN_WORDS).toBe(3);
  });

  it.each([
    ["EEG", 1],
    ["P300 speller", 2],
    ["face recognition EEG", 3],
    ["  sleep   spindles  in children ", 4],
    ["EEG - MEG", 2],
    ["α-band power", 2],
    ["naïve listeners", 2],
    ["EEG & MEG", 2],
    ["", 0],
    ["   ", 0],
    ["- & --", 0],
  ])("counts %j as %i", (query, count) => {
    expect(countQueryWords(query)).toBe(count);
  });

  it("splits on any whitespace, tabs and newlines included", () => {
    expect(countQueryWords("resting\tstate\nEEG")).toBe(3);
  });

  it("lets a search through from three words, not under", () => {
    expect(queryHasEnoughWords("P300 speller")).toBe(false);
    expect(queryHasEnoughWords("face recognition EEG")).toBe(true);
    expect(queryHasEnoughWords("EEG - MEG")).toBe(false);
    expect(queryHasEnoughWords("EEG - MEG data")).toBe(true);
  });

  it("words the rule once, for a short search and for a 422", () => {
    expect(AI_MODE_HINT).toBe("AI Mode is on. Use three or more words to see an AI response.");
    expect(overviewErrorMessage("invalid")).toBe(AI_MODE_HINT);
  });
});

describe("the endpoint setting", () => {
  it("is off when PUBLIC_OSA_OVERVIEW_URL is unset or blank", () => {
    vi.stubEnv("PUBLIC_OSA_OVERVIEW_URL", "");
    expect(overviewEndpoint()).toBeNull();
    expect(resolveOverviewEndpoint()).toEqual({ kind: "disabled" });
    vi.stubEnv("PUBLIC_OSA_OVERVIEW_URL", "   ");
    expect(overviewEndpoint()).toBeNull();
    expect(resolveOverviewEndpoint(undefined)).toEqual({ kind: "disabled" });
    expect(resolveOverviewEndpoint(null)).toEqual({ kind: "disabled" });
  });

  it("is off when PUBLIC_OSA_OVERVIEW_URL is not set at all", () => {
    vi.stubEnv("PUBLIC_OSA_OVERVIEW_URL", undefined);
    expect(overviewEndpoint()).toBeNull();
    expect(resolveOverviewEndpoint()).toEqual({ kind: "disabled" });
  });

  it("accepts exactly the develop and production worker URLs, read from the environment", () => {
    expect([...OVERVIEW_ENDPOINTS]).toEqual([DEV, PROD]);
    for (const url of [DEV, PROD]) {
      vi.stubEnv("PUBLIC_OSA_OVERVIEW_URL", `  ${url}\n`);
      expect(overviewEndpoint()).toBe(url);
      expect(resolveOverviewEndpoint()).toEqual({ kind: "enabled", endpoint: url });
    }
  });

  it("refuses anything else with a reason, and never enables it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = [
      // Not on the CSP until a release adds it; the worker route is not deployed.
      "https://edge.osc.earth/osa/nemar/overview",
      "https://osa-worker-dev.shirazi-10f.workers.dev/nemar/overview",
      "http://develop-widget.osc.earth/osa/nemar/overview",
      `${DEV}/`,
      `${DEV}?x=1`,
      "https://develop-widget.osc.earth/osa",
      "https://develop-widget.osc.earth/osa/hed/overview",
      "not a url",
    ];
    for (const value of refused) {
      const resolved = resolveOverviewEndpoint(value);
      expect(resolved.kind, value).toBe("misconfigured");
      if (resolved.kind === "misconfigured")
        expect(resolved.reason).toContain("PUBLIC_OSA_OVERVIEW_URL");
      expect(overviewEndpoint(value), value).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(refused.length);
  });
});

describe("buildOverviewRequest over the real search response", () => {
  const rows = SEARCH.results.map((r) => ({
    id: r.id,
    title: r.name,
    description: ("snippet" in r ? (r as { snippet: string }).snippet : null) as string | null,
    modalities: r.modalities,
  }));

  it("keeps ranking order, the corrected query and the API's count", () => {
    const request = buildOverviewRequest({
      query: "bilinugual",
      correctedQuery: SEARCH.corrected_query,
      filters: { modality: ["ieeg"] },
      totalCount: SEARCH.count,
      rows,
    });
    expect(request).not.toBeNull();
    expect(request?.query).toBe("bilingual");
    expect(request?.total_count).toBe(7);
    expect(request?.results.map((r) => r.id)).toEqual(SEARCH.results.map((r) => r.id));
    expect(request?.filters).toEqual({ modality: ["ieeg"] });
    for (const row of request?.results ?? []) {
      expect(typeof row.modalities).toBe("string");
      expect(row.title.length).toBeLessThanOrEqual(OVERVIEW_LIMITS.titleMax);
      expect(Array.from(row.description).length).toBeLessThanOrEqual(
        OVERVIEW_LIMITS.descriptionMax,
      );
    }
    // A row with no snippet and no description sends an empty description, not null.
    expect(request?.results[1].description).toBe("");
  });

  it("searches the typed words when the API did not correct them", () => {
    const request = buildOverviewRequest({ query: "  faces  ", totalCount: 3, rows });
    expect(request?.query).toBe("faces");
  });
});

describe("buildOverviewRequest limits", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "on000001",
    title: "A title",
    description: "words",
    modalities: "eeg",
    ...over,
  });

  it("cuts the joined modalities to OSA's 200 characters", () => {
    const many = Array.from({ length: 60 }, (_, i) => `modality${i}`);
    const request = buildOverviewRequest({ query: "q", rows: [row({ modalities: many })] });
    expect(Array.from(request?.results[0].modalities ?? "")).toHaveLength(
      OVERVIEW_LIMITS.modalitiesMax,
    );
  });

  it("joins a list of modalities with ', ' and omits null, undefined and blank ones", () => {
    const request = buildOverviewRequest({
      query: "q",
      rows: [
        row({ id: "a1", modalities: ["eeg", "meg"] }),
        row({ id: "a2", modalities: null }),
        row({ id: "a3", modalities: undefined }),
        row({ id: "a4", modalities: [] }),
        row({ id: "a5", modalities: "ieeg" }),
      ],
    });
    expect(request?.results.map((r) => r.modalities)).toEqual([
      "eeg, meg",
      undefined,
      undefined,
      undefined,
      "ieeg",
    ]);
    expect(request?.results.map((r) => "modalities" in r)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
  });

  it("cuts description to 500 characters and title to 200, counting code points", () => {
    const request = buildOverviewRequest({
      query: "q",
      rows: [
        row({ title: "t".repeat(300), description: "d".repeat(900) }),
        row({ id: "b2", description: "\u{1F9E0}".repeat(600) }),
      ],
    });
    expect(request?.results[0].title).toHaveLength(200);
    expect(request?.results[0].description).toHaveLength(500);
    expect(Array.from(request?.results[1].description ?? "")).toHaveLength(500);
    expect(request?.results[1].description.endsWith("\u{1F9E0}")).toBe(true);
  });

  it("turns a null description into an empty string", () => {
    expect(
      buildOverviewRequest({ query: "q", rows: [row({ description: null })] })?.results[0]
        .description,
    ).toBe("");
  });

  it("sends at most 20 rows, the first acceptable ones, in ranking order", () => {
    expect(OVERVIEW_LIMITS.rowsMax).toBe(20);
    const many = Array.from({ length: 26 }, (_, i) =>
      row({ id: `on${String(i).padStart(6, "0")}` }),
    );
    const request = buildOverviewRequest({ query: "q", rows: many });
    expect(request?.results).toHaveLength(20);
    expect(request?.results.map((r) => r.id)).toEqual(many.slice(0, 20).map((r) => r.id));
  });

  it("drops rows whose id OSA would refuse, and repeated ids", () => {
    const request = buildOverviewRequest({
      query: "q",
      rows: [
        row({ id: "ok.1_x-2" }),
        row({ id: "-leading" }),
        row({ id: ".dot" }),
        row({ id: "has space" }),
        row({ id: "slash/id" }),
        row({ id: "" }),
        row({ id: `a${"b".repeat(64)}` }),
        row({ id: `a${"b".repeat(63)}` }),
        row({ id: "ok.1_x-2" }),
      ],
    });
    expect(request?.results.map((r) => r.id)).toEqual(["ok.1_x-2", `a${"b".repeat(63)}`]);
  });

  it("has nothing to send when no row or no query is acceptable", () => {
    expect(buildOverviewRequest({ query: "q", rows: [row({ id: "bad id" })] })).toBeNull();
    expect(buildOverviewRequest({ query: "q", rows: [] })).toBeNull();
    expect(buildOverviewRequest({ query: "   ", rows: [row()] })).toBeNull();
  });

  it("trims the query and cuts it to 300 characters", () => {
    expect(buildOverviewRequest({ query: "  face  ", rows: [row()] })?.query).toBe("face");
    const long = buildOverviewRequest({
      query: `${"w".repeat(299)} ${"x".repeat(50)}`,
      rows: [row()],
    });
    expect(long?.query).toHaveLength(299);
    expect(buildOverviewRequest({ query: "q", correctedQuery: "  ", rows: [row()] })?.query).toBe(
      "q",
    );
  });

  it("omits total_count unless it is a count", () => {
    expect(buildOverviewRequest({ query: "q", totalCount: 0, rows: [row()] })?.total_count).toBe(0);
    expect(
      buildOverviewRequest({ query: "q", totalCount: null, rows: [row()] }),
    ).not.toHaveProperty("total_count");
    expect(buildOverviewRequest({ query: "q", totalCount: 2.5, rows: [row()] })).not.toHaveProperty(
      "total_count",
    );
    expect(buildOverviewRequest({ query: "q", totalCount: -1, rows: [row()] })).not.toHaveProperty(
      "total_count",
    );
  });
});

describe("filters", () => {
  it("carries only strings, booleans, integers and string lists", () => {
    expect(
      sanitizeOverviewFilters({
        s: "x",
        b: false,
        i: 3,
        zero: 0,
        list: ["a", "b"],
        none: undefined,
        nul: null,
        float: 1.5,
        nan: Number.NaN,
        mixed: ["a", 1],
        obj: { a: 1 },
        fn: () => 1,
      }),
    ).toEqual({ s: "x", b: false, i: 3, zero: 0, list: ["a", "b"] });
  });

  it("holds every bound OSA answers 422 for: key 100, string 200, list 20 items", () => {
    const kept = sanitizeOverviewFilters({
      ["k".repeat(100)]: "kept key",
      ["k".repeat(101)]: "dropped key",
      long: "x".repeat(250),
      emoji: "😀".repeat(201),
      list: Array.from({ length: 30 }, (_, i) => `item${i}`),
      longList: ["y".repeat(250)],
    });
    expect(Object.keys(kept)).toEqual(["k".repeat(100), "long", "emoji", "list", "longList"]);
    expect(Array.from(kept.long as string)).toHaveLength(OVERVIEW_LIMITS.filterValueMax);
    expect(Array.from(kept.emoji as string)).toHaveLength(OVERVIEW_LIMITS.filterValueMax);
    expect(kept.list).toEqual(Array.from({ length: 20 }, (_, i) => `item${i}`));
    expect(Array.from((kept.longList as string[])[0])).toHaveLength(OVERVIEW_LIMITS.filterValueMax);
  });

  it("keeps at most 20 keys", () => {
    const raw = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const kept = sanitizeOverviewFilters(raw);
    expect(Object.keys(kept)).toHaveLength(20);
    expect(Object.keys(kept)[0]).toBe("k0");
  });

  it("describes the reader's filter state and leaves untouched ones out", () => {
    expect(sanitizeOverviewFilters(overviewFilters(defaultFilterState()))).toEqual({});
    const state: FilterState = {
      ...defaultFilterState(),
      modalities: ["EEG", "MEG"],
      modalityOp: "AND",
      licenseTiers: ["public"],
      participants: { min: 20, max: null },
      hasHed: true,
      hasViewer: true,
    };
    expect(sanitizeOverviewFilters(overviewFilters(state))).toEqual({
      modality: ["EEG", "MEG"],
      modality_op: "AND",
      license: ["public"],
      participants_min: 20,
      has_hed: true,
      has_zarr: true,
    });
  });
});

describe("overviewRequestForPage", () => {
  const cards = [
    {
      // A hydrated row's `id` is a database key; the public id is `dataset_id`.
      dataset: {
        id: "99387",
        dataset_id: "on002718",
        name: "Faces",
        description: "Full description.",
        modalities: "eeg",
      },
      snippet: "ignored <mark>x</mark>",
    },
    {
      dataset: { dataset_id: "ds000117", name: "Source", description: null, modalities: "meg" },
      snippet: "…<mark>face</mark> study…",
    },
    { dataset: { dataset_id: "nm000001", name: "Third", description: "  ", modalities: "eeg" } },
  ];
  const base = { isSearch: true, failed: false, page: 1, query: "face", totalCount: 37, cards };

  it("falls back from the dataset description to the snippet, without its highlight tags", () => {
    const request = overviewRequestForPage(base);
    expect(request?.results.map((r) => r.description)).toEqual([
      "Full description.",
      "…face study…",
      "",
    ]);
    expect(request?.total_count).toBe(37);
  });

  it("removes only the highlight tags from a snippet, never other text shaped like a tag", () => {
    expect(snippetText("a <mark>b</mark> <MARK>c</MARK>")).toBe("a b c");
    expect(snippetText("a < b and c > d")).toBe("a < b and c > d");
    expect(snippetText("p<0.05 in <div>x</div> and <mark>y</mark>")).toBe(
      "p<0.05 in <div>x</div> and y",
    );
    expect(snippetText(undefined)).toBe("");
    const request = overviewRequestForPage({
      ...base,
      cards: [
        {
          dataset: { dataset_id: "ds000117", name: "S", description: null, modalities: "meg" },
          snippet: "effect p<0.05 when a < b and c > d, see <mark>face</mark>",
        },
      ],
    });
    expect(request?.results[0].description).toBe("effect p<0.05 when a < b and c > d, see face");
  });

  it("is null unless a search ran, nothing failed, it is page 1 and cards exist", () => {
    expect(overviewRequestForPage({ ...base, isSearch: false })).toBeNull();
    expect(overviewRequestForPage({ ...base, failed: true })).toBeNull();
    expect(overviewRequestForPage({ ...base, page: 2 })).toBeNull();
    expect(overviewRequestForPage({ ...base, cards: [] })).toBeNull();
  });
});

describe("overviewRequestForPage: the best matches past the page's cards (website#531)", () => {
  // The hits as the search endpoint returns them (the recorded fixture), then more past them.
  const recorded = SEARCH.results.map((r) => ({
    id: r.id,
    name: r.name,
    modalities: r.modalities,
    snippet: r.snippet,
    tasks: r.tasks,
  }));
  const more = Array.from({ length: 22 }, (_, i) => ({
    id: `on${String(900000 + i)}`,
    name: `Dataset ${i}`,
    modalities: "EEG",
    snippet: "",
    tasks: i % 2 === 0 ? "rest,oddball" : "",
  }));
  const hits = [...recorded, ...more];
  const card = (hit: (typeof hits)[number]) => ({
    dataset: {
      dataset_id: hit.id,
      name: hit.name,
      description: `Hydrated description of ${hit.id}.`,
      modalities: hit.modalities,
    },
    snippet: hit.snippet,
  });
  const base = {
    isSearch: true,
    failed: false,
    page: 1,
    query: "bilingual speech eeg",
    totalCount: 240,
  };

  it("reads the cards, then the hits after them, up to 20 in ranking order", () => {
    const request = overviewRequestForPage({ ...base, cards: hits.slice(0, 10).map(card), hits });
    expect(request?.results.map((r) => r.id)).toEqual(hits.slice(0, 20).map((h) => h.id));
    // The cards keep their hydrated description; a hit past them was never hydrated.
    expect(request?.results[0].description).toBe(`Hydrated description of ${hits[0].id}.`);
    expect(request?.results[9].description).toBe(`Hydrated description of ${hits[9].id}.`);
    expect(request?.results[10].title).toBe(hits[10].name);
  });

  it("describes a hit by its snippet without highlights, else its tasks, else nothing", () => {
    const request = overviewRequestForPage({ ...base, cards: [card(hits[0])], hits });
    const byId = new Map(request?.results.map((r) => [r.id, r]));
    // A recorded hit with a snippet: the README words, without the <mark> tags.
    const withSnippet = recorded.find((h, i) => i > 0 && (h.snippet ?? "").includes("<mark>"));
    expect(withSnippet).toBeDefined();
    const described = byId.get(withSnippet?.id ?? "")?.description ?? "";
    expect(described).not.toMatch(/<\/?mark>/i);
    expect(described.length).toBeGreaterThan(0);
    expect(hitDescription({ ...more[0], snippet: "" })).toBe("Tasks: rest, oddball");
    expect(hitDescription({ ...more[1], snippet: undefined })).toBe("");
    expect(hitDescription({ ...more[1], tasks: " , ," })).toBe("");
    expect(hitDescription({ ...more[0], snippet: "a <mark>b</mark>" })).toBe("a b");
  });

  it("reads a hit whose snippet or tasks are not strings as having none, never throwing", () => {
    // An unhydrated catalog row may hold null where the type says string.
    const odd = { ...more[0], snippet: null, tasks: null } as unknown as (typeof more)[number];
    expect(hitDescription(odd)).toBe("");
    const listTasks = { ...more[0], snippet: "", tasks: ["rest"] } as unknown as (typeof more)[0];
    expect(hitDescription(listTasks)).toBe("");
    const request = overviewRequestForPage({ ...base, cards: [card(hits[0])], hits: [odd] });
    expect(request?.results.find((r) => r.id === odd.id)?.description).toBe("");
  });

  it("reads a hit that is also a card once, as the card", () => {
    const request = overviewRequestForPage({ ...base, cards: hits.slice(0, 3).map(card), hits });
    const ids = request?.results.map((r) => r.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
    expect(request?.results[2].description).toBe(`Hydrated description of ${hits[2].id}.`);
  });

  it("is the cards alone when the page has no hits to add", () => {
    const request = overviewRequestForPage({ ...base, cards: hits.slice(0, 3).map(card) });
    expect(request?.results).toHaveLength(3);
  });

  it("skips a hit that is not an object and reads a non-string field as empty, never throwing", () => {
    // The catalog may hold null or unexpected fields (AGENTS.md); ranks 11 to 20 are read raw.
    const odd = [
      ...hits.slice(0, 12),
      null,
      "on999999",
      { ...hits[12], name: 42, modalities: 7 },
      { ...hits[13], name: null, modalities: ["EEG", 3, "MEG"] },
      ...hits.slice(14, 30),
    ] as unknown as typeof hits;
    const request = overviewRequestForPage({
      ...base,
      cards: hits.slice(0, 10).map(card),
      hits: odd,
    });
    expect(request).not.toBeNull();
    const ids = request?.results.map((r) => r.id) ?? [];
    expect(ids).toEqual(hits.slice(0, 20).map((h) => h.id));
    const numeric = request?.results.find((r) => r.id === hits[12].id);
    // A name that is not text falls back to the id, and a modality that is not text is left out.
    expect(numeric?.title).toBe(hits[12].id);
    expect(numeric).not.toHaveProperty("modalities");
    expect(request?.results.find((r) => r.id === hits[13].id)?.modalities).toBe("EEG, MEG");
    for (const row of request?.results ?? []) {
      expect(typeof row.title).toBe("string");
      expect(typeof row.description).toBe("string");
    }
  });

  it("skips a card that is not an object or has no dataset", () => {
    const cards = [null, { snippet: "x" }, card(hits[0])] as unknown as ReturnType<typeof card>[];
    const request = overviewRequestForPage({ ...base, cards, hits: hits.slice(0, 2) });
    expect(request?.results.map((r) => r.id)).toEqual([hits[0].id, hits[1].id]);
    expect(request?.results[0].description).toBe(`Hydrated description of ${hits[0].id}.`);
  });

  it("keeps the ranking when a card's hydrated id is unusable", () => {
    // The first card came back with no usable id: its hit keeps its own place, ahead of the
    // hits it outranked, instead of falling in behind the other cards.
    const cards = hits.slice(0, 10).map(card);
    cards[0] = { ...cards[0], dataset: { ...cards[0].dataset, dataset_id: "" } };
    const request = overviewRequestForPage({ ...base, cards, hits });
    expect(request?.results.map((r) => r.id)).toEqual(hits.slice(0, 20).map((h) => h.id));
    // It is read from the search row, since no card stands for it.
    expect(request?.results[0].title).toBe(hits[0].name);
    expect(request?.results[1].description).toBe(`Hydrated description of ${hits[1].id}.`);
  });
});

describe("parseOverviewResponse over an older server's example (no suggestion)", () => {
  it("links dataset ids and keeps text as plain text", () => {
    const answer = parseOverviewResponse(RESPONSE, ["on002718", "ds000117"]);
    // An older server sends no suggestion: the panel shows none, and nothing fails.
    expect(answer.suggestion).toEqual([]);
    expect(answer.segments).toEqual([
      { kind: "text", text: "For event-related potentials to faces, " },
      { kind: "dataset", id: "on002718", href: "/dataset/on002718" },
      {
        kind: "text",
        text: " is the closest match: 18 participants viewed famous and scrambled faces.",
      },
    ]);
    expect(answer.picks).toEqual([
      { id: "on002718", href: "/dataset/on002718", reason: "Face conditions, HED events." },
    ]);
  });

  it("keeps text that looks like markup or a link as text, never as HTML", () => {
    const body = {
      ...RESPONSE,
      summary: [
        { text: '<a href="https://x.example">go</a> see example.xyz ' },
        { dataset_id: "on002718" },
      ],
    };
    const answer = parseOverviewResponse(body, ["on002718"]);
    expect(answer.segments[0]).toEqual({
      kind: "text",
      text: '<a href="https://x.example">go</a> see example.xyz ',
    });
  });

  it("does not read cited_ids, shown or cached: a stray cited id cannot spoil an overview", () => {
    const body = { ...RESPONSE, cited_ids: ["on002718", "ds999999"], shown: "ten", cached: 1 };
    const answer = parseOverviewResponse(body, ["on002718"]);
    expect(answer.segments.length).toBeGreaterThan(0);
    expect(Object.keys(answer).sort()).toEqual(["picks", "segments", "suggestion"]);
  });

  it("treats a cited id the request did not carry as an error, in the summary, picks or suggestion", () => {
    const stranger = { dataset_id: "ds999999" };
    const cases: unknown[] = [
      { ...RESPONSE, summary: [{ text: "See " }, stranger] },
      { ...RESPONSE, picks: [{ id: "ds999999", reason: "r" }] },
      { ...RESPONSE, suggestion: [{ text: "Start with " }, stranger] },
    ];
    for (const body of cases) {
      expect(() => parseOverviewResponse(body, ["on002718"])).toThrowError(OverviewError);
      try {
        parseOverviewResponse(body, ["on002718"]);
      } catch (err) {
        expect((err as OverviewError).kind).toBe("bad_response");
      }
    }
  });

  it("rejects bodies that are not an overview", () => {
    for (const body of [
      null,
      "x",
      [],
      {},
      { summary: [] },
      { summary: [{ nothing: 1 }] },
      { summary: [{ dataset_id: "on002718" }] },
      { ...RESPONSE, picks: "x" },
      { ...RESPONSE, suggestion: "Start with on002718." },
      { ...RESPONSE, suggestion: [{ nothing: 1 }] },
    ]) {
      expect(() => parseOverviewResponse(body, ["on002718"]), JSON.stringify(body)).toThrowError(
        OverviewError,
      );
    }
  });

  it("keeps at most ten picks", () => {
    expect(PICKS_MAX).toBe(10);
    const ids = Array.from({ length: 12 }, (_, i) => `a${i + 1}`);
    const body = {
      summary: [{ text: "x " }, { dataset_id: "a1" }],
      picks: ids.map((id) => ({ id, reason: "r" })),
    };
    expect(parseOverviewResponse(body, ids).picks.map((p) => p.id)).toEqual(ids.slice(0, 10));
  });
});

describe("parseOverviewResponse over the documented example (website#531)", () => {
  const rows = [
    { id: "on002718", title: "Famous faces EEG" },
    { id: "ds000117", title: "Multisubject, multimodal face processing" },
    { id: "nm000001", title: `Visual oddball: ${"faces and houses ".repeat(10)}` },
  ];

  it("reads a lead-in that names no dataset, the picks with their titles, and the suggestion", () => {
    const answer = parseOverviewResponse(SUGGESTION, rows);
    expect(answer.segments).toEqual([
      {
        kind: "text",
        text: "Your search seems to focus on how the brain responds to faces. I had a look at the top 20 matches, and three look especially promising.",
      },
    ]);
    expect(answer.picks.map((p) => [p.id, p.href, p.title])).toEqual([
      ["on002718", "/dataset/on002718", "Famous faces EEG"],
      ["ds000117", "/dataset/ds000117", "Multisubject, multimodal face processing"],
      ["nm000001", "/dataset/nm000001", expect.stringMatching(/^Visual oddball: faces.*…$/)],
    ]);
    expect(answer.picks[0].reason).toBe(
      "Famous, unfamiliar and scrambled faces with EEG and HED-annotated events.",
    );
    expect(answer.suggestion).toEqual([
      { kind: "text", text: "I'd start with " },
      { kind: "dataset", id: "on002718", href: "/dataset/on002718" },
      {
        kind: "text",
        text: ": its events are already annotated, so face trials are easy to pull out.",
      },
    ]);
  });

  it("cuts a long title to 90 characters with an ellipsis, counting code points", () => {
    const answer = parseOverviewResponse(SUGGESTION, rows);
    const long = answer.picks[2].title ?? "";
    expect(PICK_TITLE_MAX).toBe(90);
    expect(Array.from(long)).toHaveLength(PICK_TITLE_MAX);
    const emoji = parseOverviewResponse(SUGGESTION, [
      { id: "on002718", title: "\u{1F9E0}".repeat(120) },
      "ds000117",
      "nm000001",
    ]);
    expect(Array.from(emoji.picks[0].title ?? "")).toHaveLength(PICK_TITLE_MAX);
    expect(emoji.picks[0].title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("leaves the title out when the caller gave ids only, a blank title, or the id itself", () => {
    const answer = parseOverviewResponse(SUGGESTION, [
      "on002718",
      { id: "ds000117", title: "   " },
      { id: "nm000001" },
    ]);
    expect(answer.picks.map((p) => "title" in p)).toEqual([false, false, false]);
    // buildOverviewRequest sends a row with no name under its id as the title; the chip shows it.
    const request = buildOverviewRequest({
      query: "faces in the brain",
      rows: [
        { id: "on002718", title: null, description: "" },
        { id: "ds000117", title: "Multimodal faces", description: "" },
        { id: "nm000001", title: "", description: "" },
      ],
    });
    expect(request?.results[0].title).toBe("on002718");
    const named = parseOverviewResponse(SUGGESTION, request?.results ?? []);
    expect(named.picks.map((p) => p.title)).toEqual([undefined, "Multimodal faces", undefined]);
  });

  it("shows a suggestion with no words in it as none, rather than failing the overview", () => {
    for (const suggestion of [[], [{ text: "  " }], [{ dataset_id: "on002718" }]]) {
      const answer = parseOverviewResponse({ ...SUGGESTION, suggestion }, rows);
      expect(answer.suggestion, JSON.stringify(suggestion)).toEqual([]);
      expect(answer.picks).toHaveLength(3);
    }
  });

  it("still refuses a lead-in with no words", () => {
    expect(() =>
      parseOverviewResponse({ ...SUGGESTION, summary: [{ dataset_id: "on002718" }] }, rows),
    ).toThrowError(OverviewError);
  });

  it("reads a null suggestion as none, like an absent one", () => {
    const answer = parseOverviewResponse({ ...SUGGESTION, suggestion: null }, rows);
    expect(answer.suggestion).toEqual([]);
    expect(answer.picks).toHaveLength(3);
    // Anything else that is not a list is still a broken answer.
    for (const suggestion of ["Start here.", 5, { text: "x" }]) {
      expect(() => parseOverviewResponse({ ...SUGGESTION, suggestion }, rows)).toThrowError(
        OverviewError,
      );
    }
  });

  it("lists a pick named twice once, where it first appears, and at most ten", () => {
    const repeated = {
      ...SUGGESTION,
      picks: [
        { id: "ds000117", reason: "First." },
        { id: "on002718", reason: "Second." },
        { id: "ds000117", reason: "Again." },
      ],
    };
    const answer = parseOverviewResponse(repeated, rows);
    expect(answer.picks.map((p) => [p.id, p.reason])).toEqual([
      ["ds000117", "First."],
      ["on002718", "Second."],
    ]);
    const ids = Array.from({ length: 12 }, (_, i) => `on${String(800000 + i)}`);
    const many = parseOverviewResponse(
      {
        summary: [{ text: "Lead-in." }],
        // Repeats first, so the cap counts distinct picks, not entries.
        picks: [ids[0], ids[0], ...ids].map((id) => ({ id, reason: "r" })),
      },
      ids,
    );
    expect(many.picks.map((p) => p.id)).toEqual(ids.slice(0, PICKS_MAX));
  });
});

describe("requestOverview", () => {
  const request: OverviewRequest = {
    query: "face",
    filters: {},
    results: [{ id: "on002718", title: "Faces", description: "d", modalities: "eeg" }],
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("POSTs the request as JSON with a timeout signal and returns the answer on 200", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return json(RESPONSE);
    }) as unknown as typeof fetch;
    const answer = await requestOverview(DEV, request);
    expect(
      answer.segments.some((s) => s.kind === "dataset" && s.href === "/dataset/on002718"),
    ).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(DEV);
    expect(seen[0].init.method).toBe("POST");
    expect(new Headers(seen[0].init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(seen[0].init.body))).toEqual(request);
    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("gives each pick the title the request carried for it", async () => {
    const titled: OverviewRequest = {
      query: "faces in the brain",
      filters: {},
      results: [
        { id: "on002718", title: "Famous faces EEG", description: "d" },
        { id: "ds000117", title: "Multimodal faces", description: "d" },
        { id: "nm000001", title: "Faces and houses", description: "d" },
      ],
    };
    globalThis.fetch = (async () => json(SUGGESTION)) as unknown as typeof fetch;
    const answer = await requestOverview(DEV, titled);
    expect(answer.picks.map((p) => p.title)).toEqual([
      "Famous faces EEG",
      "Multimodal faces",
      "Faces and houses",
    ]);
    expect(answer.suggestion.some((s) => s.kind === "dataset" && s.id === "on002718")).toBe(true);
  });

  it("gives the call the 30 second default timeout, or the caller's", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    globalThis.fetch = (async () => json(RESPONSE)) as unknown as typeof fetch;
    await requestOverview(DEV, request);
    expect(spy).toHaveBeenLastCalledWith(OVERVIEW_TIMEOUT_MS);
    expect(OVERVIEW_TIMEOUT_MS).toBe(30_000);
    await requestOverview(DEV, request, { timeoutMs: 1234 });
    expect(spy).toHaveBeenLastCalledWith(1234);
  });

  it("still cancels on the caller's signal where AbortSignal.any does not exist", async () => {
    const any = AbortSignal.any;
    // A browser older than AbortSignal.any: the module combines the two signals by hand.
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
    try {
      globalThis.fetch = ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          // Like fetch: a signal that is already aborted rejects at once.
          if (init.signal?.aborted) reject(init.signal.reason);
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })) as unknown as typeof fetch;
      const controller = new AbortController();
      const pending = requestOverview(DEV, request, { signal: controller.signal });
      controller.abort(new Error("reader left"));
      await expect(pending).rejects.toThrow("reader left");
      // An already-aborted caller signal aborts the request at once.
      const done = new AbortController();
      done.abort(new Error("already gone"));
      await expect(requestOverview(DEV, request, { signal: done.signal })).rejects.toThrow(
        "already gone",
      );
      // The deadline still applies.
      await expect(
        requestOverview(DEV, request, { timeoutMs: 10, signal: new AbortController().signal }),
      ).rejects.toMatchObject({ kind: "timeout" });
    } finally {
      Object.defineProperty(AbortSignal, "any", { value: any, configurable: true });
    }
  });

  it("gives an error kind for each documented failure status", async () => {
    const expected: Record<number, string> = {
      403: "forbidden",
      404: "unavailable",
      422: "invalid",
      429: "rate_limited",
      500: "server",
      502: "upstream",
      503: "http",
    };
    for (const [status, kind] of Object.entries(expected)) {
      globalThis.fetch = (async () =>
        json({ detail: "x" }, Number(status))) as unknown as typeof fetch;
      await expect(requestOverview(DEV, request), status).rejects.toMatchObject({
        name: "OverviewError",
        kind,
        status: Number(status),
      });
    }
  });

  it("words a rate limit differently from every other failure", () => {
    const kinds = [
      "forbidden",
      "unavailable",
      "invalid",
      "rate_limited",
      "server",
      "upstream",
      "http",
      "network",
      "timeout",
      "bad_response",
      "unexpected",
    ] as const;
    const messages = kinds.map((k) => overviewErrorMessage(k));
    expect(new Set(messages).size).toBe(kinds.length);
    expect(overviewErrorMessage("rate_limited")).toMatch(/wait/i);
    for (const k of kinds.filter((k) => k !== "rate_limited"))
      expect(overviewErrorMessage(k)).not.toMatch(/wait/i);
  });

  it("gives a network error kind when fetch rejects", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(requestOverview(DEV, request)).rejects.toMatchObject({ kind: "network" });
  });

  it("times out a request that never answers", async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    await expect(requestOverview(DEV, request, { timeoutMs: 10 })).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("rejects with the caller's own abort, not as a failure to show", async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = requestOverview(DEV, request, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.not.toBeInstanceOf(OverviewError);
  });

  it("treats a 200 whose cited ids are not in the request as an error", async () => {
    globalThis.fetch = (async () =>
      json({
        ...RESPONSE,
        summary: [{ text: "See " }, { dataset_id: "ds999999" }],
      })) as unknown as typeof fetch;
    await expect(requestOverview(DEV, request)).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("treats a 200 that is not JSON as an error", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(requestOverview(DEV, request)).rejects.toMatchObject({ kind: "bad_response" });
  });
});

describe("parseOverviewRequest", () => {
  const good = {
    query: "face",
    filters: { modality: ["eeg"] },
    total_count: 3,
    results: [{ id: "on002718", title: "Faces", description: "d", modalities: "eeg" }],
  };

  it("reads the island Discover embeds", () => {
    expect(parseOverviewRequest(JSON.stringify(good))).toEqual(good);
    expect(parseOverviewRequest(JSON.stringify({ ...good, filters: undefined }))?.filters).toEqual(
      {},
    );
  });

  it("is null for a missing island, text that is not JSON, or a shape that is not a request", () => {
    const bad: Array<string | null | undefined> = [
      null,
      undefined,
      "",
      "{not json",
      "null",
      "[]",
      JSON.stringify({ ...good, query: 3 }),
      JSON.stringify({ ...good, query: "  " }),
      JSON.stringify({ ...good, results: [] }),
      JSON.stringify({ ...good, results: "x" }),
      JSON.stringify({ ...good, results: [{ id: 1, title: "t", description: "d" }] }),
      JSON.stringify({ ...good, results: [{ id: "a", title: "t" }] }),
      JSON.stringify({ ...good, results: [null] }),
    ];
    for (const text of bad) expect(parseOverviewRequest(text), String(text)).toBeNull();
  });
});
