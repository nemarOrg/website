/**
 * Source-level guards for the administrator approval page's script (website#459).
 *
 * The words the panel prints are not tested here: the panel is drawn as a plain tree by
 * `src/lib/publication-review-panel.ts`, and `src/lib/publication-review-panel.test.ts` reads that
 * tree over captured fixtures, so deleting a sentence, line, label, prompt or button fails there.
 * What stays in the script is wiring, and that is what this file pins, each against the exact
 * statement that implements it: which client function is called with what, the in-flight guard, the
 * stale-answer token, the quiet-refresh guard, the busy buttons, the typed reason kept across a
 * re-read, the retry label, the row-versus-detail request check, the guard around the drawing,
 * focus and the announcement of a notice.
 *
 * There is no rendering harness: no jsdom or happy-dom, and Playwright is installed but has no spec
 * for this page. Layout, focus order and forced colors are the maintainer's browser checklist in
 * the pull request.
 *
 * Same pattern as `test/account-tiers-ui.test.ts` and `test/publish-block-reason.test.ts`: Vite's
 * `?raw`, not `node:fs`, for scripts and components (`astro check` has no node types).
 */

import { describe, expect, it } from "vitest";
import CONFIRM_DIALOG from "../src/components/ConfirmDialog.astro?raw";
import ROW from "../src/components/PublicationRequestRow.astro?raw";
import PANEL from "../src/lib/publication-review-panel.ts?raw";
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
const PANEL_CODE = code(PANEL);
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

/** The text of a top-level function of the script, from its keyword to its closing brace. */
function functionOf(name: string): string {
  const match = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(SCRIPT);
  if (!match) throw new Error(`the script has no function ${name}`);
  return match[0];
}

describe("the four files are read (the guards below are not vacuous)", () => {
  it("finds the script, the row, the panel module, the stylesheet and the tokens", () => {
    expect(SCRIPT).toContain("getPublicationReview(");
    expect(ROW_CODE).toContain("data-pubreq-row");
    expect(PANEL_CODE).toContain("export function panelTree");
    expect(STYLES).toContain(".pubreq-review");
    expect(TOKENS).toContain("--color-bg:");
  });

  it("reads the functions it pins", () => {
    for (const name of [
      "mount",
      "queue",
      "drawPanel",
      "loadPanel",
      "closePanel",
      "dropPendingApproval",
      "reportFailure",
      "startReview",
      "afterApproveFailure",
      "setApproveBusy",
      "setToggle",
      "announce",
      "syncRefreshNote",
      "wireControls",
      "wireRefresh",
      "openFromRow",
      "setPanelError",
    ]) {
      expect(functionOf(name).length, name).toBeGreaterThan(40);
    }
  });
});

describe("the script words the panel through the lib, never by itself", () => {
  it("imports the pure functions and the page-owned words from both lib modules", () => {
    for (const [from, wanted] of [
      [
        "publication-review",
        [
          "panelModel",
          "approveBody",
          "describeFailure",
          "describeStartSuccess",
          "UI_WORDS",
          "FRIENDLY_WORDS",
          "ACK_MAX",
          "DENIAL_MAX",
        ],
      ],
      [
        "publication-review-panel",
        [
          "panelTree",
          "loadingTree",
          "failureTree",
          "staleRowTree",
          "errorTree",
          "rowIsStale",
          "toggleLabels",
          "PANEL_WORDS",
          "BUSY_FAILURE",
          "DRAW_FAILURE",
        ],
      ],
    ] as const) {
      const imports = new RegExp(
        `import\\s*\\{([^}]*)\\}\\s*from\\s*"\\.\\./\\.\\./lib/${from}"`,
      ).exec(SCRIPT);
      expect(imports, `no import from lib/${from}`).not.toBeNull();
      const names = (imports?.[1] ?? "").split(",").map((n) => n.trim().replace(/^type\s+/, ""));
      for (const name of wanted) expect(names, `${from}: ${name}`).toContain(name);
    }
  });

  it("builds the panel from panelModel with the row's own start", () => {
    expect(SCRIPT).toMatch(/panelModel\(detail,\s*\{\s*rowStart:\s*rowStartOf\(panel\)\s*\}\)/);
  });

  it("hands panelTree the row, the kept reason, the notice and the failure, and nothing is drawn by hand", () => {
    const draw = functionOf("drawPanel");
    expect(draw).toMatch(/panelTree\(model,\s*\{/);
    for (const key of [
      "datasetId",
      "panelId: panel.id",
      "retryLabel: panel.dataset.rowLabel === UI_WORDS.buttons.retry",
      "reloadHref: location.href",
      "error: opts.error",
      "notice: opts.notice",
      "acknowledgment: opts.acknowledgment",
    ]) {
      expect(draw, key).toContain(key);
    }
    expect(draw).toMatch(/replaceChildren\(\.\.\.nodes\.map\(mount\)\)/);
  });

  it("reads no word of the model itself: only the control, which decides what is wired, and the request it names", () => {
    const read = [...SCRIPT.matchAll(/\bmodel\.(\w+)/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThan(0);
    expect([...new Set(read)].sort()).toEqual(["approve", "requestId"]);
  });

  it("mounts a node in one place, with createElement, setAttribute and textContent", () => {
    expect(SCRIPT.match(/createElement\(/g)).toHaveLength(1);
    const mount = functionOf("mount");
    expect(mount).toContain("document.createElement(spec.tag)");
    expect(mount).toContain("node.setAttribute(name, value)");
    expect(mount).toContain("node.textContent = spec.text");
    expect(mount).toMatch(
      /for \(const child of spec\.children \?\? \[\]\) node\.append\(mount\(child\)\)/,
    );
    expect(mount).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it("words a started review through describeStartSuccess and a failure through describeFailure", () => {
    expect(SCRIPT).toContain("describeStartSuccess(started)");
    for (const op of ["approve", "deny", "start", "detail"]) {
      expect(SCRIPT, op).toContain(`describeFailure("${op}"`);
    }
  });

  it("acts on every follow-up a failure asks for", () => {
    // A failure carries no flag for the override box: a re-read redraws the panel from the new
    // answer, so the box always comes back unticked.
    const report = functionOf("reportFailure");
    expect(report).toContain("if (failure.refetch)");
    expect(report).toContain("showError(failure.text, { refresh: failure.refreshLink })");
    expect(functionOf("afterApproveFailure")).toContain("focusAck: failure.focusAck");
    expect(SCRIPT).toContain("showError(failure.text, { refresh: failure.refreshLink })");
  });

  it("takes the retry word from UI_WORDS and every other button and heading word from the tree", () => {
    expect(SCRIPT).toContain("UI_WORDS.buttons.retry");
    for (const word of [
      "headings",
      "buttons.show",
      "buttons.hide",
      "buttons.start",
      "buttons.approve",
    ]) {
      expect(SCRIPT, word).not.toContain(`UI_WORDS.${word}`);
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
      expect(PANEL_CODE, name).not.toContain(body.message as string);
    }
  });

  it("holds no string literal that words a terminal", () => {
    const literals = SCRIPT.match(/"(?:[^"\\\n]|\\.)*"/g) ?? [];
    expect(literals.length).toBeGreaterThan(10);
    const flawed = literals.flatMap((l) =>
      terminalFlaws(l.slice(1, -1), 1).map((f) => `${l}: ${f}`),
    );
    expect(flawed).toEqual([]);
    // The panel module's words (a literal with a space in it is a sentence, not a class or a key).
    const sentences = (PANEL_CODE.match(/"(?:[^"\\\n]|\\.)*"/g) ?? []).filter((l) => /\s/.test(l));
    expect(sentences.length).toBeGreaterThan(3);
    expect(
      sentences.flatMap((l) => terminalFlaws(l.slice(1, -1)).map((f) => `${l}: ${f}`)),
    ).toEqual([]);
  });
});

describe("the Approve body comes from the builder and nowhere else", () => {
  it("calls dispatchPublicationApproval only with a body argument", () => {
    const calls = callArguments(SCRIPT, "dispatchPublicationApproval");
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args, args).toMatch(/\{\s*body:\s*target\.body\s*\}/);
  });

  it("computes the body with approveBody from the control stored at render time", () => {
    expect(SCRIPT).toContain(
      'state.control = model.approve.kind === "offered" ? model.approve : null;',
    );
    expect(SCRIPT).toContain("const built = approveBody(control, readInput());");
    expect(SCRIPT).toMatch(/body:\s*built\.body/);
  });

  it("names no field of the body itself", () => {
    expect(SCRIPT).not.toMatch(/request_id\s*:/);
    expect(SCRIPT).not.toContain("override_publication_review");
    expect(SCRIPT).not.toContain("acknowledge_identifier_screen");
    expect(SCRIPT).not.toContain("JSON.stringify");
  });

  it("disables Approve until the builder says the inputs are complete, and while a call runs", () => {
    expect(SCRIPT).toContain(
      "approve.disabled = !approveBody(control, readInput()).ok || inFlight;",
    );
  });

  it("refuses to queue a click that carries an incomplete body", () => {
    expect(SCRIPT).toMatch(/if \(!built\.ok \|\| !datasetId\) return;/);
  });
});

describe("Approve and Resume open the panel, and the typed dialog stays the last step", () => {
  it("sends the row's Approve and Resume buttons to openFromRow, never to a dialog", () => {
    for (const selector of ["[data-pubreq-approve]", "[data-pubreq-resume]"]) {
      const handler = handlerOf(selector);
      expect(handler, selector).toContain("openFromRow(btn)");
      expect(handler, selector).not.toContain("openDialog(");
    }
  });

  it("opens the panel from a closed row, and only moves the focus on an open one", () => {
    const open = functionOf("openFromRow");
    expect(open).toContain("void openPanel(panel, { focusPanel: true })");
    expect(open).not.toContain("openDialog(");
    expect(open).not.toContain("loadPanel(");
    // The open panel is left alone (its typed reason survives), and that comes first.
    expect(open).toMatch(/if \(!panel\.hidden\) return panel\.focus\(\);/);
    expect(open.indexOf("panel.hidden")).toBeLessThan(open.indexOf("openPanel("));
  });

  it("opens the existing dialog only from the panel's own Approve button", () => {
    const opens = [...SCRIPT.matchAll(/(?<!function )openDialog\(([^)]*)\)/g)].map((m) =>
      m[1].trim(),
    );
    expect(opens.sort()).toEqual(['"admin-deny"', "control.dialogId"].sort());
  });

  it("refetches the detail on every open", () => {
    const open = functionOf("openPanel");
    expect(open).toContain("await loadPanel(panel, opts)");
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

  it("moves focus to the reason field on an acknowledge refusal", () => {
    expect(functionOf("drawPanel")).toContain(
      "if (opts.focusAck && area) queueMicrotask(() => area.focus());",
    );
  });

  it("shows a refusal without a redraw through the lib's alert node, after the title", () => {
    const set = functionOf("setPanelError");
    expect(set).toContain("mount(errorTree(failure, location.href))");
    expect(set).toContain('panel.querySelector("[data-pubreq-review-error]")?.remove()');
    expect(set).toContain("title.after(node)");
  });
});

describe("a result never lands in a hidden panel, and a second click never opens a dialog", () => {
  it("shows a failure for a closed panel in the page's own error region", () => {
    const report = functionOf("reportFailure");
    expect(report).toContain("if (panel.hidden)");
    expect(report).toContain("showError(failure.text, { refresh: failure.refreshLink })");
    expect(report).toContain("loadPanel(");
    expect(report).toContain("setPanelError(");
    // The closed-panel check comes before anything is drawn.
    expect(report.indexOf("panel.hidden")).toBeLessThan(report.indexOf("loadPanel("));
    expect(report.indexOf("panel.hidden")).toBeLessThan(report.indexOf("setPanelError("));
  });

  it("sends every approve and start failure through it", () => {
    expect(functionOf("afterApproveFailure")).toContain("reportFailure(");
    expect(functionOf("startReview")).toContain("reportFailure(");
    for (const name of ["afterApproveFailure", "startReview"]) {
      expect(functionOf(name), name).not.toContain("setPanelError(");
      expect(functionOf(name), name).not.toContain("loadPanel(panel, { error");
    }
  });

  it("does not re-read a panel that was closed while a start was running", () => {
    expect(functionOf("startReview")).toMatch(/if \(!panel\.hidden\) \{\s*await loadPanel\(/);
  });

  it("answers queue with a boolean and refuses while a call is in flight", () => {
    const queue = functionOf("queue");
    expect(queue).toMatch(/function queue\(next: PendingAction\): boolean/);
    expect(queue).toMatch(/if \(inFlight\) return false/);
    expect(queue).toMatch(/return true/);
  });

  it("opens a dialog only when queue accepted the action, and says so when it did not", () => {
    const opens = [...SCRIPT.matchAll(/(?<!function )openDialog\(/g)];
    expect(opens.length).toBe(2);
    expect(SCRIPT).toMatch(
      /const queued = queue\([\s\S]*?\);\s*if \(!queued\) return setPanelError\(panel, BUSY_FAILURE\);\s*openDialog\(control\.dialogId\)/,
    );
    expect(SCRIPT).toMatch(
      /if \(!queue\(\{ kind: "deny"[^\n]*\)\) \{\s*return showError\(PANEL_WORDS\.busy\);\s*\}\s*openDialog\("admin-deny"\)/,
    );
  });

  it("refuses a Deny during a call before it asks for a reason that would be thrown away", () => {
    const deny = handlerOf("[data-pubreq-deny]");
    expect(deny).toContain("if (inFlight) return showError(PANEL_WORDS.busy);");
    expect(deny.indexOf("if (inFlight)")).toBeLessThan(deny.indexOf("window.prompt("));
  });
});

describe("every panel's Approve is off for the length of a call", () => {
  it("switches every panel's button off, and asks each to work out its own state afterwards", () => {
    const busy = functionOf("setApproveBusy");
    expect(busy).toContain(
      'document.querySelectorAll<HTMLButtonElement>(\n      "[data-pubreq-panel-approve]",\n    )',
    );
    expect(busy).toContain("if (busy) button.disabled = true;");
    expect(busy).toContain("else button.dispatchEvent(new Event(RECHECK));");
    expect(SCRIPT).toContain("approve.addEventListener(RECHECK, refresh);");
  });

  it("is set before the call goes out, for an approval and for a denial, and lifted on a failure", () => {
    const confirm = SCRIPT.slice(SCRIPT.indexOf('"nemar:confirm-dialog-confirm"'));
    const approve = confirm.slice(0, confirm.indexOf('e.detail.dialogId === "admin-deny"'));
    const deny = confirm.slice(confirm.indexOf('e.detail.dialogId === "admin-deny"'));
    expect(approve.indexOf("setApproveBusy(true)")).toBeGreaterThan(-1);
    expect(approve.indexOf("setApproveBusy(true)")).toBeLessThan(
      approve.indexOf("await dispatchPublicationApproval("),
    );
    expect(deny.indexOf("setApproveBusy(true)")).toBeGreaterThan(-1);
    expect(deny.indexOf("setApproveBusy(true)")).toBeLessThan(
      deny.indexOf("await denyPublicationRequest("),
    );
    expect(deny).toContain("setApproveBusy(false)");
    expect(functionOf("afterApproveFailure")).toContain("setApproveBusy(false)");
  });
});

describe("a slow answer never overwrites a newer panel or a closed one", () => {
  it("takes a token on every load and checks it after every await", () => {
    const load = functionOf("loadPanel");
    expect(load).toContain("const token = ++state.token;");
    expect(load.match(/if \(token !== state\.token\) return;/g)).toHaveLength(2);
    // The first check follows the read and precedes the draw; the second guards the failure path.
    expect(load.indexOf("await getPublicationReview(")).toBeLessThan(
      load.indexOf("if (token !== state.token) return;"),
    );
    expect(load.indexOf("if (token !== state.token) return;")).toBeLessThan(
      load.indexOf("panelModel("),
    );
    expect(load.indexOf("} catch (err) {")).toBeLessThan(
      load.lastIndexOf("if (token !== state.token) return;"),
    );
  });

  it("clears aria-busy only for the load that is still current", () => {
    expect(functionOf("loadPanel")).toContain(
      'if (token === state.token) panel.removeAttribute("aria-busy");',
    );
    expect(functionOf("loadPanel")).toContain('panel.setAttribute("aria-busy", "true")');
  });

  it("closing a panel bumps the token, so an answer in flight is dropped", () => {
    expect(functionOf("closePanel")).toContain("stateOf(panel).token++;");
  });
});

describe("a confirmation never sends a body the panel no longer shows", () => {
  it("drops the pending approval of a panel before it is read again, and closes its dialog", () => {
    const load = functionOf("loadPanel");
    expect(load).toContain("dropPendingApproval(panel);");
    expect(load.indexOf("dropPendingApproval(panel)")).toBeLessThan(
      load.indexOf("await getPublicationReview("),
    );
    const drop = functionOf("dropPendingApproval");
    expect(drop).toContain(
      'if (!pending || pending.kind === "deny" || pending.panel !== panel) return;',
    );
    expect(drop).toContain('`dialog[data-dialog-id="${pending.dialogId}"]`');
    expect(drop).toMatch(/\?\.close\(\);\s*pending = null;/);
    expect(functionOf("closePanel")).toContain("dropPendingApproval(panel);");
  });
});

describe("the reason the administrator typed survives a re-read", () => {
  it("keeps it across a refused Approve", () => {
    const after = functionOf("afterApproveFailure");
    expect(after).toContain(
      'panel.querySelector<HTMLTextAreaElement>("[data-pubreq-reason]")?.value',
    );
    expect(after).toMatch(/reportFailure\(panel, failure, \{\s*acknowledgment: typed,/);
    expect(functionOf("reportFailure")).toContain("loadPanel(panel, { ...extra, error: failure })");
  });

  it("keeps it across Refresh the review", () => {
    const refresh = functionOf("wireRefresh");
    expect(refresh).toContain('"[data-pubreq-reason]"');
    expect(refresh).toContain("void loadPanel(panel, { acknowledgment, focusPanel: true });");
  });

  it("passes it from the load to the tree", () => {
    expect(functionOf("loadPanel")).toMatch(/drawPanel\(panel, model,\s*\{\s*\.\.\.opts,/);
    expect(functionOf("drawPanel")).toContain("acknowledgment: opts.acknowledgment");
  });
});

describe("the panel is the one for the row's own request, and a fault in the drawing is not the network's", () => {
  it("compares the model's request with the row's before drawing anything", () => {
    const load = functionOf("loadPanel");
    // The id compared is the lib's `PanelModel.requestId`, which is null for a detail the page
    // cannot read (and so out of step, not stale); never the raw `detail.request_id`.
    expect(load).toContain("const model = panelModel(detail, { rowStart: rowStartOf(panel) })");
    expect(load).toContain("rowIsStale(model.requestId, Number(panel.dataset.requestId))");
    expect(load).not.toContain("rowIsStale(detail.request_id");
    expect(load).toContain("staleRowTree(datasetId, panel.id, location.href)");
    expect(load).toContain("drawPanel(panel, model,");
    expect(load.indexOf("panelModel(")).toBeLessThan(load.indexOf("rowIsStale("));
    expect(load.indexOf("rowIsStale(")).toBeLessThan(load.indexOf("staleRowTree("));
    expect(load.indexOf("staleRowTree(")).toBeLessThan(load.indexOf("drawPanel("));
  });

  it("wraps the model and the drawing in their own try, logs, and words it as out of step", () => {
    const load = functionOf("loadPanel");
    expect(load).toMatch(
      /const detail = await getPublicationReview\(datasetId\);[\s\S]*?try \{[\s\S]*?panelModel\([\s\S]*?\} catch \(drawErr\) \{\s*console\.error\("\[admin\] the review panel could not be drawn", drawErr\);[\s\S]*?failureTree\(DRAW_FAILURE,/,
    );
    // The outer catch is the call's own failure and keeps the network wording.
    expect(load).toContain('describeFailure("detail", err)');
  });

  it("leaves no control wired after a fault", () => {
    expect(functionOf("loadPanel")).toMatch(/console\.error\([^)]*\);\s*state\.control = null;/);
  });
});

describe("focus follows a redraw, and a notice is announced", () => {
  it("takes the focus back after a redraw when the panel held it or the caller asked", () => {
    expect(functionOf("loadPanel")).toContain(
      "const focusPanel = opts.focusPanel === true || panel.contains(document.activeElement);",
    );
  });

  it("puts the focus on the panel after a failure that is not redrawn", () => {
    expect(functionOf("reportFailure")).toMatch(
      /setPanelError\(panel, failure\);\s*if \(extra\.focusPanel\) panel\.focus\(\);/,
    );
  });

  it("asks for the focus after a refused Approve, a started review and a failed start", () => {
    expect(functionOf("afterApproveFailure")).toContain("focusPanel: true,");
    const start = functionOf("startReview");
    expect(start).toContain("describeStartSuccess(started), focusPanel: true");
    expect(start).toContain('describeFailure("start", err), { focusPanel: true }');
  });

  it("announces the notice through a status region that exists before the words do", () => {
    expect(functionOf("drawPanel")).toContain("announce(panel, opts.notice);");
    const announce = functionOf("announce");
    expect(announce).toContain('"[data-pubreq-review-live]"');
    expect(announce.indexOf('live.textContent = ""')).toBeLessThan(
      announce.indexOf("window.setTimeout("),
    );
    expect(announce).toContain("live.textContent = words");
    expect(functionOf("closePanel")).toContain("announce(panel, null);");
    expect(functionOf("loadPanel")).toContain("announce(panel, null);");
  });

  it("names the panel after its heading, and the toggle after its row", () => {
    expect(ROW_CODE).toMatch(/aria-labelledby=\{titleIdOf\(panelId\)\}/);
    expect(ROW_CODE).toMatch(
      /<p class="pubreq-review__live" role="status" data-pubreq-review-live>/,
    );
    expect(ROW_CODE).toContain("aria-label={toggle.ariaLabel}");
    expect(ROW_CODE).toContain("aria-expanded={toggle.expanded}");
    const toggle = functionOf("setToggle");
    expect(toggle).toContain('toggleLabels(open, panel.dataset.datasetId ?? "")');
    expect(toggle).toContain('toggle.setAttribute("aria-label", labels.ariaLabel)');
    expect(toggle).toContain("toggle.textContent = labels.text");
    expect(toggle).toContain('toggle.setAttribute("aria-expanded", labels.expanded)');
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

describe("the quiet auto-refresh never runs over an open panel, and the note says so", () => {
  it("names the visible panel in the quiet test", () => {
    const quiet = /const quiet =[\s\S]*?;\n/.exec(SCRIPT);
    expect(quiet, "no quiet test").not.toBeNull();
    expect(quiet?.[0]).toContain("[data-pubreq-review-panel]:not([hidden])");
  });

  it("swaps the note's words while a panel is open, and back when none is", () => {
    const sync = functionOf("syncRefreshNote");
    expect(sync).toContain(
      'document.querySelector("[data-pubreq-review-panel]:not([hidden])") !== null',
    );
    expect(sync).toContain("open ? PANEL_WORDS.refreshPaused : runningNoteWords");
    expect(functionOf("openPanel")).toContain("syncRefreshNote();");
    expect(functionOf("closePanel")).toContain("syncRefreshNote();");
    expect(PAGE_CODE).toMatch(
      /<span data-refresh-note-text>[^<]*refreshes every 20 seconds[^<]*<\/span>/,
    );
  });
});

describe("text reaches the DOM only as text", () => {
  it.each([
    ["the page", PAGE_CODE],
    ["the row", ROW_CODE],
    ["the panel module", PANEL_CODE],
  ])("%s builds no markup from a string", (_name, src) => {
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|set:html/);
  });

  it.each([
    ["the script", SCRIPT],
    // The row's one existing `.command` is the terminal hint of a backend that cannot dispatch an
    // approval (`rowView().terminal`), not a field of the review detail; nothing else may read one.
    ["the row", ROW_CODE.replace("view.terminal.command", "")],
    ["the panel module", PANEL_CODE],
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
    ["the panel module", PANEL_CODE],
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
    expect(ROW_CODE).toContain("aria-controls");
    expect(ROW_CODE).toMatch(/<section[^>]*data-pubreq-review-panel[^>]*\shidden[\s>]/);
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

  it("takes the active statuses from the lib and keeps no list of its own", () => {
    expect(ROW_CODE).toMatch(/import\s*\{[^}]*\bACTIVE_STATUSES\b[^}]*\}\s*from\s*"\.\.\/lib\/publication-review"/);
    expect(ROW_CODE).toContain("ACTIVE_STATUSES.includes(request.status)");
    // A second list of the three words is how the row and the lib drift apart.
    expect(ROW_CODE).not.toMatch(/\[\s*"requested"\s*,\s*"approving"\s*,\s*"blocked"\s*\]/);
    expect(ROW_CODE).not.toContain("REVIEWABLE");
  });

  it("labels the toggle from the panel module's own words", () => {
    expect(ROW_CODE).toContain("toggleLabels(false, datasetId)");
    expect(ROW_CODE).toContain("{toggle.text}");
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

  it("styles each tone the panel module can draw, and each class it gives a node", () => {
    for (const tone of ["ok", "note", "warn", "stop"]) {
      expect(PANEL_CODE, tone).toContain(`pubreq-review-tone--${tone}`);
      expect(css, tone).toContain(`.pubreq-review-tone--${tone}`);
    }
    const classes = new Set(
      [...PANEL_CODE.matchAll(/"(pubreq-review__[a-z-]+)"/g)].map((m) => m[1]),
    );
    expect(classes.size).toBeGreaterThan(8);
    for (const name of classes) expect(css, name).toContain(`.${name}`);
    expect(css).toContain(".pubreq-review__live");
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

describe("the shared confirm dialog never confirms from a stale returnValue", () => {
  // An Escape close leaves `returnValue` alone, so a value left by an earlier confirm would make the
  // next Escape fire the confirm event again: resume and deny need no typing, so Escape alone would
  // send them. The value is cleared before the dialog opens and again when it closes.
  const dialogScript = (/<script>([\s\S]*?)<\/script>/.exec(CONFIRM_DIALOG)?.[1] ?? "").replace(
    /\/\/.*$/gm,
    "",
  );
  const closeHandler = /dialog\.addEventListener\("close", \(\) => \{([\s\S]*?)\n {4}\}\);/.exec(
    dialogScript,
  )?.[1];

  it("finds the open and close handlers (the pins below are not vacuous)", () => {
    expect(dialogScript).toContain("dialog.showModal()");
    expect(closeHandler, "no close handler").toBeDefined();
  });

  it("clears returnValue before showModal()", () => {
    const clear = dialogScript.indexOf('dialog.returnValue = ""');
    const show = dialogScript.indexOf("dialog.showModal()");
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(show);
  });

  it("clears returnValue again after the close handler has read it", () => {
    const body = closeHandler ?? "";
    const read = body.indexOf('dialog.returnValue === "confirm"');
    const clear = body.lastIndexOf('dialog.returnValue = ""');
    expect(read).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(read);
  });
});
