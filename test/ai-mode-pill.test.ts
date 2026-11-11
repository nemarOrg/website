/**
 * Source-level guards for the AI Mode pill on the dataset page (website#517, board C1), in the
 * pattern of `test/account-tiers-ui.test.ts`: Astro files have no render harness in this repo, so
 * the markup and the stylesheet are read as text. The pill's decisions (when it shows, what a
 * click does, the remembered hint) are tested on real inputs in `src/lib/osa-ai-mode.test.ts`.
 */

import { describe, expect, it } from "vitest";
import ACTION_BAR from "../src/components/ActionBar.astro?raw";
import { DOCS_ANALYZE_IN_BROWSER_PATH } from "../src/lib/docs-base";
import TOKENS from "../src/styles/tokens.css?raw";

/** The `<tag ...>` that opens the first element whose attributes include `marker`. */
function openingTag(source: string, tag: string, marker: string): string {
  const pattern = new RegExp(`<${tag}\\b[^>]*${marker}[^>]*>`);
  const found = source.match(pattern);
  if (!found) throw new Error(`no <${tag}> carrying ${marker}`);
  return found[0];
}

/**
 * The whole element (opening tag to its matching closing tag) of the first `<tag>` whose
 * attributes include `marker`. Nested elements of the same tag are counted, so the result does not
 * depend on indentation or on what follows the element.
 */
function elementMarkup(source: string, tag: string, marker: string): string {
  const open = openingTag(source, tag, marker);
  const start = source.indexOf(open);
  const tags = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "g");
  tags.lastIndex = start;
  let depth = 0;
  for (let t = tags.exec(source); t; t = tags.exec(source)) {
    depth += t[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return source.slice(start, t.index + t[0].length);
  }
  throw new Error(`no closing </${tag}> for ${marker}`);
}

/** The declarations inside the first rule whose selector is exactly `selector`. */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = source.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!found) throw new Error(`no rule for ${selector}`);
  return found[1];
}

/** The text of an element's markup with tags and whitespace runs removed. */
function words(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const markup = ACTION_BAR.slice(ACTION_BAR.indexOf('<div class="actions">'));
const downloadAt = markup.indexOf("data-download-stub");
const wrapperAt = markup.indexOf("data-ai-mode-wrap");
const pillButton = elementMarkup(markup, "button", "data-ai-mode\\b(?![-\\w])");

describe("AI Mode pill markup", () => {
  it("sits directly after the Download button, before View data", () => {
    const download = elementMarkup(markup, "button", "data-download-stub");
    const afterDownload = markup
      .slice(markup.indexOf(download) + download.length)
      .replace(/\{\/\*[\s\S]*?\*\/\}/, "")
      .trimStart();
    // The next element after Download (comments aside) is the pill's wrapper, and the wrapper
    // comes before the View data button.
    expect(afterDownload.startsWith("<div")).toBe(true);
    expect(afterDownload.slice(0, afterDownload.indexOf(">"))).toContain("data-ai-mode-wrap");
    expect(wrapperAt).toBeGreaterThan(downloadAt);
    expect(wrapperAt).toBeLessThan(markup.indexOf("data-view-data-btn"));
  });

  it("ships the wrapper hidden, so a pill that never shows leaves no gap in the row", () => {
    expect(openingTag(markup, "div", "data-ai-mode-wrap")).toMatch(/class="ai-mode"[^>]*\bhidden\b/);
    expect(rule(ACTION_BAR, ".ai-mode[hidden]")).toMatch(/display:\s*none/);
    expect(ACTION_BAR).not.toMatch(/\.ai-mode:has\(/);
  });

  it("is a hidden .action button that opens a dialog", () => {
    const tag = openingTag(markup, "button", "data-ai-mode\\b(?![-\\w])");
    expect(tag).toMatch(/class="action action--ai"/);
    expect(tag).toMatch(/\bhidden\b/);
    expect(tag).toMatch(/type="button"/);
    expect(tag).toMatch(/aria-haspopup="dialog"/);
  });

  it("reads 'AI Mode' with one 16 px sparkle that is hidden from assistive technology", () => {
    expect(words(pillButton)).toBe("AI Mode");
    const svgs = pillButton.match(/<svg\b[^>]*>/g) ?? [];
    expect(svgs).toHaveLength(1);
    expect(svgs[0]).toMatch(/width="16"/);
    expect(svgs[0]).toMatch(/height="16"/);
    expect(svgs[0]).toMatch(/viewBox="0 0 24 24"/);
    expect(svgs[0]).toMatch(/fill="currentColor"/);
    expect(svgs[0]).toMatch(/aria-hidden="true"/);
    // A four-point star and a small star.
    expect(pillButton.match(/<path\b/g)).toHaveLength(2);
  });

  it("has a role=note hint with a 'Got it' button and a 'How it works' link to the docs path", () => {
    const hint = elementMarkup(markup, "div", "data-ai-mode-hint");
    expect(hint).toMatch(/role="note"/);
    expect(hint).toMatch(/\bhidden\b/);
    expect(words(hint)).toContain(
      "New: ask about this dataset, or describe an analysis and run it in your browser.",
    );
    expect(hint).toMatch(/<button[^>]*data-ai-mode-dismiss[^>]*>\s*Got it\s*<\/button>/);
    expect(hint).toMatch(/<a[^>]*href=\{analyzeInBrowserUrl\}[^>]*>\s*How it works\s*<\/a>/);
    expect(ACTION_BAR).toMatch(/resolveDocsBase\(\)\}\$\{DOCS_ANALYZE_IN_BROWSER_PATH\}/);
    expect(DOCS_ANALYZE_IN_BROWSER_PATH).toBe("/web/analyze-in-browser/");
  });

  // Wiring only: that a click opens the widget and dismisses only on success, and what each
  // dismissal stores, is behaviour tested on real inputs in src/lib/osa-ai-mode.test.ts.
  it("wires the pill through the lib module, on the click and on every way of dismissing", () => {
    expect(ACTION_BAR).toMatch(/from "\.\.\/lib\/osa-ai-mode"/);
    expect(ACTION_BAR).toContain("revealAiModePill(widgetWindow, document, pill");
    expect(ACTION_BAR).toMatch(/if \(openAiMode\(widgetWindow\)\) dismiss\(\)/);
    expect(ACTION_BAR).toContain('e.key !== "Escape" || e.defaultPrevented');
    expect(ACTION_BAR).toContain("wrap?.contains(document.activeElement)");
    expect(ACTION_BAR).toContain("if (hint?.contains(document.activeElement)) pill.focus();");
    expect(ACTION_BAR).toContain("[data-ai-mode-dismiss]");
    expect(ACTION_BAR).toContain("[data-ai-mode-link]");
  });
});

describe("AI Mode pill styles", () => {
  const pill = rule(ACTION_BAR, ".action--ai");

  it("keeps the shared 44 px height and pill shape through .action", () => {
    expect(rule(ACTION_BAR, ".action")).toMatch(/min-block-size:\s*44px/);
    expect(rule(ACTION_BAR, ".action")).toMatch(/border-radius:\s*var\(--radius-pill\)/);
  });

  it("fills with the brand teal, with #04121f text at weight 600", () => {
    expect(TOKENS).toMatch(/--brand-teal:\s*#5bbad5;/);
    expect(TOKENS).toMatch(/--on-teal:\s*#04121f;/);
    expect(pill).toMatch(/background:\s*var\(--brand-teal\)/);
    expect(pill).toMatch(/border-color:\s*var\(--brand-teal\)/);
    expect(pill).toMatch(/color:\s*var\(--on-teal\)/);
    expect(pill).toMatch(/font-weight:\s*var\(--fw-semibold\)/);
    expect(TOKENS).toMatch(/--fw-semibold:\s*600;/);
  });

  it("darkens on hover and keeps a focus ring", () => {
    expect(rule(ACTION_BAR, ".action--ai:hover")).toMatch(/background:\s*color-mix\(/);
    expect(ACTION_BAR).toMatch(/\.action--ai:focus-visible\s*\{[^}]*outline/);
  });

  it("keeps the shared [hidden] rule, so a hidden pill is not shown by .action's display", () => {
    expect(rule(ACTION_BAR, ".action[hidden]")).toMatch(/display:\s*none/);
  });

  it("anchors the hint to the pill's wrapper, absolutely and within the viewport", () => {
    expect(rule(ACTION_BAR, ".ai-mode")).toMatch(/position:\s*relative/);
    const hint = rule(ACTION_BAR, ".ai-mode__hint");
    expect(hint).toMatch(/position:\s*absolute/);
    expect(hint).toMatch(/max-inline-size:\s*min\(300px,\s*calc\(100vw - 32px\)\)/);
    expect(rule(ACTION_BAR, ".ai-mode__hint[hidden]")).toMatch(/display:\s*none/);
  });
});

describe("AI Mode hint controls", () => {
  it("keep a touch target of at least 36 px for Got it and the How it works link", () => {
    expect(rule(ACTION_BAR, ".ai-mode__got-it")).toMatch(/min-block-size:\s*36px/);
    expect(rule(ACTION_BAR, ".ai-mode__link")).toMatch(/min-block-size:\s*36px/);
  });
});

describe("AI Mode hint tokens", () => {
  const roles = [
    "--ai-hint-bg",
    "--ai-hint-fg",
    "--ai-hint-link",
    "--ai-hint-border",
    "--ai-hint-action-border",
    "--ai-hint-action-fg",
    "--ai-hint-shadow",
  ];
  const hintColors = rule(ACTION_BAR, ".ai-mode__hint") + rule(ACTION_BAR, ".ai-mode__caret");

  it("draws every hint colour from a token, not a literal", () => {
    expect(hintColors).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(hintColors).toMatch(/var\(--ai-hint-bg\)/);
    expect(hintColors).toMatch(/var\(--ai-hint-fg\)/);
  });

  it("defines each role in the light theme", () => {
    const root = TOKENS.slice(TOKENS.indexOf(":root {"), TOKENS.indexOf("/* Dark theme"));
    for (const role of roles) expect(root).toContain(`${role}:`);
  });

  it("gives the surface, edge and shadow a dark counterpart in both dark blocks", () => {
    const auto = TOKENS.slice(
      TOKENS.indexOf("@media (prefers-color-scheme: dark)"),
      TOKENS.indexOf(':root[data-theme="dark"]'),
    );
    const explicit = TOKENS.slice(TOKENS.indexOf(':root[data-theme="dark"]'));
    for (const block of [auto, explicit]) {
      for (const role of ["--ai-hint-bg", "--ai-hint-border", "--ai-hint-shadow"]) {
        expect(block).toContain(`${role}:`);
      }
    }
  });
});
