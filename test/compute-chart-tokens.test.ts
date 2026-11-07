/**
 * The compute chart's color tokens (website ADR 0007, ADR 0030 phase E2): defined for the light theme,
 * for the `prefers-color-scheme: dark` block guarded by `:root:not([data-theme="light"])`, and for
 * `:root[data-theme="dark"]`, and each series clears 3:1 against `--admin-surface` in its theme.
 * Separation by hue, lightness and the color-vision simulations was checked when the values were picked
 * (see the comment above them in tokens.css); this pins the parts that can regress silently.
 */
import { describe, expect, it } from "vitest";

/**
 * `node:fs`, reached without a static import (`astro check` has no node types), and the stylesheet read
 * from disk because Vitest blanks every stylesheet it imports, `?raw` included.
 */
async function readTokens(): Promise<string> {
  const specifier = "node:fs";
  const fs: { readFileSync(path: string, encoding: string): string } = await import(
    /* @vite-ignore */ specifier
  );
  return fs.readFileSync(
    decodeURIComponent(new URL("../src/styles/tokens.css", import.meta.url).pathname),
    "utf8",
  );
}

const TOKENS = await readTokens();

const NAMES = [
  "--chart-series-1",
  "--chart-series-2",
  "--chart-series-3",
  "--chart-series-4",
  "--chart-grid",
  "--chart-axis",
] as const;

function block(startMarker: string): string {
  const start = TOKENS.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = TOKENS.indexOf("{", start); i < TOKENS.length; i++) {
    if (TOKENS[i] === "{") depth++;
    if (TOKENS[i] === "}") {
      depth--;
      if (depth === 0) return TOKENS.slice(start, i);
    }
  }
  throw new Error("unbalanced braces");
}

const LIGHT = block("\n:root {");
const DARK_AUTO = block("@media (prefers-color-scheme: dark)");
const DARK_ATTR = block(':root[data-theme="dark"]');

function value(scope: string, name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(scope);
  expect(m, `${name} in ${scope.slice(0, 40)}`).not.toBeNull();
  return (m as RegExpExecArray)[1];
}

function lin(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => lin(Number.parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the chart tokens", () => {
  it.each([
    ["light", LIGHT],
    ["dark (system)", DARK_AUTO],
    ["dark (explicit)", DARK_ATTR],
  ])("are all defined for %s", (_theme, scope) => {
    for (const name of NAMES) expect(value(scope, name)).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("agree between the two dark blocks, so a system choice and an explicit one look the same", () => {
    for (const name of NAMES) {
      expect(value(DARK_AUTO, name).toLowerCase(), name).toBe(value(DARK_ATTR, name).toLowerCase());
    }
  });

  it.each([
    ["light", LIGHT],
    ["dark", DARK_ATTR],
  ])("keep every series at 3:1 or better on the card surface in %s", (_theme, scope) => {
    const surface = value(scope, "--admin-surface");
    for (const name of NAMES.slice(0, 4)) {
      expect(contrast(value(scope, name), surface), name).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the four series distinct from one another in each theme", () => {
    for (const scope of [LIGHT, DARK_ATTR]) {
      const colors = NAMES.slice(0, 4).map((n) => value(scope, n).toLowerCase());
      expect(new Set(colors).size).toBe(4);
    }
  });
});
