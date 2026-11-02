/**
 * Drift guard for public/brand/: the committed logo kit must still match
 * src/assets/nemar-logo.svg and the brand tokens in src/styles/tokens.css.
 * When this fails, run `bun scripts/generate-brand-kit.mjs` and commit.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(path, "utf8");
const source = read("src/assets/nemar-logo.svg");
const tokens = read("src/styles/tokens.css");

const pathData = (svg) => [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
const token = (name, from = tokens) => from.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
const darkBlock = tokens.slice(tokens.indexOf(':root[data-theme="dark"]'));

const expected = {
  color: {
    text: token("--color-fg"),
    brain: token("--brand-teal"),
    electrode: token("--brand-gold-deep"),
  },
  reverse: {
    text: token("--color-fg", darkBlock),
    brain: token("--brand-teal"),
    electrode: token("--brand-gold-light"),
  },
};

describe("public/brand logo kit", () => {
  const sourcePaths = pathData(source);

  for (const kind of ["logo", "mark", "stacked"]) {
    for (const variant of ["color", "reverse", "black", "white"]) {
      const file = `public/brand/nemar-${kind}-${variant}.svg`;
      const svg = read(file);

      it(`${file} has no theme variables left`, () => {
        expect(svg).not.toMatch(/var\(|currentColor/);
      });

      it(`${file} carries the source artwork`, () => {
        const paths = pathData(svg);
        // the mark holds only the brain paths; the others hold the wordmark too
        const want = kind === "mark" ? sourcePaths.slice(1) : sourcePaths;
        expect([...paths].sort()).toEqual([...want].sort());
      });
    }
  }

  for (const [variant, colors] of Object.entries(expected)) {
    it(`the ${variant} variant uses the site's token colors`, () => {
      const fills = read(`public/brand/nemar-logo-${variant}.svg`);
      for (const [part, hex] of Object.entries(colors)) {
        expect(hex, `token for ${part}`).toBeDefined();
        expect(fills).toContain(`fill="${hex}"`);
      }
    });
  }

  it("the square files are exactly square", () => {
    for (const kind of ["mark", "stacked"]) {
      const [, , w, h] = read(`public/brand/nemar-${kind}-color.svg`)
        .match(/viewBox="([^"]+)"/)[1]
        .split(/\s+/)
        .map(Number);
      expect(w).toBe(h);
    }
  });
});
