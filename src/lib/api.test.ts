import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backfillSearchHit,
  getDataset,
  isManagedDatasetId,
  listAllDatasets,
  listDatasets,
  markDegradedUnlessMissing,
  resolveCanonical,
  searchDatasets,
  searchResultToDataset,
} from "./api";
import { UpstreamError } from "./api-cache";
import { type RequestContext, dataWasStale, runWithRequestContext } from "./request-context";
import type { Dataset, SearchResult } from "./types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// A fetch that never settles on its own — it only rejects when its signal
// aborts. This is the failure mode a plain try/catch cannot cover: a
// connection that opens and then never writes a response. These calls run
// during SSR, so without a deadline one hung upstream stalls the render of
// the page a visitor is waiting on rather than degrading it (website#173).
const hangingFetch = ((_url: string, requestInit: RequestInit) =>
  new Promise((_resolve, reject) => {
    requestInit.signal?.addEventListener("abort", () => reject(requestInit.signal?.reason));
  })) as unknown as typeof fetch;

describe("request deadlines", () => {
  // resolveCanonical is the one that matters most: it runs during SSR of
  // every ds* dataset page, which after the apex cutover (website#190) is
  // the path every legacy citation URL travels.
  it("aborts a hung resolveCanonical rather than stalling the render", async () => {
    globalThis.fetch = hangingFetch;
    await expect(resolveCanonical("ds002718", { timeoutMs: 10 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("aborts a hung getDataset", async () => {
    globalThis.fetch = hangingFetch;
    await expect(getDataset("on007964", { timeoutMs: 10 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("aborts a hung listDatasets", async () => {
    globalThis.fetch = hangingFetch;
    await expect(listDatasets({}, { timeoutMs: 10 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("aborts a hung searchDatasets", async () => {
    globalThis.fetch = hangingFetch;
    await expect(searchDatasets("eeg", { timeoutMs: 10 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  // A caller-supplied signal must still abort even though a deadline is also
  // in play — AbortSignal.any() combines them, it doesn't replace one.
  it("honours a caller-supplied signal alongside the deadline", async () => {
    globalThis.fetch = hangingFetch;
    const controller = new AbortController();
    const pending = resolveCanonical("ds002718", { signal: controller.signal });
    controller.abort(new Error("caller went away"));
    await expect(pending).rejects.toThrow("caller went away");
  });
});

describe("resolveCanonical", () => {
  it("returns the canonical id when the catalog has a mirror", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ found: true, dataset_id: "on002718" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    expect(await resolveCanonical("ds002718")).toBe("on002718");
  });

  it("returns null when found is false", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ found: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    expect(await resolveCanonical("ds007222")).toBeNull();
  });

  it("returns null when the endpoint responds non-2xx", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;
    expect(await resolveCanonical("ds002718")).toBeNull();
  });

  it("url-encodes the source id", async () => {
    const captured: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      captured.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ found: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await resolveCanonical("ds 00 27 18");
    expect(captured[0]).toContain("/datasets/resolve/ds%2000%2027%2018");
  });
});

describe("searchDatasets", () => {
  it("builds the /datasets/search URL with q + limit and parses the envelope", async () => {
    const captured: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      captured.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "ds005189",
              name: "Search Superiority Recollection Familiarity",
              modalities: "EEG",
              participants: 30,
              doi: "doi:10.18112/openneuro.ds005189.v1.0.1",
              tasks: "SearchSupRecFam",
              authors: "Jason Helbing",
              score: 0.0325,
              snippet: "…their <mark>memory</mark> of these objects…",
            },
          ],
          count: 1,
          method: "semantic",
          min_score: 0.65,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await searchDatasets("memory", { limit: 240 });
    expect(captured[0]).toContain("/datasets/search?");
    expect(captured[0]).toContain("q=memory");
    expect(captured[0]).toContain("limit=240");
    expect(res.method).toBe("semantic");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].snippet).toContain("<mark>memory</mark>");
  });

  it("sends offset and the server-enforced filters, and omits the unset ones", async () => {
    const captured: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      captured.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({ results: [], count: 0, method: "semantic", min_score: 0.6 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await searchDatasets("eeg", {
      limit: 10,
      offset: 20,
      filters: { license: "public,attribution", has_zarr: true, modality: undefined },
    });
    const sent = new URL(captured[0]).searchParams;
    expect(sent.get("q")).toBe("eeg");
    expect(sent.get("limit")).toBe("10");
    expect(sent.get("offset")).toBe("20");
    expect(sent.get("license")).toBe("public,attribution");
    expect(sent.get("has_zarr")).toBe("true");
    expect(sent.has("modality")).toBe(false);
    expect(sent.has("has_hed")).toBe(false);
    expect(sent.has("sort")).toBe(false);
  });

  it("sends a modality and HED as their own parameters, never folded into the query", async () => {
    const captured: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      captured.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({ results: [], count: 0, method: "semantic", min_score: 0.6 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    await searchDatasets("brain", { filters: { modality: "MEG", has_hed: true } });
    const sent = new URL(captured[0]).searchParams;
    expect(sent.get("q")).toBe("brain");
    expect(sent.get("modality")).toBe("MEG");
    expect(sent.get("has_hed")).toBe("true");
  });

  it("url-encodes the query", async () => {
    const captured: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      captured.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({ results: [], count: 0, method: "semantic", min_score: 0.65 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await searchDatasets("sleep spindles");
    expect(captured[0]).toMatch(/q=sleep[+%]/);
  });

  it("throws on a non-2xx response", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("boom", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(searchDatasets("x")).rejects.toThrow(/search failed/);
  });

  it("throws a clear error when a 2xx body is not valid JSON", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html>gateway timeout</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    await expect(searchDatasets("x")).rejects.toThrow(/invalid response/);
  });
});

describe("backfillSearchHit", () => {
  const hit: SearchResult = {
    id: "on005516",
    name: "Healthy Brain Network (HBN) EEG - Release 11",
    modalities: "eeg",
    participants: 430,
    doi: null,
    tasks: "RestingState,DespicableMe",
    authors: "Seyed Yahya Shirazi",
    score: 0.9,
  };

  function detailRow(over: Partial<Dataset>): Dataset {
    return {
      ...searchResultToDataset(hit),
      description: "Imported from OpenNeuro ds005516",
      file_size: 427_000_000_000,
      num_citations: 1,
      // The /datasets/:id endpoint returns these null even when the catalog has
      // them — the exact bug this helper papers over.
      participants: null as unknown as number,
      latest_version: null,
      ...over,
    };
  }

  it("restores participants from the projection when the detail row is null", () => {
    const merged = backfillSearchHit(detailRow({}), hit);
    expect(merged.participants).toBe(430);
    // Detail-only facts survive the merge.
    expect(merged.description).toBe("Imported from OpenNeuro ds005516");
    expect(merged.num_citations).toBe(1);
    expect(merged.file_size).toBe(427_000_000_000);
  });

  it("keeps the detail row's participants when it has a real value", () => {
    const merged = backfillSearchHit(detailRow({ participants: 18 }), hit);
    expect(merged.participants).toBe(18);
  });

  it("keeps the detail row's latest_version_at so search cards show Updated", () => {
    // Search cards get their release date only through this merge; an explicit
    // field list that forgot it would silently drop "Updated" from every hit.
    const merged = backfillSearchHit(detailRow({ latest_version_at: "2026-09-16 17:22:05" }), hit);
    expect(merged.latest_version_at).toBe("2026-09-16 17:22:05");
  });

  it("backfills modalities/tasks/authors only where the detail row left a gap", () => {
    const merged = backfillSearchHit(
      detailRow({ modalities: "", tasks: "", authors: "Detail Author" }),
      hit,
    );
    expect(merged.modalities).toBe("eeg");
    expect(merged.tasks).toBe("RestingState,DespicableMe");
    expect(merged.authors).toBe("Detail Author");
  });
});

describe("listAllDatasets", () => {
  function listResponse(datasets: Array<{ dataset_id: string }>, total: number, offset: number) {
    return new Response(
      JSON.stringify({ datasets, count: datasets.length, total_count: total, limit: 200, offset }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  it("pages past the 200-row cap and concatenates every row", async () => {
    const offsets: number[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      const offset = Number(u.searchParams.get("offset"));
      offsets.push(offset);
      // 450 rows total across 3 pages (200 + 200 + 50).
      const start = offset;
      const end = Math.min(offset + 200, 450);
      const rows = Array.from({ length: end - start }, (_, i) => ({
        dataset_id: `on${String(start + i).padStart(6, "0")}`,
      }));
      return listResponse(rows, 450, offset);
    }) as unknown as typeof fetch;

    const all = await listAllDatasets({ sort: "newest" });
    expect(all).toHaveLength(450);
    expect(offsets.sort((a, b) => a - b)).toEqual([0, 200, 400]);
  });

  it("de-duplicates rows by id across pages", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      const offset = Number(u.searchParams.get("offset"));
      // Both pages report the same row id -> must collapse to one.
      const rows = offset === 0 ? [{ dataset_id: "on000001" }] : [{ dataset_id: "on000001" }];
      return listResponse(rows, 400, offset);
    }) as unknown as typeof fetch;

    const all = await listAllDatasets();
    expect(all).toHaveLength(1);
    expect(all[0].dataset_id).toBe("on000001");
  });

  it("makes a single request when the first page already holds everything", async () => {
    const calls: number[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      calls.push(Number(u.searchParams.get("offset")));
      return listResponse([{ dataset_id: "on000001" }], 1, 0);
    }) as unknown as typeof fetch;

    const all = await listAllDatasets();
    expect(all).toHaveLength(1);
    expect(calls).toEqual([0]);
  });
});

describe("what the cache is allowed to keep", () => {
  it("refuses a body that is not what an endpoint returns, rather than hand it to a page", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("null", { status: 200 }),
    ) as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(listDatasets({})).rejects.toThrow(/invalid response/);
    await expect(getDataset("nm000001")).rejects.toThrow(/invalid response/);
    await expect(searchDatasets("eeg")).rejects.toThrow(/invalid response/);
  });

  it("accepts the detail endpoint's wrapped and unwrapped shapes", async () => {
    const wrapped = { dataset: { dataset_id: "nm000001", name: "A" } };
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(wrapped), { status: 200 }),
    ) as unknown as typeof fetch;
    expect((await getDataset("nm000001")).name).toBe("A");
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(wrapped.dataset), { status: 200 }),
    ) as unknown as typeof fetch;
    expect((await getDataset("nm000001")).name).toBe("A");
  });
});

describe("what the endpoints accept: the real shape checks", () => {
  const answer = (body: unknown): void => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(body), { status: 200 }),
    ) as unknown as typeof fetch;
  };

  it.each([
    ["an empty object", {}],
    ["an error envelope", { error: "Rate limit exceeded" }],
    ["a list that is not an array", { datasets: {} }],
    ["an array", []],
  ])("refuses %s as a catalog list", async (_name, body) => {
    answer(body);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(listDatasets({})).rejects.toThrow(/invalid response/);
  });

  it.each([
    ["an empty object", {}],
    ["an error envelope", { error: "Search failed" }],
    ["results that are not an array", { results: "none" }],
    ["an array", []],
  ])("refuses %s as search results", async (_name, body) => {
    answer(body);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(searchDatasets("eeg")).rejects.toThrow(/invalid response/);
  });

  it.each([
    ["an empty object", {}],
    ["an error envelope", { error: "Dataset not found" }],
    ["a dataset that is not an object", { dataset: "x" }],
    ["an array", []],
  ])("refuses %s as a dataset", async (_name, body) => {
    answer(body);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(getDataset("nm000001")).rejects.toThrow(/invalid response/);
  });

  it("refuses a search body with no count, which the page prints and pages by", async () => {
    answer({ results: [] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(searchDatasets("eeg")).rejects.toThrow(/invalid response/);
  });

  it("accepts an empty but well-formed list and result set", async () => {
    answer({ datasets: [], total_count: 0 });
    expect((await listDatasets({})).datasets).toEqual([]);
    answer({ results: [], count: 0 });
    expect((await searchDatasets("zzz")).results).toEqual([]);
  });
});

describe("fresh reads, with a cache to read past", () => {
  const row = (id: string) => ({ dataset_id: id, id, name: id });
  const original = (globalThis as { caches?: unknown }).caches;

  function installCache() {
    const entries = new Map<string, Response>();
    (globalThis as { caches?: unknown }).caches = {
      default: {
        async match(request: Request) {
          return entries.get(request.url)?.clone();
        },
        async put(request: Request, response: Response) {
          entries.set(request.url, response);
        },
        async delete(request: Request) {
          return entries.delete(request.url);
        },
      },
    };
    return entries;
  }

  afterEach(() => {
    (globalThis as { caches?: unknown }).caches = original;
  });

  it("getDataset reads past a stored copy, and stores the answer for the next reader", async () => {
    installCache();
    let name = "old";
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify({ dataset: { dataset_id: "nm000001", name } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    expect((await getDataset("nm000001")).name).toBe("old");
    name = "new";
    expect((await getDataset("nm000001")).name).toBe("old"); // an ordinary read: the stored copy
    expect(calls).toBe(1);
    expect((await getDataset("nm000001", { fresh: true })).name).toBe("new"); // past it
    expect(calls).toBe(2);
    expect((await getDataset("nm000001")).name).toBe("new"); // and the cache is better for it
    expect(calls).toBe(2);
  });

  it("listAllDatasets reads inconsistent pages again past the cache, and the next render finds them consistent", async () => {
    installCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let secondPageReads = 0;
    let calls = 0;
    const page = (ids: string[], total: number) =>
      new Response(
        JSON.stringify({ datasets: ids.map(row), total_count: total, count: ids.length }),
        { status: 200 },
      );
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls++;
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      if (offset === 0)
        return page(
          Array.from({ length: 200 }, (_, i) => `a${i}`),
          201,
        );
      // The first read of the second page comes from an older moment (a smaller
      // catalog); a read made after that is consistent.
      return secondPageReads++ === 0 ? page(["old"], 200) : page(["last"], 201);
    }) as unknown as typeof fetch;

    const first = await listAllDatasets();
    expect(first.map((r) => r.dataset_id)).not.toContain("old");
    expect(first.map((r) => r.dataset_id)).toContain("last");
    const callsAfterFirst = calls;

    // The fresh pages were stored: reading again asks nothing.
    const again = await listAllDatasets();
    expect(again).toHaveLength(first.length);
    expect(calls).toBe(callsAfterFirst);
  });

  it("marks the request stale when the fresh re-read fails and the mixed pages are kept", async () => {
    installCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let offsetZeroReads = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      if (offset === 0) {
        offsetZeroReads++;
        if (offsetZeroReads > 1) return new Response("boom", { status: 503 });
        return new Response(
          JSON.stringify({
            datasets: Array.from({ length: 200 }, (_, i) => row(`a${i}`)),
            total_count: 201,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ datasets: [row("old")], total_count: 200 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const ctx: RequestContext = {};
    const rows = await runWithRequestContext(ctx, () => listAllDatasets());
    expect(rows).toHaveLength(201);
    expect(dataWasStale(ctx)).toBe(true);
  });
});

describe("listAllDatasets: pages from different moments", () => {
  const row = (id: string) => ({ dataset_id: id, id, name: id });
  const page = (ids: string[], total: number) =>
    new Response(
      JSON.stringify({ datasets: ids.map(row), total_count: total, count: ids.length }),
      {
        status: 200,
      },
    );

  it("reads the pages again when they disagree about the catalog's size", async () => {
    const asked: string[] = [];
    // First read: page 2 comes from an older moment (a smaller catalog). Second read: consistent.
    let reads = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset"));
      asked.push(`${reads}:${offset}`);
      if (offset === 0) {
        reads++;
        return page(
          Array.from({ length: 200 }, (_, i) => `a${i}`),
          201,
        );
      }
      return reads === 1 ? page(["old"], 200) : page(["last"], 201);
    }) as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await listAllDatasets();
    expect(rows.map((r) => r.dataset_id)).toContain("last");
    expect(rows.map((r) => r.dataset_id)).not.toContain("old");
    expect(reads).toBe(2);
  });

  it("keeps the mixed pages when the second read fails: a list stitched from two moments beats none", async () => {
    let offsetZeroReads = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      if (offset === 0) {
        offsetZeroReads++;
        if (offsetZeroReads > 1) return new Response("boom", { status: 503 });
        return page(
          Array.from({ length: 200 }, (_, i) => `a${i}`),
          201,
        );
      }
      return page(["old"], 200);
    }) as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = await listAllDatasets();
    expect(rows).toHaveLength(201);
  });

  it("does not read twice when the pages agree", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls++;
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      return offset === 0
        ? page(
            Array.from({ length: 200 }, (_, i) => `a${i}`),
            201,
          )
        : page(["last"], 201);
    }) as unknown as typeof fetch;
    await listAllDatasets();
    expect(calls).toBe(2);
  });
});

describe("isManagedDatasetId", () => {
  it("accepts managed nm*/on*/xx* ids the detail endpoint serves", () => {
    expect(isManagedDatasetId("nm000156")).toBe(true);
    expect(isManagedDatasetId("on002578")).toBe(true);
    // Sandbox, and on staging the exemplar fleet (nemar-cli#1496).
    expect(isManagedDatasetId("xx000001")).toBe(true);
    expect(isManagedDatasetId("xx099904")).toBe(true);
  });

  it("rejects legacy ds* ids (400 at /datasets/:id) and malformed ids", () => {
    expect(isManagedDatasetId("ds005189")).toBe(false);
    expect(isManagedDatasetId("nm123")).toBe(false);
    expect(isManagedDatasetId("xx0999040")).toBe(false);
    expect(isManagedDatasetId("zz000001")).toBe(false);
    expect(isManagedDatasetId("")).toBe(false);
  });
});

describe("searchResultToDataset", () => {
  const hit: SearchResult = {
    id: "on002578",
    name: "Visual Oddball Task",
    modalities: "anat,eeg",
    participants: 2,
    doi: "10.82901/nemar.on002578",
    tasks: "attention",
    authors: "Arnaud Delorme, Scott Makeig",
    score: 1,
    snippet: "…<mark>oddball</mark>…",
  };

  it("projects a search hit into a full Dataset shape", () => {
    const d = searchResultToDataset(hit);
    expect(d.id).toBe("on002578");
    expect(d.dataset_id).toBe("on002578");
    expect(d.name).toBe("Visual Oddball Task");
    expect(d.modalities).toBe("anat,eeg");
    expect(d.participants).toBe(2);
    expect(d.authors).toBe("Arnaud Delorme, Scott Makeig");
    expect(d.doi).toBe("10.82901/nemar.on002578");
  });

  it("fills detail-only facts with card-tolerant null-ish defaults", () => {
    const d = searchResultToDataset(hit);
    expect(d.file_size).toBe(0);
    expect(d.latest_version).toBeNull();
    expect(d.updated_at).toBe("");
    expect(d.description).toBeNull();
    // license omitted -> license filtering stays inactive for search rows
    expect(d.license).toBeUndefined();
  });
});

describe("listAllDatasets: shortfall, pause, and budget", () => {
  const row = (id: string) => ({ dataset_id: id, id, name: id });
  const pageOf = (ids: string[], total: number) =>
    new Response(
      JSON.stringify({ datasets: ids.map(row), total_count: total, count: ids.length }),
      {
        status: 200,
      },
    );
  const ctxStale = async (run: () => Promise<unknown>) => {
    const ctx: RequestContext = {};
    await runWithRequestContext(ctx, run);
    return dataWasStale(ctx);
  };

  it("marks the request stale and says so when the pages fall well short of the reported size", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The catalog reports 858 rows; the later pages come back empty.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      return offset === 0
        ? pageOf(
            Array.from({ length: 200 }, (_, i) => `a${i}`),
            858,
          )
        : pageOf([], 858);
    }) as unknown as typeof fetch;
    expect(await ctxStale(() => listAllDatasets())).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("expected about 858"))).toBe(true);
  });

  it("does not mark a read whose pages add up", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      return offset === 0
        ? pageOf(
            Array.from({ length: 200 }, (_, i) => `a${i}`),
            201,
          )
        : pageOf(["last"], 201);
    }) as unknown as typeof fetch;
    expect(await ctxStale(() => listAllDatasets())).toBe(false);
  });

  it("does not read again when the time is already spent, and keeps the mixed pages short-lived", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const budget = new AbortController();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls++;
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      if (offset === 0)
        return pageOf(
          Array.from({ length: 200 }, (_, i) => `a${i}`),
          201,
        );
      budget.abort(); // the time runs out while the second page is read
      return pageOf(["old"], 200);
    }) as unknown as typeof fetch;
    const stale = await ctxStale(() => listAllDatasets({}, { signal: budget.signal }));
    expect(stale).toBe(true);
    expect(calls).toBe(2); // no third and fourth call for a re-read
  });
});

describe("markDegradedUnlessMissing", () => {
  const marks = (err: unknown): boolean => {
    const ctx: RequestContext = {};
    runWithRequestContext(ctx, () => markDegradedUnlessMissing(err));
    return dataWasStale(ctx);
  };

  it.each([404, 410])("does not mark a page for a %i: the row is simply not there", (status) => {
    expect(marks(new UpstreamError("gone", status))).toBe(false);
  });

  it.each([
    ["a 429", new UpstreamError("busy", 429)],
    ["a 503", new UpstreamError("down", 503)],
    ["a 403", new UpstreamError("blocked", 403)],
    [
      "a 400, which a validated id can only get from something broken",
      new UpstreamError("bad", 400),
    ],
    ["a network error", new TypeError("fetch failed")],
    ["a timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" })],
  ])("marks a page for %s: the page is rendering without data it could not fetch", (_name, err) => {
    expect(marks(err)).toBe(true);
  });
});
