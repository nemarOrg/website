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
    expect(SETTINGS).toContain("listApiKeys({ cookieHeader, origin: Astro.url.origin })");
    expect(SETTINGS).not.toContain('origin: "https://app.nemar.org"');
  });

  it("skips the fetch entirely for the unverified tier", () => {
    expect(SETTINGS).toMatch(
      /if \(tier !== "unverified"\) \{\s*\n\s*if \(import\.meta\.env\.DEV\)/,
    );
  });

  it("renders a verify-email sentence, not the card contents, when unverified", () => {
    expect(SETTINGS).toContain('{keysState === "unverified" && (');
    expect(SETTINGS).toMatch(/Verify your email to manage CLI keys/);
  });

  it("renders an unavailable notice when the fetch didn't come back with keys", () => {
    expect(SETTINGS).toContain('{keysState === "unavailable" && (');
  });

  it("logs the status and body shape when the list becomes unavailable", () => {
    expect(SETTINGS).toMatch(
      /console\.warn\(\s*`\[settings\] CLI keys list unavailable: status=\$\{keysResult\.status\}`,/,
    );
  });
});

describe("messageForStatus: CLI-keys refusals before the generic fallbacks", () => {
  it("checks key_not_found and too_many_keys before the generic 404/409 branches", () => {
    const fnStart = SETTINGS.indexOf("function messageForStatus(");
    const keyNotFoundIdx = SETTINGS.indexOf('code === "key_not_found"', fnStart);
    const tooManyIdx = SETTINGS.indexOf('code === "too_many_keys"', fnStart);
    const generic404Idx = SETTINGS.indexOf("status === 404 || status === 501", fnStart);
    const generic409Idx = SETTINGS.indexOf('status === 409 && code === "same_email"', fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    expect(keyNotFoundIdx).toBeGreaterThan(fnStart);
    expect(tooManyIdx).toBeGreaterThan(keyNotFoundIdx);
    expect(generic404Idx).toBeGreaterThan(tooManyIdx);
    expect(generic409Idx).toBeGreaterThan(generic404Idx);
  });

  it("prefers the backend's own too_many_keys message, with a number-free fallback", () => {
    expect(SETTINGS).toMatch(
      /too_many_keys[\s\S]{0,220}return message \|\| "You've reached the limit of active keys\. Revoke one below, then try again\."/,
    );
    expect(SETTINGS).not.toContain("25 active keys");
  });

  it("accepts an optional message parameter, threaded from readProfileError", () => {
    expect(SETTINGS).toContain(
      "function messageForStatus(status: number, code?: string, message?: string): string {",
    );
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
    expect(SETTINGS).toMatch(
      /data-key-revoke\s*\n\s*data-key-id=\{key\.id\}\s*\n\s*data-key-name=/,
    );
  });
});

describe("the two fetch paths reload on success", () => {
  it("create POSTs /api/auth/keys and reveals the key rather than reloading immediately", () => {
    expect(SETTINGS).toMatch(/fetch\("\/api\/auth\/keys", \{\s*\n\s*method: "POST"/);
    expect(SETTINGS).toContain("if (revealPanel) revealPanel.hidden = false;");
  });

  it("revoke DELETEs /api/auth/keys/:id and reloads on success", () => {
    const idx = SETTINGS.indexOf("fetch(`/api/auth/keys/${encodeURIComponent(target.id)}`, {");
    expect(idx).toBeGreaterThan(-1);
    expect(SETTINGS.slice(idx, idx + 120)).toContain('method: "DELETE"');
    // Structural bound, not a character budget: the CLI-keys IIFE's own
    // closing `})();` is the nearest one after the DELETE call (this
    // handler is the last thing in the IIFE), so a `location.reload()`
    // found before it unambiguously belongs to this flow.
    const iifeEnd = SETTINGS.indexOf("})();", idx);
    expect(iifeEnd).toBeGreaterThan(idx);
    const reloadIdx = SETTINGS.indexOf("location.reload()", idx);
    expect(reloadIdx).toBeGreaterThan(idx);
    expect(reloadIdx).toBeLessThan(iifeEnd);
  });

  it("Done in the reveal panel also reloads", () => {
    expect(SETTINGS).toMatch(
      /revealDoneBtn\?\.addEventListener\("click", \(\) => \{\s*\n\s*location\.reload\(\);/,
    );
  });
});

describe("the create handler gates the reveal on a returned key", () => {
  it("parses the response body in its own try/catch, separate from the fetch", () => {
    // Two distinct `try {` blocks inside the create handler: one around
    // the fetch (network failures), one around `res.json()` (parse
    // failures) — conflating them would report "network error" for a body
    // NEMAR actually answered but this page could not read.
    const start = SETTINGS.indexOf('createForm?.addEventListener("submit"');
    const fetchTry = SETTINGS.indexOf("try {\n          res = await fetch", start);
    const jsonTry = SETTINGS.indexOf("try {\n          data = ", start);
    expect(fetchTry).toBeGreaterThan(start);
    expect(jsonTry).toBeGreaterThan(fetchTry);
  });

  it("requires a non-empty string api_key before revealing, and logs + refuses otherwise", () => {
    expect(SETTINGS).toContain(
      'typeof data?.api_key === "string" && data.api_key.length > 0 ? data.api_key : null',
    );
    expect(SETTINGS).toContain("if (!apiKey) {");
    expect(SETTINGS).toMatch(
      /console\.error\("\[settings\] key created but the response carried no api_key", data\)/,
    );
    expect(SETTINGS).toContain(
      "The key was created, but we couldn't display it. Revoke it in the list below and try again.",
    );
  });

  it("reports a JSON parse failure on a 2xx as that, never as a network error", () => {
    expect(SETTINGS).toMatch(
      /catch \(err\) \{\s*\n\s*console\.warn\("\[settings\] key creation response was not valid JSON", err\);/,
    );
    expect(SETTINGS).toContain(
      "NEMAR answered, but we couldn't read the response. Reload to see your keys.",
    );
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
    // Anchored on code tokens, not prose comment markers: the create
    // handler's own listener registration to the next IIFE's first real
    // statement (the theme picker's own const, not its comment header).
    const start = SETTINGS.indexOf('createForm?.addEventListener("submit"');
    const end = SETTINGS.indexOf("const THEME_KEY");
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
