/**
 * Wiring guard for the "Showing results for ..." line on /discover (website#516).
 *
 * discover.astro and its components have no rendering harness here, so these are
 * source-level assertions, as in `test/footer-explore-links.test.ts`. They pin
 * where the line sits and when it shows, and what the component prints; the
 * decisions behind it (what counts as a correction, where the link points) are
 * tested on real data in `src/lib/discover-search.test.ts`.
 */

import { describe, expect, it } from "vitest";
import NOTE from "../src/components/CorrectedQueryNote.astro?raw";
import SIDEBAR from "../src/components/FilterSidebar.astro?raw";
import DISCOVER from "../src/pages/discover.astro?raw";

describe("discover.astro", () => {
  const head = DISCOVER.slice(
    DISCOVER.indexOf('<header class="discover__head">'),
    DISCOVER.indexOf("</header>"),
  );

  it("renders the note inside .discover__head, after the search box", () => {
    expect(head).toContain("<SearchBar");
    expect(head).toContain("<CorrectedQueryNote");
    expect(head.indexOf("<SearchBar")).toBeLessThan(head.indexOf("<CorrectedQueryNote"));
  });

  it("renders it only when nothing failed, a search ran and it was corrected", () => {
    expect(head).toMatch(/\{!fetchError && isSearch && correction && \(\s*<CorrectedQueryNote/);
  });

  it("imports the component and renders it nowhere else", () => {
    expect(DISCOVER).toContain(
      'import CorrectedQueryNote from "../components/CorrectedQueryNote.astro";',
    );
    expect(DISCOVER.split("<CorrectedQueryNote").length - 1).toBe(1);
  });

  it("hands the note the typed words, the corrected ones and the link", () => {
    expect(head).toContain("corrected={correction.corrected}");
    expect(head).toContain("original={state.q}");
    expect(head).toContain("originalHref={correction.originalHref}");
  });

  it("asks the API for the words as typed in exact mode, and takes the notice from pageSearch", () => {
    expect(DISCOVER).toMatch(/searchDatasets\(state\.q, \{[^}]*exact: state\.exact/);
    expect(DISCOVER).toContain("correction = result.correction;");
  });
});

describe("CorrectedQueryNote.astro", () => {
  it("prints the line and the link text", () => {
    expect(NOTE).toContain("Showing results for");
    expect(NOTE).toMatch(/Search for \{original\} instead/);
  });

  it("shows the link only when there is one", () => {
    expect(NOTE).toMatch(/\{originalHref && \(/);
    expect(NOTE).toContain("href={originalHref}");
  });

  it("never injects markup: the texts come from a query string and the API", () => {
    expect(NOTE).not.toContain("set:html");
  });

  it("takes its look from tokens only", () => {
    const style = NOTE.slice(NOTE.indexOf("<style>"));
    expect(style).toContain("var(--fs-sm)");
    expect(style).toContain("var(--color-fg-muted)");
    expect(style).toContain("var(--color-fg)");
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(style).not.toMatch(/\brgba?\(/);
  });
});

describe("FilterSidebar.astro", () => {
  it("carries exact=1 on every filter change while the page is exact", () => {
    expect(SIDEBAR).toMatch(/\{state\.exact && <input type="hidden" name="exact" value="1"/);
  });
});
