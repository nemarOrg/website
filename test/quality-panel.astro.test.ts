/**
 * The per-recording quality panel's server markup (`components/quality/QualityPanel.astro`) and
 * its tab in DatasetTabs, rendered through Astro's container (vitest.astro.config.ts): the
 * Recording quality tab and its panel exist only when the page names a recipe, the panel carries
 * the dataset, version, recipe and data plane the island reads, its tabs follow TABS with the
 * first selected and Other hidden, and without script it says it needs it.
 */

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import DatasetTabs from "../src/components/DatasetTabs.astro";
import { TABS } from "../src/lib/quality-views/panel-model";

const container = await AstroContainer.create();
const render = (props: Record<string, unknown>) =>
  container.renderToString(DatasetTabs, {
    props: { datasetId: "nm000001", version: "v1.0.0", ...props },
  });

describe("the Recording quality tab", () => {
  it("is absent when the page names no recipe", async () => {
    const html = await render({ recordingQuality: null });
    expect(html).not.toContain("Recording quality");
    expect(html).not.toContain("data-quality-panel");
  });

  it("holds the panel's markup, with what the island reads", async () => {
    const html = await render({
      recordingQuality: { recipe: "nemar-ica", dataBase: "https://data.example.invalid" },
    });
    expect(html).toContain(">\n        Recording quality");
    const panel = /<section[^>]*data-quality-panel[^>]*>/.exec(html)?.[0] ?? "";
    expect(panel).toContain('data-id="nm000001"');
    expect(panel).toContain('data-version="v1.0.0"');
    expect(panel).toContain('data-recipe="nemar-ica"');
    expect(panel).toContain('data-base="https://data.example.invalid"');
    const tabs = [...html.matchAll(/<button[^>]*data-qp-tab="([a-z]+)"[^>]*>/g)];
    expect(tabs.map((m) => m[1])).toEqual(TABS.map((t) => t.id));
    expect(tabs[0][0]).toContain('aria-selected="true"');
    expect(tabs[3][0]).toContain("hidden");
    expect(html.match(/data-qp-panel="/g)?.length).toBe(TABS.length);
    expect(html).toContain("need JavaScript");
    // The panel's tab list is its own: the summary's script binds only `.dtabs__list`.
    expect(html).toContain('class="qp__tabs" role="tablist"');
  });

  it("is absent without a version, which the panel needs", async () => {
    const html = await render({
      version: null,
      recordingQuality: { recipe: "nemar-ica", dataBase: "https://data.example.invalid" },
    });
    expect(html).not.toContain("data-quality-panel");
    expect(html).not.toContain("Recording quality");
  });
});
