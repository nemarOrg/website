/**
 * Wiring guard for the dataset card's "Updated" fact.
 *
 * `formatReleaseDate` is unit-tested in `src/lib/release-date.test.ts`, but
 * nothing there proves the card still calls it. Source-level assertion, as in
 * `test/account-tiers-ui.test.ts`: Astro files have no rendering harness here.
 *
 * What this catches is a revert to `dataset.updated_at`, which any write to the
 * catalog row bumps (an enrichment reindex, a DOI sync), so a catalog-wide
 * sweep would make every card read the day of the sweep.
 */

import { describe, expect, it } from "vitest";
import DATASET_CARD from "../src/components/DatasetCard.astro?raw";

/** Drop comments so the assertions read code, not the prose explaining it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("DatasetCard Updated fact", () => {
  const code = withoutComments(DATASET_CARD);

  it("derives Updated from the latest release date", () => {
    expect(code).toContain("formatReleaseDate(dataset)");
  });

  it("never reads the row's updated_at", () => {
    expect(code).not.toContain("updated_at");
  });
});
