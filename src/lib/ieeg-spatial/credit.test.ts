import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CREDIT_FONT_PX,
  RAVE_CREDIT,
  creditLayout,
  creditLinkAttributes,
  creditSvg,
} from "./credit";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SRC = join(REPO, "src");

const THEME = { background: "#0a1224", foreground: "#f8fafc" };

describe("RAVE_CREDIT", () => {
  it("carries the settled wording, address and DOI", () => {
    expect(RAVE_CREDIT.text).toBe("Electrode view inspired by RAVE");
    expect(RAVE_CREDIT.href).toBe("https://rave.wiki");
    expect(RAVE_CREDIT.doi).toBe("10.1016/j.neuroimage.2020.117341");
    expect(RAVE_CREDIT.title).toBe(
      "RAVE: Reproducible Analysis and Visualization of iEEG (Magnotti, Wang and Beauchamp, NeuroImage 2020, doi:10.1016/j.neuroimage.2020.117341)",
    );
  });

  it("is frozen", () => {
    expect(Object.isFrozen(RAVE_CREDIT)).toBe(true);
  });

  it("never claims RAVE drew or powers the figure", () => {
    const words = Object.values(RAVE_CREDIT).join(" ");
    expect(words).not.toMatch(/powered by|rendered by|drawn by|made with/i);
  });
});

describe("creditLinkAttributes", () => {
  const attrs = creditLinkAttributes();

  it("takes href, title and text from the constant", () => {
    expect(attrs.href).toBe(RAVE_CREDIT.href);
    expect(attrs.title).toBe(RAVE_CREDIT.title);
  });

  it("opens in a new tab without leaking the opener or the referrer", () => {
    expect(attrs.target).toBe("_blank");
    expect(attrs.rel.split(/\s+/).sort()).toEqual(["noopener", "noreferrer"]);
  });

  it("is styled by its class alone and stays in the tab order", () => {
    expect(attrs.class).toBe("eegv-credit");
    expect(Object.keys(attrs).sort()).toEqual(["class", "href", "rel", "target", "title"]);
    // An anchor with an href is focusable; a negative tabindex or a style attribute would break
    // keyboard reach or the theme tokens, and neither is in the map.
    expect(attrs).not.toHaveProperty("tabindex");
    expect(attrs).not.toHaveProperty("style");
  });
});

describe("creditSvg", () => {
  const svg = creditSvg(800, 600, THEME);

  it("wraps the text in a link to the address", () => {
    expect(svg).toMatch(
      /<a [^>]*href="https:\/\/rave\.wiki"[^>]*>\s*<text[^>]*>Electrode view inspired by RAVE<\/text>\s*<\/a>/,
    );
  });

  it("names the credit, the address and the DOI in a metadata block", () => {
    const meta = /<metadata[\s\S]*<\/metadata>/.exec(svg)?.[0] ?? "";
    expect(meta).toContain(RAVE_CREDIT.text);
    expect(meta).toContain(RAVE_CREDIT.href);
    expect(meta).toContain(RAVE_CREDIT.doi);
  });

  it("paints colors from the theme and carries no raw ampersand or angle bracket from it", () => {
    expect(svg).toContain(THEME.background);
    expect(svg).toContain(THEME.foreground);
    const hostile = creditSvg(800, 600, { background: 'x"><script>', foreground: "a&b" });
    expect(hostile).not.toContain("<script>");
    expect(hostile).toContain("a&amp;b");
  });

  it("keeps its backing box inside the viewBox at the narrowest panel", () => {
    const m = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(
      creditSvg(280, 200, THEME),
    );
    expect(m).not.toBeNull();
    const [x, y, w, h] = (m as RegExpExecArray).slice(1).map(Number);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + w).toBeLessThanOrEqual(280);
    expect(y + h).toBeLessThanOrEqual(200);
  });
});

describe("creditLayout (the geometry paintCredit draws)", () => {
  // Measured text widths at the nominal 11 CSS pixel font, in CSS pixels. Real sans-serif widths
  // for this 31 character sentence sit near 175; the range brackets font and platform spread.
  const TEXT_CSS_PX = [120, 175, 240];
  const WIDTHS = [200, 280, 320, 640, 1280, 1920, 4000];
  const HEIGHTS = [150, 300, 1000];

  it("stays inside the canvas for widths 200 to 4000 at device pixel ratios 1 and 2", () => {
    for (const dpr of [1, 2]) {
      for (const w of WIDTHS) {
        for (const h of HEIGHTS) {
          for (const t of TEXT_CSS_PX) {
            const box = creditLayout(w * dpr, h * dpr, dpr, t * dpr).box;
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.y).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(w * dpr);
            expect(box.y + box.height).toBeLessThanOrEqual(h * dpr);
          }
        }
      }
    }
  });

  it("anchors to the bottom-right corner", () => {
    const { box } = creditLayout(1280, 720, 1, 175);
    expect(1280 - (box.x + box.width)).toBeLessThan(20);
    expect(720 - (box.y + box.height)).toBeLessThan(20);
  });

  it("scales font and box with the device pixel ratio", () => {
    const one = creditLayout(1280, 720, 1, 175);
    const two = creditLayout(2560, 1440, 2, 350);
    expect(one.fontPx).toBeCloseTo(CREDIT_FONT_PX);
    expect(two.fontPx).toBeCloseTo(2 * CREDIT_FONT_PX);
    expect(two.box.height).toBeCloseTo(2 * one.box.height);
    expect(two.box.width).toBeCloseTo(2 * one.box.width);
  });

  it("fits the wording at 11 CSS pixels in a 280 pixel wide panel without shrinking", () => {
    const { fontPx } = creditLayout(280, 200, 1, 175);
    expect(fontPx).toBeCloseTo(CREDIT_FONT_PX);
  });

  it("shrinks the font rather than overflowing a canvas too narrow for the sentence", () => {
    const { fontPx, box } = creditLayout(160, 100, 1, 175);
    expect(fontPx).toBeLessThan(CREDIT_FONT_PX);
    expect(box.x + box.width).toBeLessThanOrEqual(160);
  });
});

describe("the credit is declared once", () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else out.push(full);
    }
    return out;
  }
  const files = sourceFiles(SRC);

  it("writes the sentence only in credit.ts and this test", () => {
    const hits = files
      .filter((f) => readFileSync(f, "utf8").includes("inspired by RAVE"))
      .map((f) => relative(REPO, f))
      .sort();
    expect(hits).toEqual(["src/lib/ieeg-spatial/credit.test.ts", "src/lib/ieeg-spatial/credit.ts"]);
  });

  it("writes the address only in credit.ts and this test", () => {
    const hits = files
      .filter((f) => readFileSync(f, "utf8").includes("rave.wiki"))
      .map((f) => relative(REPO, f))
      .sort();
    expect(hits).toEqual(["src/lib/ieeg-spatial/credit.test.ts", "src/lib/ieeg-spatial/credit.ts"]);
  });
});

describe(".eegv-credit style", () => {
  const css = readFileSync(join(SRC, "styles/eeg-viewer.css"), "utf8");
  const rules = [...css.matchAll(/(\.eegv-credit[^{]*)\{([^}]*)\}/g)];

  it("has a base rule, a hover rule and a visible focus rule", () => {
    const selectors = rules.map((r) => r[1].trim());
    expect(selectors.some((s) => s === ".eegv-credit")).toBe(true);
    expect(selectors.some((s) => s.includes(":hover"))).toBe(true);
    expect(selectors.some((s) => s.includes(":focus-visible"))).toBe(true);
  });

  it("takes every color from the theme tokens", () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , body] of rules) {
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });

  it("keeps the 11 pixel size the canvas painter uses", () => {
    const base = rules.find((r) => r[1].trim() === ".eegv-credit");
    expect(base?.[2]).toContain(`${CREDIT_FONT_PX}px`);
  });
});
