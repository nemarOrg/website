/**
 * Wiring guard for the front page's "Most cited datasets" card.
 *
 * `src/lib/citation-counts.test.ts` tests the ranking, but nothing there
 * proves the page still uses it. Source-level assertion, as in
 * `test/dataset-card-updated.test.ts`: Astro files have no rendering harness
 * here.
 *
 * What this catches is the card going back to the catalog's `num_citations`
 * alone, which nemar-cli copies in once a day and which trails the dashboard
 * by most of a day; and a fallback render being cached as if it were complete,
 * which would pin the stale card at the edge for half a day.
 */

import { describe, expect, it } from "vitest";
import INDEX from "../src/pages/index.astro?raw";

/** Drop comments so the assertions read code, not the prose explaining it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("landing page most-cited card", () => {
  const code = withoutComments(INDEX);

  it("reads the dashboard's counts", () => {
    expect(code).toContain("fetchCountsManifest(");
    expect(code).toMatch(/mostCitedRows\(\s*catalog,\s*manifest,\s*5\s*\)/);
  });

  it("does not let a failed dashboard read fail the card", () => {
    // The manifest read is caught and becomes null, which mostCitedRows
    // answers with the catalog ranking.
    expect(code).toMatch(/fetchCountsManifest\([^)]*\)\s*\.catch\(/);
  });

  it("shares the catalog download with the hero stats", () => {
    expect(code.match(/fetchHostedRows\(/g)).toHaveLength(1);
    expect(code).toContain("aggregateHostedStats(await catalogPending)");
  });

  it("gives a render that fell back to the catalog counts the short cache window", () => {
    expect(code).toMatch(/citedFromCatalog\s*=\s*!result\.fromDashboard/);
    expect(code).toMatch(/!citedFromCatalog/);
  });
});
