/**
 * Wiring guard for the footer's Explore column.
 *
 * The footer is an Astro component with no rendering harness here, so this is
 * a source-level assertion, as in `test/dataset-card-updated.test.ts`. It pins
 * that the observability dashboard is linked as an external link (new tab,
 * `rel="noopener"`, marked as leaving the site) the way the citation dashboard
 * and the documentation are, and that it sits in the Explore column.
 */

import { describe, expect, it } from "vitest";
import FOOTER from "../src/components/Footer.astro?raw";

describe("footer Explore column", () => {
  const explore = FOOTER.slice(
    FOOTER.indexOf("<h3>Explore</h3>"),
    FOOTER.indexOf("<h3>Project</h3>"),
  );

  it("links the observability dashboard as an external link", () => {
    expect(explore).toMatch(
      /<ExternalLink href="https:\/\/dashboard\.nemar\.org\/observability\/">Observability<\/ExternalLink>/,
    );
  });

  it("keeps the other Explore links", () => {
    expect(explore).toContain('<a href="/discover">Discover</a>');
    expect(explore).toContain('<a href="/news">News</a>');
    expect(explore).toContain("https://dashboard.nemar.org/citations/");
    expect(explore).toContain("https://docs.nemar.org");
  });
});
