import { describe, expect, it } from "vitest";
import citedFixture from "../../test/fixtures/catalog-sort-citations.json";
import newestFixture from "../../test/fixtures/catalog-sort-newest.json";
import {
  citationDashboardUrl,
  latestDatasets,
  mostCited,
  parseCatalogTimestamp,
} from "./highlights";
import type { Dataset } from "./types";

// Captured from api.nemar.org on 2026-09-29 (`/datasets?limit=8&sort=...`).
const cited = citedFixture.datasets as unknown as Dataset[];
const newest = newestFixture.datasets as unknown as Dataset[];

describe("parseCatalogTimestamp", () => {
  it("reads SQLite's zoneless timestamp as UTC", () => {
    expect(parseCatalogTimestamp("2026-09-24 17:52:47")?.toISOString()).toBe(
      "2026-09-24T17:52:47.000Z",
    );
  });

  it("keeps an explicit zone", () => {
    expect(parseCatalogTimestamp("2026-09-24T17:52:47-07:00")?.toISOString()).toBe(
      "2026-09-25T00:52:47.000Z",
    );
  });

  it("returns null for missing or unreadable values", () => {
    expect(parseCatalogTimestamp(null)).toBeNull();
    expect(parseCatalogTimestamp("")).toBeNull();
    expect(parseCatalogTimestamp("yesterday")).toBeNull();
  });
});

describe("citationDashboardUrl", () => {
  it("points at the dataset's page on the dashboard", () => {
    expect(citationDashboardUrl("nm000275")).toBe(
      "https://dashboard.nemar.org/citations/dataset/nm000275/",
    );
  });
});

describe("mostCited", () => {
  it("ranks the captured catalog by citation count, top first", () => {
    const top = mostCited(cited, 5);
    expect(top).toHaveLength(5);
    const counts = top.map((d) => d.citations);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(top[0].share).toBe(1);
    for (const d of top) {
      expect(d.share).toBeGreaterThan(0);
      expect(d.share).toBeLessThanOrEqual(1);
      expect(d.href).toBe(citationDashboardUrl(d.id));
      expect(d.name.length).toBeGreaterThan(0);
    }
  });

  it("re-sorts rows that arrive out of order", () => {
    const shuffled = [...cited].reverse();
    expect(mostCited(shuffled, 3).map((d) => d.id)).toEqual(mostCited(cited, 3).map((d) => d.id));
  });

  it("leaves out datasets with no citations", () => {
    // The newest datasets have not been cited yet.
    const uncited = newest.filter((d) => !d.num_citations);
    expect(uncited.length).toBeGreaterThan(0);
    expect(mostCited(uncited, 5)).toEqual([]);
  });
});

describe("latestDatasets", () => {
  it("keeps the API's newest-first order and links each dataset page", () => {
    const latest = latestDatasets(newest, 5);
    expect(latest.map((d) => d.id)).toEqual(newest.slice(0, 5).map((d) => d.dataset_id));
    for (const d of latest) expect(d.href).toBe(`/dataset/${d.id}`);
  });

  it("dates a never-published dataset by its creation", () => {
    const unpublished = newest.find((d) => !d.first_published_at);
    expect(unpublished).toBeDefined();
    const row = latestDatasets([unpublished as Dataset], 1)[0];
    expect(row.publishedAt?.toISOString()).toBe(
      parseCatalogTimestamp((unpublished as Dataset).created_at)?.toISOString(),
    );
  });

  it("tags the recording modalities, not behavioral or anatomical companions", () => {
    const multi = newest.find((d) => d.modalities === "beh,eeg,emg,motion") as Dataset;
    expect(latestDatasets([multi], 1)[0].modalities).toEqual(["EEG", "EMG", "MOTION"]);
    expect(latestDatasets([{ ...multi, modalities: "beh" }], 1)[0].modalities).toEqual(["BEH"]);
  });

  it("skips OpenNeuro catalog pointers", () => {
    const pointer = {
      ...newest[0],
      id: "ds004504",
      dataset_id: "ds004504",
      source_type: "catalog",
    };
    expect(latestDatasets([pointer, newest[1]], 5).map((d) => d.id)).toEqual([
      newest[1].dataset_id,
    ]);
  });
});
