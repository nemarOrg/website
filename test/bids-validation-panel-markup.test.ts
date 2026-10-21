/**
 * The BIDS validation panel is a TypeScript module that fills in markup it does not own
 * (`src/lib/bids-validation/panel.ts` and `src/components/BidsValidationPanel.astro`), and the
 * upload page's script binds the two. Nothing renders them together in a test, so this reads the
 * sources, as `account-tiers-ui.test.ts` does: a part the module looks for that the markup has
 * lost, or a page that stops guarding the bind, is the failure it exists to catch. The real
 * protection against a missing part is the page's own guard (`bindValidationPanel` throws, the
 * page falls back to "could not run"); this keeps the two halves from drifting in the first place.
 */

import { describe, expect, it } from "vitest";
import PANEL_ASTRO from "../src/components/BidsValidationPanel.astro?raw";
import PANEL_TS from "../src/lib/bids-validation/panel.ts?raw";
import UPLOAD from "../src/pages/upload.astro?raw";

/** Every `part("name")` the module asks the markup for. */
const PARTS = [...PANEL_TS.matchAll(/\bpart(?:<[^>()]*>)?\("([a-z-]+)"\)/g)].map((m) => m[1]);

describe("the panel module and its markup", () => {
  it("looks for the parts the panel is made of", () => {
    // Pinned, so a change to the regular expression that matches nothing cannot pass every check
    // below by finding no parts.
    expect([...PARTS].sort()).toEqual([
      "announce",
      "bar",
      "cancel",
      "footer",
      "groups",
      "heading",
      "note",
      "panel",
      "status",
      "verdict",
    ]);
  });

  it.each(PARTS)("finds a data-bidsval-%s in the markup", (name) => {
    expect(PANEL_ASTRO).toContain(`data-bidsval-${name}`);
  });

  it("keeps the live region outside the panel that is hidden at rest", () => {
    // A live region inside a hidden section is often not announced when it is set. The announcer
    // must come before the panel's opening tag, inside the host.
    const host = PANEL_ASTRO.indexOf("data-bidsval>");
    const announce = PANEL_ASTRO.indexOf("data-bidsval-announce");
    const panel = PANEL_ASTRO.indexOf("data-bidsval-panel");
    expect(host).toBeGreaterThan(-1);
    expect(announce).toBeGreaterThan(host);
    expect(announce).toBeLessThan(panel);
  });
});

/**
 * The text of a function declared in the page script, from its `function` line to its closing
 * brace (the first line that is just `  }`, since everything nested is indented further).
 */
function pageFunction(name: string): string {
  const start = UPLOAD.indexOf(`function ${name}(`);
  expect(start, `${name} is declared in the page script`).toBeGreaterThan(-1);
  const end = UPLOAD.indexOf("\n  }\n", start);
  return UPLOAD.slice(start, end + "\n  }\n".length);
}

// Nothing here renders the page: there is no DOM in these tests and no browser harness in this
// repository (website#435). These read the page script as text, for the wiring that keeps a
// failure of the check from becoming a broken upload page, and say so. What the page does when the
// worker misbehaves was run in Chrome (the PR description lists the cases).
describe("the upload page script, read as source", () => {
  it("includes the component and binds the host it renders", () => {
    expect(UPLOAD).toContain("<BidsValidationPanel />");
    expect(UPLOAD).toContain('document.querySelector<HTMLElement>("[data-bidsval]")');
  });

  it("binds the panel inside a try, so markup and script that drifted apart cannot stop it", () => {
    // `bindValidationPanel` throws on a missing part. Unguarded that stops the page script, and
    // with it the whole upload page.
    expect(UPLOAD).toMatch(
      /try \{\s*validationPanel = bidsvalEl \? bindValidationPanel\(bidsvalEl\)/,
    );
  });

  it("sends a page with no usable panel to validationCannotRun when Validate is pressed", () => {
    expect(UPLOAD).toContain(
      'validationCannotRun("the validation panel is missing from this page")',
    );
  });

  it("has validationCannotRun use the panel first and the line beside the button after it", () => {
    const body = pageFunction("validationCannotRun");
    // The state that lets the upload through...
    expect(body).toContain('validation = { kind: "unavailable", reason }');
    expect(body).toContain("syncSubmit()");
    // ... and where a person is told: the panel when it can, otherwise the status line.
    const panel = body.indexOf("validationPanel.showUnavailable(reason)");
    const fallback = body.indexOf("setStatus(");
    expect(panel).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(panel);
    expect(body).toContain("unavailableWords(reason)");
    expect(body).toMatch(/catch \(error\) \{[^}]*console\.error/);
  });

  it("has startFullValidation turn a throw after the run into 'could not run'", () => {
    const body = pageFunction("startFullValidation");
    const tryAt = body.indexOf("try {");
    const catchAt = body.indexOf("} catch (error) {");
    expect(tryAt).toBeGreaterThan(-1);
    expect(catchAt).toBeGreaterThan(tryAt);
    // Everything that can throw is inside the try: the panel, the run, the gate, the drawing.
    for (const call of [
      "panel.showRunning(",
      "await runValidation(",
      "await judge(",
      "panel.showFinished(",
    ]) {
      const at = body.indexOf(call);
      expect(at, `${call} is in startFullValidation`).toBeGreaterThan(tryAt);
      expect(at, `${call} is inside the try`).toBeLessThan(catchAt);
    }
    expect(body.slice(catchAt)).toContain("validationCannotRun(");
  });
});
