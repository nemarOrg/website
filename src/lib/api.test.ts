import { afterEach, describe, expect, it, vi } from "vitest";
import { isManagedDatasetId, resolveCanonical, searchDatasets, searchResultToDataset } from "./api";
import type { SearchResult } from "./types";

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
