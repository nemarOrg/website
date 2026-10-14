/**
 * Source-level guards for the administrator approval page's review panel (website#459).
 *
 * The page script draws a panel from `panelModel`, and the repo has no rendering harness (no jsdom,
 * no Playwright), so what can be pinned here is the arrangement: which lib functions the script
 * uses for which words, that the body of an Approve comes from `approveBody` and nowhere else, that
 * a denial names its request, that text reaches the DOM only through `textContent`, and that the
 * quiet auto-refresh never runs while a panel is open. The decisions themselves (what is offered,
 * what is said) are tested over captured fixtures in `src/lib/publication-review.test.ts`; layout,
 * focus order and forced colors are the maintainer's browser checklist in the pull request.
 *
 * Same pattern as `test/account-tiers-ui.test.ts` and `test/publish-block-reason.test.ts`: Vite's
 * `?raw`, not `node:fs`, because `astro check` has no node types.
 */

import { describe, expect, it } from "vitest";
import ROW from "../src/components/PublicationRequestRow.astro?raw";
import PAGE from "../src/pages/admin/publication-requests.astro?raw";
import { fixture } from "./publication-review-fixtures";
import { terminalFlaws } from "./publication-review-web-words";

/**
 * `node:fs`, reached without a static import (`astro check` has no node types; the same escape
 * hatch as `test/publication-review-copy-drift.test.ts`). Vitest blanks every stylesheet it
 * imports, `?raw` included, unless `vitest.config.ts` lets it through, so the two stylesheets this
 * file reads are read from disk instead.
 */
async function readStyle(name: string): Promise<string> {
  const specifier = "node:fs";
  const fs: { readFileSync(path: string, encoding: string): string } = await import(
    /* @vite-ignore */ specifier
  );
  return fs.readFileSync(
    decodeURIComponent(new URL(`../src/styles/${name}`, import.meta.url).pathname),
    "utf8",
  );
}

const STYLES = await readStyle("publication-review-panel.css");
const TOKENS = await readStyle("tokens.css");

/** Drop comments so an assertion reads code, not the prose that explains why a word is absent. */
function code(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The page's client `<script>`, comments dropped. */
function pageScript(): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(PAGE);
  if (!match) throw new Error("publication-requests.astro has no client <script>");
  return code(match[1]);
}

const SCRIPT = pageScript();
const ROW_CODE = code(ROW);
const PAGE_CODE = code(PAGE);

/** Every argument list of a call, from the opening parenthesis to its matching one. */
function callArguments(src: string, name: string): string[] {
  const out: string[] = [];
  let at = src.indexOf(`${name}(`);
  while (at !== -1) {
    let depth = 0;
    let end = at + name.length;
    for (let i = end; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out.push(src.slice(at + name.length + 1, end));
    at = src.indexOf(`${name}(`, end);
  }
  return out;
}

/** The body of the click handler registered on a selector, up to the next registration. */
function handlerOf(selector: string): string {
  const start = SCRIPT.indexOf(`"${selector}"`);
  if (start === -1) throw new Error(`the script registers nothing on ${selector}`);
  const next = SCRIPT.indexOf("querySelectorAll", start + 1);
  return SCRIPT.slice(start, next === -1 ? undefined : next);
}

describe("the three files are read (the guards below are not vacuous)", () => {
  it("finds the script, the row, the stylesheet and the tokens", () => {
    expect(SCRIPT).toContain("getPublicationReview(");
    expect(ROW_CODE).toContain("data-pubreq-row");
    expect(STYLES).toContain(".pubreq-review");
    expect(TOKENS).toContain("--color-bg:");
  });
});

describe("the script words the panel through the lib, never by itself", () => {
  it("imports the pure functions and the page-owned words from lib/publication-review", () => {
    const imports = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/\.\.\/lib\/publication-review"/.exec(
      SCRIPT,
    );
    expect(imports, "no import from lib/publication-review").not.toBeNull();
    const names = (imports?.[1] ?? "").split(",").map((n) => n.trim().replace(/^type\s+/, ""));
    for (const name of [
      "panelModel",
      "approveBody",
      "describeFailure",
      "describeStartSuccess",
      "UI_WORDS",
      "FRIENDLY_WORDS",
      "ACK_MAX",
      "DENIAL_MAX",
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it("builds the panel from panelModel with the row's own start", () => {
    expect(SCRIPT).toMatch(/panelModel\(\s*detail\s*,\s*\{\s*rowStart/);
  });

  // Each word the lib exposes on a PanelModel has to be drawn, or the page silently drops it.
  it.each([
    ["the headline", /model\.headline/],
    ["the identifier screen", /model\.screen/],
    ["the reasons", /model\.reasons\b/],
    ["the withheld-reasons words", /model\.reasonsWithheld/],
    ["the fact notes", /model\.factNotes/],
    ["the model text", /model\.model\b/],
    ["the summary label", /\.summaryLabel/],
    ["the findings label", /\.findingsLabel/],
    ["a finding's label, document and note", /\.documentLabel/],
    ["the standing line", /model\.standing/],
    ["whether a start is offered", /model\.start\.offered/],
    ["the override label", /model\.overrideLabel/],
    ["the acknowledgment prompt", /model\.ackPrompt/],
    ["the control's notice", /\.notice\b/],
    ["the withheld and read-only lines", /\.lines\b/],
    ["the unavailable control's sentence", /model\.approve\.text\b/],
    ["the reason's class tag", /\.classLabel/],
    ["the reason's cleared tag", /\.clearedLabel/],
    ["a reason's statement and cure", /\.statement[\s\S]*\.cure|\.cure[\s\S]*\.statement/],
  ])("draws %s", (_what, pattern) => {
    expect(SCRIPT).toMatch(pattern);
  });

  it("words a started review through describeStartSuccess and a failure through describeFailure", () => {
    expect(SCRIPT).toContain("describeStartSuccess(");
    for (const op of ["approve", "deny", "start", "detail"]) {
      expect(SCRIPT, op).toContain(`describeFailure("${op}"`);
    }
  });

  it("acts on every follow-up a failure asks for", () => {
    // `resetOverride` is deliberately not read: a re-read redraws the panel from the new answer, so
    // the override box always comes back unticked, which is stricter than the flag.
    for (const flag of ["refetch", "focusAck", "refreshLink"]) {
      expect(SCRIPT, flag).toMatch(new RegExp(`\\.${flag}\\b`));
    }
  });

  it("takes every button and heading word from UI_WORDS", () => {
    for (const word of [
      "headings.review",
      "headings.screen",
      "headings.reasons",
      "headings.checks",
      "buttons.show",
      "buttons.hide",
      "buttons.loading",
      "buttons.start",
      "buttons.refresh",
      "buttons.approve",
      "buttons.resume",
      "buttons.retry",
    ]) {
      expect(SCRIPT, word).toContain(`UI_WORDS.${word}`);
    }
  });

  it("holds no sentence of the Worker's, however it arrived", () => {
    for (const name of [
      "approve-needs-override",
      "approve-hard-reason",
      "approve-override-not-covering",
      "approve-review-changed",
      "approve-no-review-row",
      "approve-screen-blocks",
      "approve-screen-acknowledge",
      "approve-screen-rerun",
      "approve-screen-wait",
      "approve-not-dispatchable",
    ]) {
      const { body } = fixture<{ message?: string }>(name);
      expect(typeof body.message, `${name} has a message`).toBe("string");
      expect(SCRIPT, name).not.toContain(body.message as string);
    }
  });

  it("holds no string literal that words a terminal", () => {
    const literals = SCRIPT.match(/"(?:[^"\\\n]|\\.)*"/g) ?? [];
    expect(literals.length).toBeGreaterThan(10);
    const flawed = literals.flatMap((l) =>
      terminalFlaws(l.slice(1, -1), 1).map((f) => `${l}: ${f}`),
    );
    expect(flawed).toEqual([]);
  });
});

describe("the Approve body comes from the builder and nowhere else", () => {
  it("calls dispatchPublicationApproval only with a body argument", () => {
    const calls = callArguments(SCRIPT, "dispatchPublicationApproval");
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args, args).toMatch(/\{\s*body\b/);
  });

  it("computes the body with approveBody from the control stored at render time", () => {
    expect(SCRIPT).toContain("approveBody(");
    expect(SCRIPT).toMatch(/state\.control\s*=/);
    expect(SCRIPT).toMatch(/approveBody\(\s*control\s*,/);
  });

  it("names no field of the body itself", () => {
    expect(SCRIPT).not.toMatch(/request_id\s*:/);
    expect(SCRIPT).not.toContain("override_publication_review");
    expect(SCRIPT).not.toContain("acknowledge_identifier_screen");
    expect(SCRIPT).not.toContain("JSON.stringify");
  });

  it("disables Approve until the builder says the inputs are complete", () => {
    expect(SCRIPT).toMatch(/\.disabled\s*=\s*!/);
    expect(SCRIPT).toMatch(/\.ok\b/);
  });

  it("bounds the reason field with the lib's limit", () => {
    expect(SCRIPT).toMatch(/maxLength\s*=\s*ACK_MAX/);
  });
});

describe("Approve and Resume open the panel, and the typed dialog stays the last step", () => {
  it("opens the panel, not a dialog, from the row's Approve button", () => {
    const handler = handlerOf("[data-pubreq-approve]");
    expect(handler).toContain("openPanel(");
    expect(handler).not.toContain("openDialog(");
  });

  it("opens the panel, not a dialog, from the row's Resume button", () => {
    const handler = handlerOf("[data-pubreq-resume]");
    expect(handler).toContain("openPanel(");
    expect(handler).not.toContain("openDialog(");
  });

  it("opens the existing dialog only from the panel's own Approve button", () => {
    const opens = [...SCRIPT.matchAll(/(?<!function )openDialog\(([^)]*)\)/g)].map((m) =>
      m[1].trim(),
    );
    expect(opens.sort()).toEqual(['"admin-deny"', "control.dialogId"].sort());
  });

  it("refetches the detail on every open", () => {
    const open = /async function openPanel[\s\S]*?\n {2}\}/.exec(SCRIPT);
    expect(open, "no openPanel").not.toBeNull();
    expect(open?.[0]).toContain("loadPanel(");
    expect(SCRIPT.match(/getPublicationReview\(/g)?.length).toBe(1);
  });

  it("keeps the three confirmation dialogs, with the typed word on both approvals", () => {
    for (const id of ["admin-approve", "admin-approve-anonymous", "admin-resume", "admin-deny"]) {
      expect(PAGE_CODE, id).toContain(`dialogId="${id}"`);
    }
    for (const id of ["admin-approve", "admin-approve-anonymous"]) {
      const block = new RegExp(`<ConfirmDialog[^>]*dialogId="${id}"[^>]*>`).exec(PAGE_CODE);
      expect(block?.[0], id).toContain('requireTyping="PUBLISH"');
    }
    const resume = /<ConfirmDialog[^>]*dialogId="admin-resume"[^>]*>/.exec(PAGE_CODE);
    expect(resume?.[0]).not.toContain("requireTyping");
  });

  it("re-reads after a refusal and keeps the reason the administrator typed", () => {
    expect(SCRIPT).toMatch(/refetch[\s\S]{0,200}loadPanel\(/);
    expect(SCRIPT).toMatch(/acknowledgment\s*:/);
  });

  it("moves focus to the reason field on an acknowledge refusal", () => {
    expect(SCRIPT).toMatch(/focusAck[\s\S]{0,200}\.focus\(\)/);
  });

  it("shows a refusal in an alert region of the panel", () => {
    expect(SCRIPT).toContain("data-pubreq-review-error");
    expect(SCRIPT).toMatch(/role["']?,\s*"alert"/);
  });
});

describe("a denial names its request", () => {
  it("passes requestId on every denyPublicationRequest call", () => {
    const calls = callArguments(SCRIPT, "denyPublicationRequest");
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args, args).toMatch(/\brequestId\b/);
  });

  it("reads the request id from the button and bounds the reason", () => {
    expect(handlerOf("[data-pubreq-deny]")).toContain("dataset.requestId");
    expect(SCRIPT).toMatch(/\.length\s*>\s*DENIAL_MAX/);
  });
});

describe("the quiet auto-refresh never runs over an open panel", () => {
  it("names the visible panel in the quiet test", () => {
    const quiet = /const quiet =[\s\S]*?;\n/.exec(SCRIPT);
    expect(quiet, "no quiet test").not.toBeNull();
    expect(quiet?.[0]).toContain("[data-pubreq-review-panel]:not([hidden])");
  });
});

describe("text reaches the DOM only as text", () => {
  it.each([
    ["the page", PAGE_CODE],
    ["the row", ROW_CODE],
  ])("%s builds no markup from a string", (_name, src) => {
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|set:html/);
  });

  it("draws with createElement and textContent", () => {
    expect(SCRIPT).toContain("createElement(");
    expect(SCRIPT).toContain("textContent");
  });

  it.each([
    ["the script", SCRIPT],
    // The row's one existing `.command` is the terminal hint of a backend that cannot dispatch an
    // approval (`rowView().terminal`), not a field of the review detail; nothing else may read one.
    ["the row", ROW_CODE.replace("view.terminal.command", "")],
  ])("%s never reads a field the Worker words for a terminal", (_name, src) => {
    expect(src).not.toMatch(/\.line\b/);
    expect(src).not.toMatch(/\.command\b/);
    expect(src).not.toMatch(/\.next\b/);
    expect(src).not.toMatch(/\[\s*["'](line|command|next)["']\s*\]/);
    expect(src).not.toMatch(/description\.lines/);
  });

  it.each([
    ["the script", SCRIPT],
    ["the row", ROW_CODE],
  ])("%s never computes a verdict", (_name, src) => {
    expect(src).not.toMatch(/outcome\s*[!=]==?/);
  });
});

describe("the row", () => {
  it("draws the chips from rowChips and decides nothing", () => {
    expect(ROW_CODE).toContain("rowChips(");
    expect(ROW_CODE).toContain("data-pubreq-review-chip");
    expect(ROW_CODE).toContain("data-pubreq-screen-chip");
    for (const tone of ["ok", "note", "warn", "stop"]) {
      expect(ROW_CODE, tone).toContain(`.pubreq-chip--${tone}`);
    }
  });

  it("carries the panel and its toggle, closed, for an active request", () => {
    expect(ROW_CODE).toContain("data-pubreq-review-toggle");
    expect(ROW_CODE).toContain("data-pubreq-review-panel");
    expect(ROW_CODE).toContain('aria-expanded="false"');
    expect(ROW_CODE).toContain("aria-controls");
    expect(ROW_CODE).toMatch(/<section[^>]*data-pubreq-review-panel[^>]*\shidden[\s>]/);
    for (const status of ["requested", "approving", "blocked"]) {
      expect(ROW_CODE, status).toContain(`"${status}"`);
    }
  });

  it("hands the script the request, the row's own start and its label", () => {
    expect(ROW_CODE).toContain("data-request-id={request.id}");
    expect(ROW_CODE).toContain("data-row-start");
    expect(ROW_CODE).toContain("data-row-label");
    const buttons = ROW_CODE.match(/<button[\s\S]*?>/g) ?? [];
    for (const attr of ["data-pubreq-approve", "data-pubreq-resume", "data-pubreq-deny"]) {
      const tag = buttons.find((b) => b.includes(attr));
      expect(tag, attr).toBeDefined();
      expect(tag, attr).toContain("data-request-id");
    }
  });

  it("labels the toggle from the page's own words", () => {
    expect(ROW_CODE).toContain("UI_WORDS.buttons.show");
  });
});

describe("the page loads the panel's stylesheet", () => {
  it("imports it in the frontmatter", () => {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(PAGE)?.[1] ?? "";
    expect(frontmatter).toContain('import "../../styles/publication-review-panel.css"');
  });
});

describe("the panel's stylesheet", () => {
  const css = code(STYLES);

  it("uses tokens for every color and defines no palette of its own", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(|\bhsla?\(/);
    expect(css).not.toMatch(/:\s*(white|black|red|green|blue|gray|grey)\b/);
  });

  it("uses only custom properties the tokens define", () => {
    const own = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(10);
    const unknown = used.filter((name) => !own.has(name) && !TOKENS.includes(`${name}:`));
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("follows the theme through tokens alone, with no dark rule of its own", () => {
    expect(css).not.toContain("prefers-color-scheme");
    expect(css).not.toContain("data-theme");
  });

  it("styles each tone the script can draw", () => {
    expect(SCRIPT).toContain("pubreq-review-tone--");
    for (const tone of ["ok", "note", "warn", "stop"]) {
      expect(css, tone).toContain(`.pubreq-review-tone--${tone}`);
    }
  });

  it("has a forced-colors fallback, a visible focus ring and a narrow wrap", () => {
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toMatch(/@media \(max-width: 640px\)/);
  });

  it("scopes every rule under the panel's own prefix", () => {
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].flatMap((m) => m[2].split(","));
    const stray = selectors.map((s) => s.trim()).filter((s) => s && !/\.pubreq-review/.test(s));
    expect(stray).toEqual([]);
  });
});
