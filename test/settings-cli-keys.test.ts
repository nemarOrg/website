/**
 * Source-level guards for the Settings CLI-keys card (epic #1272 phase 2,
 * nemarOrg/website#316; nemar-cli ADR 0047), in the style of
 * `test/account-tiers-ui.test.ts` and `test/cli-authorize-ui.test.ts`: no
 * Astro rendering harness in this repo, so reading the page source via
 * Vite's `?raw` is the honest cheap check.
 */

import { describe, expect, it } from "vitest";
import SETTINGS from "../src/pages/settings.astro?raw";

describe("card id and placement", () => {
  it("sits between #upload-access and the Appearance block", () => {
    const uploadAccessEnd = SETTINGS.indexOf('id="upload-access"');
    const cliKeysStart = SETTINGS.indexOf('id="cli-keys"');
    const appearanceStart = SETTINGS.indexOf("<!-- Appearance block -->");
    expect(uploadAccessEnd).toBeGreaterThan(-1);
    expect(cliKeysStart).toBeGreaterThan(uploadAccessEnd);
    expect(appearanceStart).toBeGreaterThan(cliKeysStart);
  });

  it("is a card--wide article, like the upload-access card beside it", () => {
    expect(SETTINGS).toMatch(/<article class="card card--wide" id="cli-keys">/);
  });
});

describe("the list fetch pins Origin server-side", () => {
  it("calls listApiKeys with Astro.url.origin, never a hardcoded host", () => {
    expect(SETTINGS).toContain(
      "listApiKeys({ cookieHeader, origin: Astro.url.origin })",
    );
    expect(SETTINGS).not.toContain('origin: "https://app.nemar.org"');
  });

  it("skips the fetch entirely for the unverified tier", () => {
    expect(SETTINGS).toMatch(/if \(tier !== "unverified"\) \{\s*\n\s*if \(import\.meta\.env\.DEV\)/);
  });

  it("renders a verify-email sentence, not the card contents, when unverified", () => {
    expect(SETTINGS).toContain('{keysState === "unverified" && (');
    expect(SETTINGS).toMatch(/Verify your email to manage CLI keys/);
  });

  it("renders an unavailable notice when the fetch didn't come back with keys", () => {
    expect(SETTINGS).toContain('{keysState === "unavailable" && (');
  });
});

describe("the confirm dialog", () => {
  it("is wired with the CLI-keys dialog id and the danger tone", () => {
    expect(SETTINGS).toMatch(
      /<ConfirmDialog\s+dialogId="settings-revoke-key"[\s\S]{0,200}confirmTone="danger"/,
    );
  });

  it("every revoke button carries data-key-revoke and the key id/name", () => {
    expect(SETTINGS).toContain("data-key-revoke");
    expect(SETTINGS).toMatch(/data-key-revoke\s*\n\s*data-key-id=\{key\.id\}\s*\n\s*data-key-name=/);
  });
});

describe("the two fetch paths reload on success", () => {
  it("create POSTs /api/auth/keys and reveals the key rather than reloading immediately", () => {
    expect(SETTINGS).toMatch(/fetch\("\/api\/auth\/keys", \{\s*\n\s*method: "POST"/);
    expect(SETTINGS).toContain("if (revealPanel) revealPanel.hidden = false;");
  });

  it("revoke DELETEs /api/auth/keys/:id and reloads on success", () => {
    const idx = SETTINGS.indexOf(
      "fetch(`/api/auth/keys/${encodeURIComponent(target.id)}`, {",
    );
    expect(idx).toBeGreaterThan(-1);
    expect(SETTINGS.slice(idx, idx + 120)).toContain('method: "DELETE"');
    // The nearest `location.reload()` after the DELETE call is the revoke
    // success path (the create flow's own success does not reload — it
    // reveals the key instead — so this is unambiguous).
    const reloadIdx = SETTINGS.indexOf("location.reload()", idx);
    expect(reloadIdx).toBeGreaterThan(idx);
    expect(reloadIdx - idx).toBeLessThan(500);
  });

  it("Done in the reveal panel also reloads", () => {
    expect(SETTINGS).toMatch(/revealDoneBtn\?\.addEventListener\("click", \(\) => \{\s*\n\s*location\.reload\(\);/);
  });
});

describe("the revealed key", () => {
  it("is shown once in a readonly input", () => {
    expect(SETTINGS).toMatch(
      /<input\s+class="field__input field__input--code"\s+type="text"\s+readonly\s+data-key-reveal-input/,
    );
  });

  it("carries the once-only sentence", () => {
    expect(SETTINGS).toContain("Store it now. It will not be shown again.");
  });

  it("offers a Copy button", () => {
    expect(SETTINGS).toContain("data-key-reveal-copy");
    expect(SETTINGS).toContain("navigator.clipboard.writeText(revealInput.value)");
  });
});

describe("the empty state", () => {
  it("names both the browser sign-in path and the paste-key fallback flag", () => {
    expect(SETTINGS).toContain("nemar auth login");
    expect(SETTINGS).toContain("nemar auth login --key");
  });
});

describe("no unsafe HTML sinks", () => {
  it("uses no innerHTML in the CLI-keys IIFE", () => {
    const start = SETTINGS.indexOf("// ================= CLI keys (epic #1272 phase 2) =================");
    const end = SETTINGS.indexOf("// ---- Theme picker ----");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = SETTINGS.slice(start, end);
    expect(block).not.toContain("innerHTML");
    expect(block).not.toContain("set:html");
  });

  it("the whole page carries no set:html", () => {
    expect(SETTINGS).not.toContain("set:html");
  });
});
