import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backfillSearchHit,
  isManagedDatasetId,
  listAllDatasets,
  resolveCanonical,
  searchDatasets,
  searchResultToDataset,
} from "./api";
import type { Dataset, SearchResult } from "./types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
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

describe("isManagedDatasetId", () => {
  it("accepts managed nm*/on* ids the detail endpoint serves", () => {
    expect(isManagedDatasetId("nm000156")).toBe(true);
    expect(isManagedDatasetId("on002578")).toBe(true);
  });

  it("rejects legacy ds* ids (400 at /datasets/:id) and malformed ids", () => {
    expect(isManagedDatasetId("ds005189")).toBe(false);
    expect(isManagedDatasetId("nm123")).toBe(false);
    expect(isManagedDatasetId("")).toBe(false);
    expect(isManagedDatasetId("xx000001")).toBe(false);
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
