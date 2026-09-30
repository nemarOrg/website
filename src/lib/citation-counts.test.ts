import { describe, expect, it } from "vitest";
import manifestFixture from "../../test/fixtures/citation-counts-manifest.json";
import { parseCountsManifest, rankCandidates } from "./citation-counts";

// Captured from dashboard.nemar.org/citations/api/index.json on 2026-09-30
// (the twelve most cited rows and two rows with no counted citation).
const rows = parseCountsManifest(manifestFixture);

describe("parseCountsManifest", () => {
  it("reads every row of the real manifest", () => {
    expect(rows).toHaveLength(manifestFixture.datasets.length);
    expect(rows[0]).toEqual({
      dataset_id: manifestFixture.datasets[0]?.dataset_id,
      num_citations: manifestFixture.datasets[0]?.num_citations,
    });
  });

  it("throws on a body that is not a manifest", () => {
    expect(() => parseCountsManifest(null)).toThrow();
    expect(() => parseCountsManifest({})).toThrow();
    expect(() => parseCountsManifest({ datasets: "no" })).toThrow();
  });

  it("skips a malformed row instead of trusting it", () => {
    const parsed = parseCountsManifest({
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

describe("rankCandidates", () => {
  it("returns the most cited first, at most `limit`", () => {
    const top = rankCandidates(rows, 5);
    expect(top).toHaveLength(5);
    const counts = top.map((r) => r.num_citations);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(top[0]?.dataset_id).toBe("on004504");
  });

  it("leaves out datasets with nothing counted", () => {
    expect(rankCandidates(rows, 100).every((r) => r.num_citations > 0)).toBe(true);
  });

  it("leaves out ids NEMAR does not host", () => {
    const mixed = [
      { dataset_id: "ds004944", num_citations: 999 },
      { dataset_id: "xx099900", num_citations: 998 },
      { dataset_id: "nm000275", num_citations: 67 },
    ];
    expect(rankCandidates(mixed, 5).map((r) => r.dataset_id)).toEqual(["nm000275"]);
  });

  it("breaks a tie by id, whatever the input order", () => {
    const tied = [
      { dataset_id: "on000009", num_citations: 4 },
      { dataset_id: "nm000100", num_citations: 4 },
    ];
    expect(rankCandidates(tied, 5).map((r) => r.dataset_id)).toEqual(["nm000100", "on000009"]);
    expect(rankCandidates([...tied].reverse(), 5).map((r) => r.dataset_id)).toEqual([
      "nm000100",
      "on000009",
    ]);
  });
});
