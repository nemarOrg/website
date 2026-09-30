/**
 * Wiring guard for the landing highlights' shared height.
 *
 * The three columns (news, most cited, latest) are sized by height, not by a
 * row count: side by side they share one grid row, the two lists take the
 * height they are given and show as many whole rows as fit, and the links are
 * pinned to the bottom so they line up. Astro components have no rendering
 * harness here, so this is a source-level assertion, as in
 * `test/dataset-card-updated.test.ts`; the real layout was measured in a
 * browser at 1440, 1100, 1024, 900, 720, 600 and 390 px.
 *
 * What this catches is a revert to a fixed row count per list, which leaves
 * the lists ending well above the news column and the three links at three
 * different heights.
 */

import { describe, expect, it } from "vitest";
import HIGHLIGHTS from "../src/components/Highlights.astro?raw";
import INDEX from "../src/pages/index.astro?raw";

/** Drop comments so the assertions read code, not the prose explaining it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The body of the first rule for `selector` inside `region`. */
function rule(region: string, selector: RegExp): string {
  const match = selector.exec(region);
  if (!match) throw new Error(`no rule for ${selector}`);
  const open = region.indexOf("{", match.index);
  return region.slice(open + 1, region.indexOf("}", open));
}

describe("landing highlights shared height", () => {
  const code = withoutComments(HIGHLIGHTS);
  const sideBySide = code.slice(code.indexOf("@media (min-width: 720px) {\n    .ranks"));

  it("lets the lists fill the row's height with as many whole rows as fit", () => {
    const list = rule(sideBySide, /\.ranks,\s*\.fresh\s*\{/);
    expect(list).toMatch(/display:\s*flex/);
    expect(list).toMatch(/flex-flow:\s*column wrap/);
    // Basis 0: the list's own length must not make its column taller.
    expect(list).toMatch(/flex:\s*1 1 0/);
    expect(list).toMatch(/min-block-size:/);
    expect(list).toMatch(/overflow:\s*clip/);
    expect(rule(sideBySide, /\.rank,\s*\.fresh__item\s*\{/)).toMatch(/inline-size:\s*100%/);
  });

  it("keeps five rows per list only when the columns are stacked", () => {
    const stacked = code.slice(code.indexOf("@media (max-width: 719.98px)"));
    expect(stacked).toMatch(/\.rank:nth-child\(n \+ 6\)/);
    // Not outside that query, where it would override the side-by-side layout.
    const before = code.slice(0, code.indexOf("@media (max-width: 719.98px)"));
    expect(before).not.toMatch(/nth-child\(n \+ 6\)/);
  });

  it("pins each column's link to the bottom so the three line up", () => {
    expect(rule(code, /\.col__more\s*\{/)).toMatch(/margin-block-start:\s*auto/);
  });

  it("takes clipped rows out of the tab order", () => {
    expect(code).toContain('toggleAttribute("inert"');
    expect(code.match(/data-fit/g)).toHaveLength(3); // both lists, plus the selector
  });

  it("gives the lists more rows than fit, for the CSS to choose from", () => {
    expect(INDEX).toMatch(/const HIGHLIGHT_ROWS = (\d+)/);
    const rows = Number(/const HIGHLIGHT_ROWS = (\d+)/.exec(INDEX)?.[1]);
    expect(rows).toBeGreaterThan(5);
  });
});
