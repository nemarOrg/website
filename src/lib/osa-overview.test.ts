import { afterEach, describe, expect, it, vi } from "vitest";
import RESPONSE from "../../test/fixtures/osa-overview-response.json";
import SEARCH from "../../test/fixtures/search-corrected-query.json";
import { type FilterState, defaultFilterState } from "./filters";
import {
  OVERVIEW_ENDPOINTS,
  OVERVIEW_LIMITS,
  OverviewError,
  type OverviewRequest,
  buildOverviewRequest,
  overviewEndpoint,
  overviewErrorMessage,
  overviewFilters,
  overviewRequestForPage,
  parseOverviewResponse,
  requestOverview,
  resolveOverviewEndpoint,
  sanitizeOverviewFilters,
} from "./osa-overview";

const DEV = "https://develop-widget.osc.earth/osa/nemar/overview";
const PROD = "https://widget.osc.earth/osa/nemar/overview";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

  it("sends at most 10 rows, the first acceptable ones, in ranking order", () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      row({ id: `on${String(i).padStart(6, "0")}` }),
    );
    const request = buildOverviewRequest({ query: "q", rows: many });
    expect(request?.results).toHaveLength(10);
    expect(request?.results.map((r) => r.id)).toEqual(many.slice(0, 10).map((r) => r.id));
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
      dataset: {
        id: "on002718",
        name: "Faces",
        description: "Full description.",
        modalities: "eeg",
      },
      snippet: "ignored <mark>x</mark>",
    },
    {
      dataset: { id: "ds000117", name: "Source", description: null, modalities: "meg" },
      snippet: "…<mark>face</mark> study…",
    },
    { dataset: { id: "nm000001", name: "Third", description: "  ", modalities: "eeg" } },
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

  it("is null unless a search ran, nothing failed, it is page 1 and cards exist", () => {
    expect(overviewRequestForPage({ ...base, isSearch: false })).toBeNull();
    expect(overviewRequestForPage({ ...base, failed: true })).toBeNull();
    expect(overviewRequestForPage({ ...base, page: 2 })).toBeNull();
    expect(overviewRequestForPage({ ...base, cards: [] })).toBeNull();
  });
});

describe("parseOverviewResponse over the documented example", () => {
  it("links dataset ids and keeps text as plain text", () => {
    const answer = parseOverviewResponse(RESPONSE, ["on002718", "ds000117"]);
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
    expect(answer.citedIds).toEqual(["on002718"]);
    expect(answer.shown).toBe(10);
    expect(answer.cached).toBe(false);
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

  it("treats a cited id the request did not carry as an error, in the summary, picks or cited_ids", () => {
    const stranger = { dataset_id: "ds999999" };
    const cases: unknown[] = [
      { ...RESPONSE, summary: [{ text: "See " }, stranger] },
      { ...RESPONSE, picks: [{ id: "ds999999", reason: "r" }] },
      { ...RESPONSE, cited_ids: ["on002718", "ds999999"] },
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
    ]) {
      expect(() => parseOverviewResponse(body, ["on002718"]), JSON.stringify(body)).toThrowError(
        OverviewError,
      );
    }
  });

  it("keeps at most three picks", () => {
    const ids = ["a1", "a2", "a3", "a4"];
    const body = {
      summary: [{ text: "x " }, { dataset_id: "a1" }],
      picks: ids.map((id) => ({ id, reason: "r" })),
    };
    expect(parseOverviewResponse(body, ids).picks).toHaveLength(3);
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
