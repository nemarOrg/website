/**
 * Placement and sizing guards for the "How to use the data (for agentic
 * research)" block.
 *
 * These are source-level assertions rather than rendered-DOM ones on purpose:
 * the things that regressed are decisions expressed in markup/CSS, and none
 * are reachable from the model tests in `use-this-data.test.ts` (which cover
 * the content) or the mirror tests in `test/routes/dataset-md.test.ts` (which
 * cover the markdown surface). The component is an Astro file with no
 * unit-test harness in this repo, so reading the source is the honest cheap
 * check. A rendered-DOM version of these assertions belongs in the Playwright
 * spec tracked in #279.
 *
 * What regressed, twice: v0.2.6 rendered the block expanded, immediately
 * after the page title, which pushed the README and the file tree about two
 * screens down and made agent-facing reference material the first thing a
 * human read (#297 fixed placement). #297's fix still styled the collapsed
 * summary as a headline -- `--fs-xl` semibold on an elevated card -- so it
 * kept competing with human-facing content by size even after it moved to
 * the end of the column (website#300).
 */

import { describe, expect, it } from "vitest";
// Vite's `?raw` rather than node:fs, because `astro check` type-checks every
// file under the repo (tsconfig includes **/*) without node types, so a
// readFileSync here fails typecheck in CI while passing locally under vitest.
import COMPONENT from "../src/components/UseThisData.astro?raw";
import PAGE from "../src/pages/dataset/[id].astro?raw";

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

describe("UseThisData is sized as an endnote, not a card (website#300)", () => {
  it("does not style the summary title above the page's base font size", () => {
    const titleRule = COMPONENT.match(/\.use-this-data__summary-title\s*\{[^}]*\}/)?.[0] ?? "";
    expect(titleRule).not.toBe("");
    // --fs-base and everything larger (--fs-lg, --fs-xl, ...) would make the
    // collapsed line read as a headline again; only the two tokens smaller
    // than the page default belong here.
    expect(titleRule).toMatch(/--fs-(xs|sm)\b/);
    expect(titleRule).not.toMatch(/--fs-(base|lg|xl|2xl|3xl|4xl|5xl|6xl)\b/);
  });

  it("does not style the summary hint above the page's base font size", () => {
    const hintRule = COMPONENT.match(/\.use-this-data__summary-hint\s*\{[^}]*\}/)?.[0] ?? "";
    expect(hintRule).not.toBe("");
    expect(hintRule).toMatch(/--fs-(xs|sm)\b/);
    expect(hintRule).not.toMatch(/--fs-(base|lg|xl|2xl|3xl|4xl|5xl|6xl)\b/);
  });

  it("does not render the container as an elevated/bordered card", () => {
    // `.use-this-data\s*\{` only matches the bare top-level selector: every
    // other rule for this component has a `__part`, `[open]`, or descendant
    // combinator between the class and the brace.
    const containerRule = COMPONENT.match(/\.use-this-data\s*\{[^}]*\}/)?.[0] ?? "";
    expect(containerRule).not.toBe("");
    expect(containerRule).not.toMatch(/background:\s*var\(--color-bg-elevated\)/);
    expect(containerRule).not.toMatch(/border-radius/);
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
