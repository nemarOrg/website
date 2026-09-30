/**
 * Wiring guard for the landing highlights' shared height.
 *
 * The three columns (news, most cited, latest) are sized by height, not by a
 * row count: side by side they share one grid row, the two lists take the
 * height they are given and show as many whole rows as fit, and the links are
 * pinned to the bottom so they line up. Astro components have no rendering
 * harness here, so this is a source-level assertion, as in
 * `test/dataset-card-updated.test.ts`; the real layout was measured in Chrome,
 * Firefox and WebKit at 1440, 1100, 1024, 900, 720, 600 and 390 px. The
 * patterns tolerate whitespace and the exact media-query wording, so a harmless
 * reformat does not fail them.
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

/** The body of the first rule in `region` whose selector list matches `selector`. */
function rule(region: string, selector: RegExp): string {
  const match = selector.exec(region);
  if (!match) throw new Error(`no rule for ${selector}`);
  const open = region.indexOf("{", match.index);
  return region.slice(open + 1, region.indexOf("}", open));
}

/** Everything from the start of the `@media` block whose query matches `query`. */
function fromMedia(code: string, query: RegExp): string {
  const at = code.search(query);
  if (at < 0) throw new Error(`no media block for ${query}`);
  return code.slice(at);
}

describe("landing highlights shared height", () => {
  const code = withoutComments(HIGHLIGHTS);
  const sideBySide = fromMedia(code, /@media[^{]*\(min-width:\s*720px\)[^{]*\{\s*\.ranks/);

  it("lets the lists fill the row's height with as many whole rows as fit", () => {
    const list = rule(sideBySide, /\.ranks,\s*\.fresh\s*\{/);
    expect(list).toMatch(/display:\s*flex/);
    expect(list).toMatch(/flex-flow:\s*column\s+wrap/);
    // Basis 0: the list's own length must not make its column taller.
    expect(list).toMatch(/flex:\s*1\s+1\s+0(?!\S*[a-z%])/);
    expect(list).toMatch(/min-block-size:\s*\d/);
    expect(list).toMatch(/overflow:\s*clip/);
    expect(rule(sideBySide, /\.rank,\s*\.fresh__item\s*\{/)).toMatch(/inline-size:\s*100%/);
  });

  it("keeps five rows per list only when the columns are stacked", () => {
    const stackedAt = code.search(/@media[^{]*\(max-width:\s*719\.98px\)/);
    expect(stackedAt).toBeGreaterThan(-1);
    expect(code.slice(stackedAt)).toMatch(/\.rank:nth-child\(n\s*\+\s*6\)/);
    // Not outside that query, where it would override the side-by-side layout.
    expect(code.slice(0, stackedAt)).not.toMatch(/nth-child\(n\s*\+\s*6\)/);
  });

  it("pins each column's link to the bottom so the three line up", () => {
    expect(rule(code, /\.col__more\s*\{/)).toMatch(/margin-block-start:\s*auto/);
  });

  it("draws the focus ring inside the rows, where the list's clipping cannot cut it", () => {
    const rings = [
      ...code.matchAll(/\.rank__link:focus-visible,\s*\.fresh__link:focus-visible\s*\{([^}]*)\}/g),
    ];
    expect(rings.map((m) => m[1]).join(" ")).toMatch(/outline-offset:\s*-\d/);
  });

  it("gives both lists list semantics", () => {
    expect(HIGHLIGHTS).toMatch(/<ol[^>]*class="ranks"[^>]*role="list"/);
    expect(HIGHLIGHTS).toMatch(/<ul[^>]*class="fresh"[^>]*role="list"/);
  });

  it("takes clipped rows out of the tab order, watching the rows as well as the list", () => {
    expect(code).toMatch(/toggleAttribute\(\s*"inert"/);
    expect(code).toContain("clippedFlags(");
    expect(code).toMatch(/observer\.observe\(list\)/);
    expect(code).toMatch(/observer\.observe\(row\)/);
    expect(HIGHLIGHTS.match(/\sdata-fit[\s>]/g)).toHaveLength(2); // both lists
  });

  it("gives the lists more rows than fit, for the CSS to choose from", () => {
    const rows = Number(/const HIGHLIGHT_ROWS = (\d+)/.exec(INDEX)?.[1]);
    expect(rows).toBeGreaterThan(5);
    expect(INDEX).toMatch(/mostCitedRows\(\s*catalog,\s*manifest,\s*HIGHLIGHT_ROWS\s*\)/);
    expect(INDEX).toMatch(/latestDatasets\(\s*page\.datasets,\s*HIGHLIGHT_ROWS\s*\)/);
    // The newest call asks for more than it shows: `ds*` pointers are filtered out.
    const limit = Number(/sort:\s*"newest",\s*limit:\s*(\d+)/.exec(INDEX)?.[1]);
    expect(limit).toBeGreaterThanOrEqual(rows);
  });
});
