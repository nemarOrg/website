/**
 * Wiring guard for the footer's "Your Privacy Choices" control (website#413,
 * phase 3 of #410).
 *
 * The footer is an Astro component with no rendering harness here, so this is
 * a source-level assertion, as in `test/footer-explore-links.test.ts`. It pins
 * what a visual check cannot keep pinned: the control is still the
 * `data-cookie-open` button the cookie notice wires (so it opens the same
 * analytics preference as before), it sits at the end of the copyright line
 * rather than in the link list, its accessible name is the visible text, and
 * the icon is the shared, decorative component.
 */

import { describe, expect, it } from "vitest";
import FOOTER from "../src/components/Footer.astro?raw";
import ICON from "../src/components/PrivacyChoicesIcon.astro?raw";

const markup = FOOTER.slice(0, FOOTER.indexOf("<style>"));

describe("footer Your Privacy Choices control", () => {
  const projectColumn = markup.slice(
    markup.indexOf("<h3>Project</h3>"),
    markup.indexOf("<h3>Data</h3>"),
  );
  const bottomLine = markup.slice(markup.indexOf('class="container site-footer__bottom"'));
  const button =
    bottomLine.match(/<button[^>]*data-cookie-open[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";

  it("is a type=button that carries the cookie notice's data-cookie-open hook", () => {
    expect(button).toMatch(/type="button"/);
    expect(button).toContain("data-cookie-open");
    expect(markup.match(/<button[^>]*data-cookie-open/g)).toHaveLength(1);
  });

  it("is named Your Privacy Choices by its visible text, with a decorative icon", () => {
    expect(button).toContain("<PrivacyChoicesIcon size={14} />");
    expect(button).toContain("<span>Your Privacy Choices</span>");
    expect(button).not.toContain("aria-label");
  });

  it("sits after the Built with credit at the end of the copyright line", () => {
    const copyright = bottomLine.indexOf("The Regents of the University of California");
    const builtWith = bottomLine.indexOf("Built with");
    expect(copyright).toBeGreaterThan(-1);
    expect(builtWith).toBeGreaterThan(copyright);
    expect(bottomLine.indexOf("<button")).toBeGreaterThan(builtWith);
    expect(bottomLine.indexOf("</button>")).toBeLessThan(bottomLine.indexOf("</footer>"));
  });

  it("leads the control with a separator like the other items on that line", () => {
    const wrapper = bottomLine.slice(
      bottomLine.lastIndexOf("<div>"),
      bottomLine.indexOf("<button"),
    );
    expect(wrapper).toContain('class="site-footer__sep" aria-hidden="true"');
  });

  it("is out of the Project link list, which keeps the Privacy Policy link", () => {
    expect(projectColumn).toContain('<a href="/privacy">Privacy Policy</a>');
    expect(projectColumn).not.toContain("<button");
    expect(projectColumn).not.toContain("data-cookie-open");
  });

  it("no longer says Privacy settings", () => {
    expect(markup).not.toMatch(/Privacy settings/i);
  });
});

describe("PrivacyChoicesIcon", () => {
  it("is a decorative inline SVG with the published 30:14 proportions", () => {
    expect(ICON).toContain('aria-hidden="true"');
    expect(ICON).toContain('focusable="false"');
    expect(ICON).toContain('viewBox="0 0 30 14"');
  });

  it("defaults to 14px high and derives its width from the aspect ratio", () => {
    expect(ICON).toContain("const { size = 14 } = Astro.props;");
    expect(ICON).toContain("size * (30 / 14)");
    expect(ICON).toContain("height={size}");
  });

  it("is self-contained: fixed colors only, no external reference", () => {
    const body = ICON.slice(ICON.indexOf("<svg"), ICON.indexOf("</svg>"));
    const fills = [...body.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    expect(fills.length).toBeGreaterThan(0);
    expect(new Set(fills)).toEqual(new Set(["#fff", "#06f"]));
    expect(body).not.toMatch(/href=|url\(|<image|<use/);
  });
});
