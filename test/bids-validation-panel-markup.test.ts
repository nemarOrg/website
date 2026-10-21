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

describe("the upload page and the panel", () => {
  it("includes the component and binds the host it renders", () => {
    expect(UPLOAD).toContain("<BidsValidationPanel />");
    expect(UPLOAD).toContain('document.querySelector<HTMLElement>("[data-bidsval]")');
  });

  it("survives a panel that cannot be bound, and says the check could not run", () => {
    // `bindValidationPanel` throws on a missing part. Unguarded that stops the page script, and
    // with it the whole upload page.
    expect(UPLOAD).toMatch(
      /try \{\s*validationPanel = bidsvalEl \? bindValidationPanel\(bidsvalEl\)/,
    );
    expect(UPLOAD).toContain("validationCannotRun(");
    expect(UPLOAD).toContain("the validation panel is missing from this page");
  });
});
