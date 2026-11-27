/**
 * DatasetTabs rendered through Astro's container (vitest.astro.config.ts), once per kind of
 * quality summary the dataset page can hand it: `none` (no Data quality tab, no panel), `refused`
 * (the tab, and a panel holding the refusal sentence) and `shown` (the tab, and a panel holding
 * the summary). The summaries come from fixtures captured from nemar-cli's real metadata route.
 */

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import DatasetTabs from "../src/components/DatasetTabs.astro";
import { type QualitySummary, readQualitySummary } from "../src/lib/quality-views/dataset-summary";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
// biome-ignore lint/suspicious/noExplicitAny: documents are read member by member
type Loose = Record<string, any>;
const documentOf = (name: string): Loose =>
  JSON.parse(
    JSON.parse(
      fs.readFileSync(repoPath(`test/fixtures/quality-summary/metadata-${name}.json`), "utf8"),
    ).text,
  );

const shownDoc = documentOf("spread");
const refusedDoc = documentOf("spread");
refusedDoc.extensions.dataQuality.recipes["nemar-ica"].counts.total = 7;
const SUMMARIES: Record<string, QualitySummary> = {
  none: readQualitySummary(documentOf("canary-only"), "nm099204"),
  refused: readQualitySummary(refusedDoc, refusedDoc.dataset_id),
  shown: readQualitySummary(shownDoc, shownDoc.dataset_id),
};

interface Tag {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
}
/** Every start tag of `html`, with its attributes. */
function tags(html: string): Tag[] {
  return [
    ...html.matchAll(/<([a-z][a-z0-9-]*)((?:\s+[a-z:@][\w:.-]*(?:="[^"]*")?)*)\s*\/?>/gi),
  ].map((m) => ({
    name: m[1].toLowerCase(),
    attrs: Object.fromEntries(
      [...m[2].matchAll(/([a-z:@][\w:.-]*)(?:="([^"]*)")?/gi)].map((a) => [a[1], a[2] ?? ""]),
    ),
  }));
}

async function render(quality: QualitySummary): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(DatasetTabs, {
    props: { datasetId: "nm099202", version: "v1.0.0", quality },
  });
}

describe("DatasetTabs, rendered", () => {
  it("the summaries are the three kinds", () => {
    expect(Object.fromEntries(Object.entries(SUMMARIES).map(([k, v]) => [k, v.kind]))).toEqual({
      none: "none",
      refused: "refused",
      shown: "shown",
    });
  });

  it.each(Object.keys(SUMMARIES))("%s: tabs and panels pair up", async (kind) => {
    const html = await render(SUMMARIES[kind]);
    const all = tags(html);
    const tabs = all.filter((t) => t.attrs.role === "tab");
    const panels = all.filter((t) => t.attrs.role === "tabpanel");
    expect(tabs.length).toBe(kind === "none" ? 1 : 2);
    expect(panels.length).toBe(tabs.length);
    for (const tab of tabs) {
      const panel = panels.find((p) => p.attrs.id === tab.attrs["aria-controls"]);
      expect(panel, tab.attrs.id).toBeDefined();
      expect(panel!.attrs["aria-labelledby"]).toBe(tab.attrs.id);
    }
    const quality = panels.find((p) => p.attrs.id === "dt-nm099202-panel-qa");
    if (kind === "none") {
      expect(quality).toBeUndefined();
      expect(html).not.toContain("Data quality");
      expect(html).not.toContain("qs-summary");
    } else {
      expect(quality).toBeDefined();
      // Demographics is the tab shown first: the Data quality panel starts hidden.
      expect("hidden" in quality!.attrs).toBe(true);
      const tab = tabs.find((t) => t.attrs["aria-controls"] === quality!.attrs.id)!;
      expect(tab.attrs["aria-selected"]).toBe("false");
      expect(tab.attrs.tabindex).toBe("-1");
    }
    expect(html).not.toMatch(/coming soon/i);
  });

  it("refused: the panel holds the sentence and nothing of the summary", async () => {
    const summary = SUMMARIES.refused;
    if (summary.kind !== "refused") throw new Error("refused");
    const html = await render(summary);
    expect(html).toContain(summary.sentence);
    expect(html).not.toContain("<figure");
    expect(html).not.toContain("<table");
  });

  it("shown: the panel holds the summary, a heading per recipe and a figure per metric", async () => {
    const summary = SUMMARIES.shown;
    if (summary.kind !== "shown") throw new Error("shown");
    const html = await render(summary);
    const all = tags(html);
    expect(all.filter((t) => t.name === "h3").length).toBe(summary.recipes.length);
    expect(all.filter((t) => t.name === "figure").length).toBe(summary.recipes[0].metrics.length);
    expect(html).toContain("Recordings");
  });
});
