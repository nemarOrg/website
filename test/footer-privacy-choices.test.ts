/**
 * Wiring guard for the footer's "Your Privacy Choices" control (website#413,
 * phase 3 of #410).
 *
 * The footer is an Astro component with no rendering harness here, so this is
 * a source-level assertion, as in `test/footer-explore-links.test.ts`. It pins
 * what a visual check cannot keep pinned: the control is still the
 * `data-cookie-open` button the cookie notice binds (so it opens the same
 * analytics preference as before), it sits at the end of the copyright line
 * rather than in the link list, its accessible name is the visible text, and
 * the icon is the shared, decorative component.
 */

import { describe, expect, it } from "vitest";
import COOKIE_NOTICE from "../src/components/CookieNotice.astro?raw";
import FOOTER from "../src/components/Footer.astro?raw";
import ICON from "../src/components/PrivacyChoicesIcon.astro?raw";

const styleStart = FOOTER.indexOf("<style>");
const markup = FOOTER.slice(0, styleStart);
const style = FOOTER.slice(styleStart);

/** The source of the `<div class="site-footer__line">` element, to its matching close. */
function footerLine(): string {
  const open = markup.indexOf('<div class="site-footer__line">');
  expect(open, "the footer's copyright line element").toBeGreaterThan(-1);
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = open;
  let depth = 0;
  for (let m = tag.exec(markup); m !== null; m = tag.exec(markup)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return markup.slice(open, m.index + m[0].length);
  }
  throw new Error("the footer's copyright line element is never closed");
}

const line = footerLine();
const buttonStart = line.indexOf("<button");
const button = line.slice(buttonStart, line.indexOf("</button>") + "</button>".length);
const buttonTag = button.slice(0, button.indexOf(">") + 1);

describe("footer Your Privacy Choices control", () => {
  it("is a type=button that carries the cookie notice's data-cookie-open hook", () => {
    expect(buttonTag).toMatch(/type="button"/);
    expect(buttonTag).toContain("data-cookie-open");
    expect(markup.match(/<button[^>]*data-cookie-open/g)).toHaveLength(1);
  });

  it("is named Your Privacy Choices by its visible text, beside the shared icon", () => {
    expect(button).toContain("<PrivacyChoicesIcon");
    expect(button).toContain("<span>Your Privacy Choices</span>");
  });

  it("is a plain, reachable control: nothing hides it or renames it", () => {
    for (const attr of [
      "aria-hidden",
      "tabindex",
      "hidden",
      "disabled",
      "aria-label",
      "aria-labelledby",
    ]) {
      expect(buttonTag, attr).not.toMatch(new RegExp(`\\b${attr}\\b`));
    }
  });

  it("sits inside the copyright line, after the Built with credit", () => {
    expect(buttonStart).toBeGreaterThan(-1);
    const builtWith = line.indexOf("Built with");
    expect(builtWith).toBeGreaterThan(line.indexOf("The Regents of the University of California"));
    expect(buttonStart).toBeGreaterThan(builtWith);
  });

  it("is not inside a conditional expression", () => {
    // Every `{` before the button, in a comment or an expression like
    // `{hasCommit && (...)}`, is closed again by the time the button starts.
    const before = line.slice(0, buttonStart);
    const open = before.match(/\{/g)?.length ?? 0;
    const close = before.match(/\}/g)?.length ?? 0;
    expect(open - close).toBe(0);
  });

  it("has a style rule for its own class, so a rename cannot leave it unstyled", () => {
    const cls = buttonTag.match(/class="([^"]+)"/)?.[1];
    expect(cls).toBeTruthy();
    expect(style).toContain(`.${cls} {`);
  });

  it("is out of the Project link list, which keeps the Privacy Policy link", () => {
    const projectColumn = markup.slice(
      markup.indexOf("<h3>Project</h3>"),
      markup.indexOf("<h3>Data</h3>"),
    );
    expect(projectColumn).toContain('<a href="/privacy">Privacy Policy</a>');
  });

  it("no longer says Privacy settings", () => {
    expect(markup).not.toMatch(/Privacy settings/i);
  });
});

describe("cookie notice side of the opt-out contract", () => {
  it("still binds every [data-cookie-open] element in the page", () => {
    expect(COOKIE_NOTICE).toMatch(/querySelectorAll[^(]*\(\s*"\[data-cookie-open\]"\s*\)/);
  });
});

describe("PrivacyChoicesIcon", () => {
  const rootTag = ICON.match(/<svg\b[^>]*>/)?.[0] ?? "";

  it("is a decorative inline SVG with the published 30:14 proportions", () => {
    expect(rootTag).toContain('aria-hidden="true"');
    expect(rootTag).toContain('viewBox="0 0 30 14"');
    expect(rootTag).toMatch(/\bwidth=/);
  });

  it("defaults to 14px high", () => {
    expect(ICON).toMatch(/size\s*=\s*14/);
  });

  it("is self-contained: fixed colors only, no external reference", () => {
    const body = ICON.slice(ICON.indexOf("<svg"), ICON.indexOf("</svg>"));
    const fills = [...body.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    expect(fills.length).toBeGreaterThan(0);
    expect(new Set(fills)).toEqual(new Set(["#fff", "#06f"]));
    expect(ICON).not.toMatch(/(?:fill|stroke)="currentColor"/);
    expect(body).not.toMatch(/href=|url\(|<image|<use/);
  });
});
