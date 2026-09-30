import { describe, expect, it } from "vitest";
import catalogFixture from "../../test/fixtures/catalog-rows-cited.json";
import manifestFixture from "../../test/fixtures/citation-counts-manifest.json";
import { type CountRow, mostCitedRows, parseCountsManifest } from "./citation-counts";
import type { Dataset } from "./types";

// Both captured from production on 2026-09-30: the dashboard's counts manifest
// (its twelve most cited rows and two rows with nothing counted) and the
// catalog rows (api.nemar.org/datasets) of those twelve plus three of the
// catalog's own stale leaders: nm000275 (449 there, 67 on the dashboard),
// on007763 (335 there, absent from the manifest) and on006104.
const manifest = parseCountsManifest(manifestFixture);
const catalog = catalogFixture.datasets as unknown as Dataset[];

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("parseCountsManifest", () => {
  it("reads every row of the real manifest excerpt", () => {
    expect(manifest).toHaveLength(manifestFixture.datasets.length);
    expect(manifest[0]).toEqual({
      dataset_id: manifestFixture.datasets[0]?.dataset_id,
      num_citations: manifestFixture.datasets[0]?.num_citations,
    });
  });

  it("throws on a body that is not a counts@1 manifest", () => {
    expect(() => parseCountsManifest(null)).toThrow();
    expect(() => parseCountsManifest({ schema: "nemar-citations/counts@1" })).toThrow();
    expect(() =>
      parseCountsManifest({ schema: "nemar-citations/counts@1", datasets: "no" }),
    ).toThrow();
    expect(() => parseCountsManifest({ datasets: [] })).toThrow();
    expect(() =>
      parseCountsManifest({ schema: "nemar-citations/counts@2", datasets: [] }),
    ).toThrow();
    // An exact match: a prefix would also accept a future counts@10 or counts@1.1.
    expect(() =>
      parseCountsManifest({ schema: "nemar-citations/counts@10", datasets: [] }),
    ).toThrow();
  });

  it("skips a malformed row instead of trusting it", () => {
    const parsed = parseCountsManifest({
      schema: "nemar-citations/counts@1",
      datasets: [
        { dataset_id: "nm000275", num_citations: 67 },
        { dataset_id: "nm000273" },
        { dataset_id: 5, num_citations: 9 },
        { dataset_id: "on000001", num_citations: Number.NaN },
        null,
      ],
    });
    expect(parsed).toEqual([{ dataset_id: "nm000275", num_citations: 67 }]);
  });
});

describe("mostCitedRows", () => {
  it("ranks by the dashboard's counts and names from the catalog rows", () => {
    const { cited, fromDashboard } = mostCitedRows(catalog, manifest, 5);
    expect(fromDashboard).toBe(true);
    expect(ids(cited)).toEqual(["on004504", "on002778", "nm000114", "on003739", "nm000132"]);
    expect(cited.map((c) => c.citations)).toEqual([215, 214, 170, 161, 160]);
    expect(cited[2]?.name).toBe("MDD Patients and Healthy Controls EEG Data");
    expect(cited[0]?.share).toBe(1);
    expect(cited[4]?.share).toBeCloseTo(160 / 215);
  });

  it("ignores the catalog's stale counts for datasets the manifest lacks", () => {
    // nm000275 (449) and on007763 (335) lead the catalog's own ranking but are
    // not in the manifest excerpt: the dashboard no longer counts them.
    const { cited } = mostCitedRows(catalog, manifest, 15);
    expect(ids(cited)).not.toContain("on007763");
    expect(ids(cited)).not.toContain("nm000275");
  });

  it("skips a manifest dataset the catalog does not list and fills from the next", () => {
    // Not public: the catalog rows never contain it, so it cannot reach the card.
    const publicOnly = catalog.filter((d) => d.dataset_id !== "on004504");
    const { cited } = mostCitedRows(publicOnly, manifest, 5);
    expect(ids(cited)).toEqual(["on002778", "nm000114", "on003739", "nm000132", "nm000323"]);
  });

  it("takes the larger count when the manifest lists an id twice", () => {
    const twice: CountRow[] = [
      { dataset_id: "nm000114", num_citations: 170 },
      { dataset_id: "nm000114", num_citations: 3 },
      { dataset_id: "on002778", num_citations: 2 },
    ];
    const { cited } = mostCitedRows(catalog, twice, 5);
    expect(cited.map((c) => [c.id, c.citations])).toEqual([
      ["nm000114", 170],
      ["on002778", 2],
    ]);
  });

  it("leaves out datasets with nothing counted", () => {
    const { cited } = mostCitedRows(
      catalog,
      [{ dataset_id: "nm000114", num_citations: 0 }, ...manifest],
      15,
    );
    expect(cited.every((c) => c.citations > 0)).toBe(true);
  });

  it("falls back to the catalog's own counts when there is no manifest", () => {
    const { cited, fromDashboard } = mostCitedRows(catalog, null, 5);
    expect(fromDashboard).toBe(false);
    expect(ids(cited)[0]).toBe("nm000275");
    expect(cited[0]?.citations).toBe(449);
  });

  it("falls back when the manifest names no dataset the catalog serves", () => {
    // Staging: its catalog holds only exemplars, none of the manifest's ids.
    const elsewhere: CountRow[] = [{ dataset_id: "nm099998", num_citations: 50 }];
    const { cited, fromDashboard } = mostCitedRows(catalog, elsewhere, 5);
    expect(fromDashboard).toBe(false);
    expect(ids(cited)[0]).toBe("nm000275");
  });

  it("never shows a dataset NEMAR does not host", () => {
    const pointer = {
      ...(catalog.find((d) => d.dataset_id === "nm000114") as Dataset),
      source_type: "catalog",
    } as unknown as Dataset;
    const others = catalog.filter((d) => d.dataset_id !== "nm000114");
    const viaDashboard = mostCitedRows([pointer, ...others], manifest, 15);
    const viaCatalog = mostCitedRows([pointer, ...others], null, 15);
    expect(ids(viaDashboard.cited)).not.toContain("nm000114");
    expect(ids(viaCatalog.cited)).not.toContain("nm000114");
  });
  it("joins on the id when a row has no dataset_id of its own", () => {
    const row = catalog.find((d) => d.dataset_id === "nm000114") as Dataset;
    const noDatasetId = { ...row, dataset_id: "" } as Dataset;
    const others = catalog.filter((d) => d.dataset_id !== "nm000114");
    const { cited } = mostCitedRows([noDatasetId, ...others], manifest, 5);
    expect(cited.find((c) => c.id === "nm000114")?.citations).toBe(170);
  });
});
