/**
 * Source-level guards for the AI Mode toggle in the search fields and the AI overview panel
 * (website#518 on Discover, #519 on Home; boards D2 and D1), in the pattern of
 * `test/ai-mode-pill.test.ts`: Astro files have no render harness in this repo, so the markup and
 * the stylesheet are read as text. What the toggle decides (when it shows, what is remembered, the
 * request, the answer, the panel's states) is tested on real inputs in `src/lib/osa-overview.test.ts`,
 * `src/lib/osa-ai-mode.test.ts` and `src/lib/ai-overview-panel.test.ts`.
 */

import { describe, expect, it } from "vitest";
import DEPLOY_TEST from "../.github/workflows/deploy-test.yml?raw";
import E2E from "../e2e/ai-mode-field.spec.ts?raw";
import PACKAGE from "../package.json?raw";
import PLAYWRIGHT_CONFIG from "../playwright.config.ts?raw";
import TOGGLE from "../src/components/AiModeToggle.astro?raw";
import PANEL from "../src/components/AiOverviewPanel.astro?raw";
import SEARCH_BAR from "../src/components/SearchBar.astro?raw";
import CLIENT from "../src/lib/ai-mode-search-client.ts?raw";
import { AI_MODE_SEARCH_DISCLOSURE } from "../src/lib/osa-ai-mode";
import {
  AI_MODE_HINT,
  OVERVIEW_ENDPOINTS,
  OVERVIEW_MIN_WORDS,
  countQueryWords,
  resolveOverviewEndpoint,
} from "../src/lib/osa-overview";
import DISCOVER from "../src/pages/discover.astro?raw";
import HOME from "../src/pages/index.astro?raw";
import TOKENS from "../src/styles/tokens.css?raw";
import WRANGLER_TEST from "../wrangler.test.toml?raw";
import WRANGLER_PROD from "../wrangler.toml?raw";

/** The `<tag ...>` that opens the first element whose attributes include `marker`. */
function openingTag(source: string, tag: string, marker: string): string {
  const found = source.match(new RegExp(`<${tag}\\b[^>]*${marker}[^>]*>`));
  if (!found) throw new Error(`no <${tag}> carrying ${marker}`);
  return found[0];
}

/** The whole element, opening tag to matching closing tag (nested same-name tags counted). */
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

const words = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** `<style>` contents of an Astro file. */
const styleOf = (source: string) =>
  source.slice(source.indexOf("<style"), source.indexOf("</style>"));

const HEX = /#[0-9a-fA-F]{3,8}\b/;

describe("the toggle", () => {
  const markup = TOGGLE.slice(TOGGLE.indexOf("<button"), TOGGLE.indexOf("</button>") + 9);
  const tag = openingTag(markup, "button", "data-ai-toggle");

  it("is a button with aria-pressed, shipped hidden and pressed (on is the default), that submits nothing", () => {
    expect(tag).toMatch(/type="button"/);
    expect(tag).toMatch(/aria-pressed=\{on \? "true" : "false"\}/);
    expect(TOGGLE).toMatch(/on = true \} = Astro\.props/);
    expect(tag).toMatch(/\bhidden\b/);
    expect(rule(styleOf(TOGGLE), ".ai-toggle[hidden]")).toMatch(/display:\s*none/);
  });

  it("carries the notice as its title too", () => {
    expect(tag).toMatch(/title=\{disclosure\}/);
    expect(TOGGLE).toMatch(/const disclosure = AI_MODE_SEARCH_DISCLOSURE;/);
  });

  it("tells the reader in visible text, while AI Mode is on, what leaves the site", () => {
    const text = AI_MODE_SEARCH_DISCLOSURE;
    expect(text).toMatch(/search words/);
    expect(text).toMatch(/titles and descriptions of the top results/);
    expect(text).toMatch(/Open Science Assistant/);
    expect(text).toMatch(/AI model provider/);
    // Discover (the shared SearchBar) and Home each render the text as a paragraph that is always
    // in the page (a slot drawn with visibility, so showing it moves nothing) and that the client
    // shows only while AI Mode is on; a tooltip alone does not reach touch, keyboard or most screen
    // readers.
    for (const [source, name, selector] of [
      [SEARCH_BAR, "SearchBar", ".searchbar__ai-note"],
      [HOME, "Home", ".hero__ai-note"],
    ] as const) {
      const note = openingTag(source, "p", "data-ai-disclosure");
      expect(note, name).not.toMatch(/\bhidden\b/);
      expect(source, name).toMatch(/\{AI_MODE_SEARCH_DISCLOSURE\}/);
      expect(rule(styleOf(source), `${selector}:not([data-ai-visible])`), name).toMatch(
        /visibility:\s*hidden/,
      );
    }
    expect(CLIENT).toMatch(
      /\[data-ai-disclosure\][\s\S]{0,200}toggleAttribute\("data-ai-visible", on\)/,
    );
  });

  it("reads 'AI Mode' and draws one magnifier with a sparkle, hidden from assistive technology", () => {
    expect(words(markup)).toBe("AI Mode");
    const svgs = markup.match(/<svg\b[^>]*>/g) ?? [];
    expect(svgs).toHaveLength(1);
    expect(svgs[0]).toMatch(/aria-hidden="true"/);
    expect(svgs[0]).toMatch(/viewBox="0 0 24 24"/);
    expect(markup).toMatch(/<circle\b/);
    expect(markup.match(/<path\b/g)?.length).toBe(3);
  });

  it("is the 44 px pill with a 15 px label and a 22 px icon in the hero, and the field's pill in Discover", () => {
    const style = styleOf(TOGGLE);
    expect(rule(style, ".ai-toggle--lg")).toMatch(/block-size:\s*44px/);
    expect(rule(style, ".ai-toggle--lg")).toMatch(/font-size:\s*15px/);
    expect(rule(style, ".ai-toggle--lg .ai-toggle__icon")).toMatch(/inline-size:\s*22px/);
    expect(rule(style, ".ai-toggle--md")).toMatch(/block-size:\s*36px/);
    expect(rule(style, ".ai-toggle--md")).toMatch(/font-size:\s*13\.5px/);
    expect(rule(style, ".ai-toggle--md .ai-toggle__icon")).toMatch(/inline-size:\s*20px/);
    expect(rule(style, ".ai-toggle")).toMatch(/border-radius:\s*var\(--radius-pill\)/);
  });

  it("has no sparkle in either field and none on a Search button", () => {
    const sparkle = /M18 \.?\d/;
    expect(TOGGLE).toMatch(sparkle);
    expect(SEARCH_BAR).not.toMatch(sparkle);
    expect(elementMarkup(HOME, "form", 'class="hero__search bracketed"')).not.toMatch(sparkle);
    // The field's own magnifier is the only drawing in either field.
    const homeForm = elementMarkup(HOME, "form", 'class="hero__search bracketed"');
    for (const source of [SEARCH_BAR, homeForm]) expect(source.match(/<svg\b/g)?.length).toBe(1);
    const searchButtons = [
      elementMarkup(SEARCH_BAR, "button", 'class="searchbar__submit"'),
      elementMarkup(HOME, "button", 'type="submit"'),
    ];
    for (const button of searchButtons) {
      expect(words(button)).toBe("Search");
      expect(button).not.toMatch(/<svg/);
    }
  });

  it("is rendered only when an endpoint is set, in both fields", () => {
    expect(SEARCH_BAR).toMatch(/\{aiEndpoint && <AiModeToggle /);
    expect(HOME).toMatch(/\{aiEndpoint && <AiModeToggle /);
    expect(HOME).toContain('size="lg"');
    expect(SEARCH_BAR).toContain('size="md"');
    expect(DISCOVER).toContain("aiEndpoint={aiEndpoint}");
  });
});

describe("the panel", () => {
  it("is a section named 'AI overview', hidden until the client shows it", () => {
    const tag = openingTag(PANEL, "section", "data-ai-overview");
    expect(tag).toMatch(/aria-label="AI overview"/);
    expect(tag).toMatch(/\bhidden\b/);
    expect(rule(PANEL, ".ai-overview[hidden]")).toMatch(/display:\s*none/);
  });

  it("has a polite live region outside the hidden section, so a status is announced", () => {
    const tag = openingTag(PANEL, "div", "data-ai-status");
    expect(tag).toMatch(/aria-live="polite"/);
    expect(tag).toMatch(/role="status"/);
    // Neither hidden itself nor inside an element that is (display: none leaves the
    // accessibility tree, so nothing set there is announced).
    expect(tag).not.toMatch(/(?<![-\w])hidden(?![-\w])/);
    const section = elementMarkup(PANEL, "section", "data-ai-overview");
    expect(section).not.toMatch(/data-ai-status(?![-\w])/);
    expect(section).not.toMatch(/aria-live/);
    expect(PANEL.indexOf(tag)).toBeLessThan(PANEL.indexOf("<section"));
    // The drawn copy beside the heading is not read a second time.
    expect(openingTag(section, "span", "data-ai-status-text")).toMatch(/aria-hidden="true"/);
  });

  it("embeds the request as an escaped JSON data island, not as script", () => {
    expect(PANEL).toMatch(/escapeJsonLdForScript\(JSON\.stringify\(request\)\)/);
    const tag = openingTag(PANEL, "script", "data-ai-overview-request");
    expect(tag).toMatch(/type="application\/json"/);
    expect(tag).toMatch(/set:html=\{island\}/);
    expect(tag).toMatch(/is:inline/);
  });

  it("sits above the results on Discover, only when a request exists, and above the filters on a phone", () => {
    expect(DISCOVER).toMatch(/<AiOverviewPanel request=\{aiRequest\} pageNote=\{aiPageNote\} \/>/);
    expect(DISCOVER).toMatch(/\(aiRequest \|\| aiPageNote\) && \(/);
    // Its own grid row beside the rail, between the rail and the results in the markup.
    const panel = DISCOVER.indexOf("<AiOverviewPanel");
    expect(panel).toBeGreaterThan(DISCOVER.indexOf('class="discover__rail"'));
    expect(panel).toBeLessThan(DISCOVER.indexOf('class="discover__results"'));
    const style = styleOf(DISCOVER);
    expect(rule(style, ".discover__overview")).toMatch(/grid-area:\s*overview/);
    expect(rule(style, ".discover__layout")).toMatch(/"rail overview"\s*"rail results"/);
    // One column at 880 px and below: the overview first, then the filters, then the results.
    const phone = style.slice(style.indexOf("@media (max-width: 880px)"));
    expect(phone).toMatch(/"overview"\s*"rail"\s*"results"/);
    expect(DISCOVER).toContain("overviewRequestForPage({");
    expect(DISCOVER).toContain("failed: fetchError !== null");
  });

  it("guards the switch off like the switch on, so a render bug cannot skip the other toggle steps", () => {
    expect(CLIENT).toMatch(
      /setOn\(on: boolean\): void \{\s*try \{\s*void this\.controller\.setOn\(on\);\s*\} catch \(err\) \{\s*console\.warn\(/,
    );
  });

  it("is built inside a try/catch that logs, so an odd catalog row cannot fail the page", () => {
    const start = DISCOVER.indexOf("let aiRequest");
    const block = DISCOVER.slice(start, DISCOVER.indexOf("const aiPageNote"));
    expect(block).toMatch(/try\s*\{[\s\S]*overviewRequestForPage\(/);
    expect(block).toMatch(/catch \(err\)\s*\{\s*console\.error\("\[ai-overview\]/);
    expect(block).not.toMatch(/state\.q\b[^,\n]*console|console[^\n]*state\.q\b/);
  });

  it("explains on page 2 and later, while AI Mode is on, why there is no overview", () => {
    expect(DISCOVER).toMatch(/const aiPageNote =[\s\S]*?state\.page > 1/);
    const note = openingTag(PANEL, "p", "data-ai-note");
    expect(note).toMatch(/\bhidden\b/);
    expect(rule(PANEL, ".ai-overview-note[hidden]")).toMatch(/display:\s*none/);
    expect(CLIENT).toMatch(/\[data-ai-note\][\s\S]{0,80}\.hidden = !on/);
  });

  it("has no note of its own for a short search: the line under the field replaces it", () => {
    expect(CLIENT).not.toMatch(/view\.note|ai-overview__hint/);
    expect(PANEL).not.toContain("ai-overview__hint");
    expect(CLIENT).toContain("query: request.query,");
    // Its status goes to the polite region that is already there, not to a new one.
    expect(PANEL.match(/aria-live=/g)).toHaveLength(1);
  });

  it("is written with textContent, never as markup", () => {
    expect(CLIENT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|set:html/);
    expect(CLIENT).toContain("textContent");
    expect(CLIENT).toContain("createTextNode(segment.text)");
  });
});

describe("the field stays put", () => {
  it("has no hidden attribute to toggle on the Try row, the disclosure or the line", () => {
    for (const [source, name] of [
      [SEARCH_BAR, "SearchBar"],
      [HOME, "Home"],
    ] as const) {
      for (const marker of ["data-ai-try", "data-ai-disclosure", "data-ai-hint"]) {
        if (!source.includes(marker)) continue;
        const tag = source.match(new RegExp(`<[a-z]+\\b[^>]*${marker}(?![-\\w])[^>]*>`))?.[0] ?? "";
        expect(tag, `${name} ${marker}`).not.toMatch(/(?<![-\w])hidden\b/);
      }
    }
    // The client shows and hides them with an attribute that only the visibility rules read.
    expect(CLIENT).not.toMatch(/(?:row|slot|line)\.hidden/);
  });

  it("renders every slot whenever the endpoint is set, so the server reserves the space", () => {
    expect(HOME).toMatch(/\{aiEndpoint && \(\s*<div class="hero__try" data-ai-try>/);
    expect(HOME).toMatch(/\{aiEndpoint && \(\s*<p class="hero__ai-note" data-ai-disclosure>/);
    expect(SEARCH_BAR).toMatch(
      /aiEndpoint && \(\s*<p class="searchbar__ai-note" data-ai-disclosure>/,
    );
  });

  it("keeps the Discover field 44 px in both states, set rather than left to the line height", () => {
    const style = styleOf(SEARCH_BAR);
    expect(rule(style, '.searchbar--ai input[type="search"]')).toMatch(/block-size:\s*44px/);
    expect(
      rule(style, '.searchbar--ai .searchbar__field[data-ai="on"] input[type="search"]'),
    ).toMatch(/block-size:\s*calc\(44px - 3px\)/);
  });

  it("is checked in a browser: the field's top before and after the toggle, light, dark, phone", () => {
    expect(E2E).toContain("getBoundingClientRect");
    expect(E2E).toContain("TOLERANCE = 0.5");
    for (const width of ["1280", "390"]) expect(E2E).toContain(width);
    for (const scheme of ['"light"', '"dark"']) expect(E2E).toContain(scheme);
    expect(E2E).toContain("scrollWidth");
    expect(PLAYWRIGHT_CONFIG).toContain('testDir: "./e2e"');
    expect(PACKAGE).toMatch(/"test:e2e":\s*"playwright test"/);
  });
});

describe("the line under the field", () => {
  const sources = [
    [SEARCH_BAR, "SearchBar", ".searchbar__ai-hint", "--color-fg-muted"],
    [HOME, "Home", ".hero__ai-hint", "--ai-try-label"],
  ] as const;

  it("is one paragraph with the maintainer's words, on Discover and on Home, never hidden", () => {
    for (const [source, name] of sources) {
      const tag = openingTag(source, "p", "data-ai-hint");
      expect(tag, name).toMatch(/aria-hidden="true"/);
      expect(tag, name).not.toMatch(/\bhidden\b(?!=)/);
      expect(source, name).toMatch(/\{AI_MODE_HINT\}/);
      expect(source.match(/data-ai-hint(?![-\w])/g), name).toHaveLength(1);
    }
    expect(AI_MODE_HINT).toBe("AI Mode is on. Use three or more words to see an AI response.");
  });

  it("is in the smallest helper size the site has, a muted token and no error colour", () => {
    expect(TOKENS).toMatch(/--fs-xs:\s*0\.75rem/);
    for (const [source, name, selector, colour] of sources) {
      const style = styleOf(source);
      const declarations = rule(style, selector);
      expect(declarations, name).toMatch(/font-size:\s*var\(--fs-xs\)/);
      expect(declarations, name).toContain(`color: var(${colour})`);
      expect(declarations, name).not.toMatch(HEX);
      expect(declarations, name).not.toMatch(/error|danger|warning|red/);
      // Drawn with visibility, so it keeps its row: showing it moves nothing.
      expect(rule(style, `${selector}:not([data-ai-visible])`), name).toMatch(
        /visibility:\s*hidden/,
      );
    }
  });

  it("is announced by one polite live region per page, whose text the client sets on a change", () => {
    for (const [source, name] of sources) {
      const tag = openingTag(source, "span", "data-ai-hint-status");
      expect(tag, name).toMatch(/role="status"/);
      expect(tag, name).toMatch(/aria-live="polite"/);
      expect(tag, name).toMatch(/visually-hidden/);
    }
    expect(CLIENT).toMatch(/if \(announcement === null\) return;/);
    expect(CLIENT).toContain("aiHintAnnouncement(this.shown, shown)");
    // It follows the field as the reader types, and shows for a 422 too.
    expect(CLIENT).toMatch(/addEventListener\("input"/);
    expect(CLIENT).toContain('state.kind === "refused"');
    expect(CLIENT).toContain('line.toggleAttribute("data-ai-visible", shown)');
  });
});

describe("colours", () => {
  /** Roles whose value follows the theme. */
  const themed = [
    "--ai-ring-shadow",
    "--ai-toggle-on-bg",
    "--ai-toggle-on-fg",
    "--ai-toggle-on-border",
    "--ai-toggle-off-bg",
    "--ai-toggle-off-fg",
    "--ai-try-label",
    "--ai-try-bg",
    "--ai-try-border",
    "--ai-try-fg",
    "--ai-panel-bg",
    "--ai-panel-border",
    "--ai-panel-fg",
    "--ai-panel-title",
    "--ai-panel-muted",
    "--ai-panel-accent",
    "--ai-panel-skeleton-a",
    "--ai-panel-skeleton-b",
    "--ai-panel-chip-bg",
    "--ai-panel-chip-border",
    "--ai-panel-divider",
    "--ai-panel-badge",
    "--ai-panel-action-bg",
    "--ai-panel-action-fg",
  ];
  /** Constant in both themes on purpose: the hero's field is white in both, and the ring is the
   *  brand gradient. */
  const constant = [
    "--ai-ring-gradient",
    "--ai-toggle-field-on-bg",
    "--ai-toggle-field-on-fg",
    "--ai-toggle-field-on-border",
    "--ai-toggle-field-off-bg",
    "--ai-toggle-field-off-fg",
  ];
  const light = TOKENS.slice(TOKENS.indexOf(":root {"), TOKENS.indexOf("/* Dark theme"));
  const auto = TOKENS.slice(
    TOKENS.indexOf("@media (prefers-color-scheme: dark)"),
    TOKENS.indexOf(':root[data-theme="dark"]'),
  );
  const explicit = TOKENS.slice(TOKENS.indexOf(':root[data-theme="dark"]'));

  it("defines every role as a token in the light theme", () => {
    for (const role of [...themed, ...constant]) expect(light, role).toContain(`${role}:`);
  });

  it("gives every themed role a dark counterpart, under the guarded media query and the explicit theme", () => {
    expect(auto).toContain(':root:not([data-theme="light"])');
    for (const role of themed) {
      expect(auto, `${role} in the media query`).toContain(`${role}:`);
      expect(explicit, `${role} in [data-theme=dark]`).toContain(`${role}:`);
    }
  });

  it("uses the AI Mode tint, #e3f4f9 with #0b4f63, for the toggle that is on", () => {
    expect(light).toMatch(/--ai-toggle-on-bg:\s*#e3f4f9;/);
    expect(light).toMatch(/--ai-toggle-on-fg:\s*#0b4f63;/);
  });

  it("draws the ring with the Download headline's gradient", () => {
    expect(light).toMatch(
      /--ai-ring-gradient:\s*linear-gradient\(92deg,\s*var\(--brand-teal\),\s*var\(--brand-purple\)\)/,
    );
    expect(rule(styleOf(SEARCH_BAR), '.searchbar__field[data-ai="on"]')).toMatch(
      /background:\s*var\(--ai-ring-gradient\)/,
    );
    expect(rule(styleOf(HOME), '.hero__search-control[data-ai="on"]')).toMatch(
      /background:\s*var\(--ai-ring-gradient\)/,
    );
  });

  it("writes no colour literal in the new component styles", () => {
    expect(styleOf(TOGGLE)).not.toMatch(HEX);
    expect(PANEL.slice(PANEL.indexOf("<style"))).not.toMatch(HEX);
    const searchBarAi = SEARCH_BAR.slice(SEARCH_BAR.indexOf("/* AI Mode (board D2)"));
    expect(searchBarAi).not.toMatch(HEX);
    const heroAi = HOME.slice(
      HOME.indexOf("/* AI Mode (board D1)"),
      HOME.indexOf("/* Body: bracketed"),
    );
    expect(heroAi.length).toBeGreaterThan(500);
    expect(heroAi).not.toMatch(HEX);
  });
});

/** The "Try" row's example searches, read from the page's source. */
function homeExamples(): string[] {
  const list = HOME.match(/const AI_EXAMPLES = \[([\s\S]*?)\];/);
  if (!list) throw new Error("no AI_EXAMPLES list in index.astro");
  return [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("Home", () => {
  const form = elementMarkup(HOME, "form", 'class="hero__search bracketed"');

  it("keeps the form as it was: a GET to /discover with the same input and Search button", () => {
    expect(openingTag(HOME, "form", 'class="hero__search bracketed"')).toBe(
      '<form class="hero__search bracketed" action="/discover" method="get" role="search">',
    );
    expect(form).toMatch(
      /<input[^>]*name="q"[^>]*placeholder=\{aiEndpoint \? AI_PLACEHOLDER : PLAIN_PLACEHOLDER\}/s,
    );
    expect(HOME).toContain('const PLAIN_PLACEHOLDER = "Enter keyword or phrase";');
    // Nothing in the markup submits `ai`: AI Mode is on by default, so no `ai` means on, and the
    // client adds `ai=0` only while it is off.
    expect(form).not.toMatch(/name="ai"/);
  });

  it("wraps the field and shows the Try row only when the endpoint is set", () => {
    expect(HOME).toContain('const FieldControl = aiEndpoint ? "div" : Fragment;');
    expect(HOME).toMatch(/\{aiEndpoint && \(\s*<div class="hero__try" data-ai-try>/);
    expect(HOME).toContain('const AI_PLACEHOLDER = "Describe the data you need, in plain words";');
    expect(rule(styleOf(HOME), ".hero__try:not([data-ai-visible])")).toMatch(
      /visibility:\s*hidden/,
    );
  });

  it("offers only examples the overview accepts: every one has at least three words", () => {
    const examples = homeExamples();
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(countQueryWords(example), example).toBeGreaterThanOrEqual(OVERVIEW_MIN_WORDS);
    }
    // The row renders exactly this list.
    expect(HOME).toContain("AI_EXAMPLES.map((example) =>");
  });

  it("submits ai=0 to /discover only while off: the client adds the input, and removes it when on", () => {
    expect(CLIENT).toMatch(/input\.name = "ai";\s*input\.value = "0";/);
    expect(CLIENT).toMatch(/if \(on\) \{\s*existing\?\.remove\(\);\s*return;\s*\}/);
    expect(CLIENT).toContain("syncAiInput(doc, toggle, on)");
    // Discover's own form gets the same input from the server when the address has ai=0, so a
    // search submitted without scripts does not flip an off to the default on.
    expect(SEARCH_BAR).toMatch(/\{aiEndpoint && !aiOn && <input type="hidden" name="ai" value="0"/);
    expect(SEARCH_BAR).toMatch(/aiOn = true,/);
  });

  it("renders the on state for everyone and lets the client switch off, because the page is cached", () => {
    expect(HOME).toMatch(/"data-ai": "on"/);
    expect(SEARCH_BAR).toContain('aiOn ? "on" : "off"');
    expect(SEARCH_BAR).toContain("on={aiOn}");
    // A widget that never loads leaves the server's on state with nothing behind it: it is undone.
    expect(CLIENT).toMatch(/if \(ready\.length === 0\) \{[\s\S]{0,200}paint\(toggles, false\)/);
  });

  it("fills the field from an example and submits the form", () => {
    expect(CLIENT).toContain("input.value = button.textContent");
    expect(CLIENT).toContain("form.requestSubmit()");
  });
});

describe("the setting", () => {
  const key = "PUBLIC_OSA_OVERVIEW_URL";
  const value = (source: string, pattern: RegExp) => source.match(pattern)?.[1];

  it("is set to the develop worker in wrangler.test.toml and deploy-test.yml, and is a URL the site accepts", () => {
    const fromToml = value(WRANGLER_TEST, new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
    const fromYaml = value(DEPLOY_TEST, new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, "m"));
    expect(fromToml).toBe("https://develop-widget.osc.earth/osa/nemar/overview");
    expect(fromYaml).toBe(fromToml);
    expect(OVERVIEW_ENDPOINTS).toContain(fromToml as (typeof OVERVIEW_ENDPOINTS)[number]);
    expect(resolveOverviewEndpoint(fromToml).kind).toBe("enabled");
  });

  it("is absent from wrangler.toml, so production shows no toggle", () => {
    expect(WRANGLER_PROD).not.toContain(key);
  });
});

describe("AI Mode on the page", () => {
  it("is reached by one script, once per page, from the toggle component", () => {
    expect(TOGGLE).toMatch(
      /<script>\s*import \{ initAiModeSearch \} from "\.\.\/lib\/ai-mode-search-client";/,
    );
    expect(CLIENT).toContain("whenDocumentReady(");
    expect(CLIENT).toContain("aiModeSearchAvailable(widgetWindow, t.dataset.aiEndpoint)");
  });

  it("carries ai=0 on Discover's own links and in its form, and Discover's paging reads it from the URL", () => {
    expect(openingTag(TOGGLE, "button", "data-ai-toggle")).toMatch(/data-ai-links=\{carryLinks/);
    expect(SEARCH_BAR).toContain("carryLinks");
    expect(DISCOVER).toContain("aiOn={state.ai}");
    expect(DISCOVER).toContain("filterStateToURL(state)");
  });
});
