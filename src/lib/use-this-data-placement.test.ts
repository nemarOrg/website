/**
 * Placement guards for the "How to use the data (for agentic research)"
 * block.
 *
 * These are source-level assertions rather than rendered-DOM ones on purpose:
 * the two things that regressed in v0.2.6 are both decisions expressed in
 * markup, and neither is reachable from the model tests in
 * `use-this-data.test.ts` (which cover the content) or the mirror tests in
 * `test/routes/dataset-md.test.ts` (which cover the markdown surface). The
 * component is an Astro file with no unit-test harness in this repo, so
 * reading the source is the honest cheap check. A rendered-DOM version of
 * these two assertions belongs in the Playwright spec tracked in #279.
 *
 * What regressed: the block rendered expanded, immediately after the page
 * title, which pushed the README and the file tree about two screens down and
 * made agent-facing reference material the first thing a human read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const COMPONENT = readFileSync(join(ROOT, "src/components/UseThisData.astro"), "utf8");
const PAGE = readFileSync(join(ROOT, "src/pages/dataset/[id].astro"), "utf8");

describe("UseThisData is a collapsed disclosure", () => {
  it("renders a <details>, not a bare <section>", () => {
    expect(COMPONENT).toContain('<details class="use-this-data"');
  });

  it("is collapsed by default", () => {
    // `open` anywhere on the details tag would ship it expanded again.
    const tag = COMPONENT.match(/<details class="use-this-data"[^>]*>/)?.[0] ?? "";
    expect(tag).not.toMatch(/\bopen\b/);
  });

  it("keeps the content in the payload rather than hiding it (OSCAR parity)", () => {
    // A disclosure is fine; display:none or off-screen positioning on the body
    // would make this agent-only content a human cannot reach.
    expect(COMPONENT).not.toMatch(/\.use-this-data__body[^}]*display:\s*none/);
    expect(COMPONENT).not.toMatch(/\.use-this-data__body[^}]*position:\s*absolute/);
  });
});

describe("UseThisData sits last in the dataset page's content column", () => {
  it("renders after the README and the file tree", () => {
    const useThisData = PAGE.indexOf("<UseThisData");
    const readme = PAGE.indexOf("<Readme");
    const bidsTree = PAGE.indexOf("<BidsTree");
    expect(useThisData).toBeGreaterThan(-1);
    expect(readme).toBeGreaterThan(-1);
    expect(bidsTree).toBeGreaterThan(-1);
    expect(useThisData).toBeGreaterThan(readme);
    expect(useThisData).toBeGreaterThan(bidsTree);
  });

  it("still renders for an unpublished dataset", () => {
    // The component must stay OUTSIDE the `!unpublished` branch: the model
    // already decides what an unpublished dataset shows, and gating here too
    // made the page silent while the .md mirror still rendered a citation
    // (website#291 fix 1).
    const useThisData = PAGE.indexOf("<UseThisData");
    const branchClose = PAGE.lastIndexOf("{!unpublished && (");
    expect(branchClose).toBeGreaterThan(-1);
    // The render sits after the branch opens, so assert it is not nested by
    // checking it comes after that branch's closing `)}` rather than inside.
    const afterBranch = PAGE.indexOf(")}", PAGE.indexOf("<BidsTree"));
    expect(useThisData).toBeGreaterThan(afterBranch);
  });
});
