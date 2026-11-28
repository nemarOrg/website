/**
 * The dataset page's summary tabs (`src/lib/dataset-tabs.ts`): which tab a page loaded with a hash
 * opens. A fresh load of `#quality/<recording>/<view>` must open Recording quality whichever of
 * DatasetTabs' and QualityPanel's scripts runs first. The tab's attribute is pinned by
 * test/quality-panel.astro.test.ts, the browser side by e2e/dataset-tabs-deep-link.spec.ts.
 */

import { describe, expect, it } from "vitest";
import { hashMatches, tabForHash } from "../src/lib/dataset-tabs";
import { HASH_PREFIX } from "../src/lib/quality-views/panel-model";

describe("tabForHash", () => {
  const tabs = [undefined, null, HASH_PREFIX];

  it("opens the tab owning the quality deep link", () => {
    expect(tabForHash(tabs, "#quality")).toBe(2);
    expect(tabForHash(tabs, "#quality/sub-X/eeg/sub-X_task-Y_eeg.edf/icmaps")).toBe(2);
  });

  it("opens nothing for another hash or none", () => {
    expect(tabForHash(tabs, "")).toBe(-1);
    expect(tabForHash(tabs, "#qualityx")).toBe(-1);
    expect(tabForHash(tabs, "#readme")).toBe(-1);
    expect(hashMatches("", "")).toBe(false);
  });
});
