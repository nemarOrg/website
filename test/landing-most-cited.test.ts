/**
 * Wiring guard for the front page's "Most cited datasets" card.
 *
 * `src/lib/citation-counts.test.ts` tests the ranking helpers, but nothing
 * there proves the page still uses them. Source-level assertion, as in
 * `test/dataset-card-updated.test.ts`: Astro files have no rendering harness
 * here.
 *
 * What this catches is the card reverting to the catalog's `num_citations`
 * alone, which nemar-cli copies in once a day and which trails the dashboard
 * by most of a day.
 */

import { describe, expect, it } from "vitest";
import INDEX from "../src/pages/index.astro?raw";

describe("landing page most-cited card", () => {
  it("ranks from the dashboard's counts first", () => {
    expect(INDEX).toContain("mostCitedFromDashboard(5,");
  });

  it("still falls back to the catalog ranking", () => {
    expect(INDEX).toMatch(/listDatasets\(\s*\{ sort: "citations", limit: 5 \}/);
  });
});
