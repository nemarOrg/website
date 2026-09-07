/**
 * Source-level guards for `/cli/authorize` (epic #1272 phase 2,
 * nemarOrg/website#316), in the style of `test/account-tiers-ui.test.ts`:
 * this repo has no Astro rendering harness, so reading the page source via
 * Vite's `?raw` (never `node:fs` — `astro check` type-checks every file
 * under the repo with no `@types/node`) is the honest cheap check for a
 * server-rendered page with no client script.
 */

import { describe, expect, it } from "vitest";
import { AUTHORIZE_COPY } from "../src/lib/device-authorize";
import AUTHORIZE_PAGE from "../src/pages/cli/authorize.astro?raw";

describe("the no-session redirect", () => {
  it("sends an anonymous visitor to /login with next set to the current path", () => {
    expect(AUTHORIZE_PAGE).toContain("noStoreRedirect(`/login?next=${encodeURIComponent(here)}`)");
  });

  it("sends a stale-session (signed_out) visitor to /login with error=session_required", () => {
    expect(AUTHORIZE_PAGE).toContain(
      "`/login?error=session_required&next=${encodeURIComponent(here)}`",
    );
    expect(AUTHORIZE_PAGE).toMatch(
      /kind === "signed_out"[\s\S]{0,40}noStoreRedirect\(sessionRequiredRedirect\)/,
    );
  });
});

describe("no-store on every early response (ADR 0016)", () => {
  it("never calls the bare Astro.redirect — every redirect goes through noStoreRedirect", () => {
    // Matches an actual call site (`return Astro.redirect(...)`), not the
    // doc comment above explaining why the helper exists in the first
    // place — that comment necessarily also says "Astro.redirect(".
    expect(AUTHORIZE_PAGE).not.toMatch(/return Astro\.redirect\(/);
  });

  it("the noStoreRedirect helper itself sets Cache-Control: no-store", () => {
    expect(AUTHORIZE_PAGE).toMatch(
      /function noStoreRedirect\([\s\S]{0,200}"Cache-Control":\s*"no-store"/,
    );
  });

  it("every bare 403/400 Response carries Cache-Control: no-store", () => {
    const bareResponses =
      AUTHORIZE_PAGE.match(/new Response\([^)]*status:\s*(403|400)[^)]*\)/g) ?? [];
    // Three 400s (content-type, formData catch, validation) and one 403
    // (Origin mismatch) — every one of them inline, so each match itself
    // must carry the header rather than relying on a shared helper.
    expect(bareResponses.length).toBeGreaterThanOrEqual(4);
    for (const response of bareResponses) {
      expect(response).toContain('"Cache-Control": "no-store"');
    }
  });
});

describe("the POST branch", () => {
  it("dispatches on Astro.request.method", () => {
    expect(AUTHORIZE_PAGE).toContain('Astro.request.method === "POST"');
  });

  it("compares Origin to Astro.url.origin before doing anything else, and logs the mismatch", () => {
    expect(AUTHORIZE_PAGE).toContain('Astro.request.headers.get("origin")');
    expect(AUTHORIZE_PAGE).toMatch(/origin !== Astro\.url\.origin/);
    expect(AUTHORIZE_PAGE).toMatch(/status: 403/);
    expect(AUTHORIZE_PAGE).toMatch(/console\.warn\(\s*`\[cli\/authorize\] POST rejected: Origin/);
  });

  it("requires a form content type before reading the body", () => {
    expect(AUTHORIZE_PAGE).toContain("application/x-www-form-urlencoded");
    expect(AUTHORIZE_PAGE).toContain("multipart/form-data");
  });

  it("wraps formData() in try/catch, logs, and 400s a parse failure", () => {
    expect(AUTHORIZE_PAGE).toMatch(/try\s*\{\s*form = await Astro\.request\.formData\(\)/);
    expect(AUTHORIZE_PAGE).toMatch(/catch \(err\)[\s\S]{0,200}formData\(\) failed", err\)/);
    expect(AUTHORIZE_PAGE).toMatch(/formData\(\) failed", err\)[\s\S]{0,100}status: 400/);
  });

  it("400s when intent or code fail validation (hasCode)", () => {
    expect(AUTHORIZE_PAGE).toMatch(/if \(!intent \|\| !hasCode\(code\)\)/);
    expect(AUTHORIZE_PAGE).toMatch(/if \(!intent \|\| !hasCode\(code\)\)[\s\S]{0,300}status: 400/);
  });

  it("never pins a production origin — forwards Astro.url.origin instead", () => {
    expect(AUTHORIZE_PAGE).not.toContain("https://app.nemar.org");
    expect(AUTHORIZE_PAGE).toContain("origin: Astro.url.origin");
  });

  it("branches DEV vs production for the decide call", () => {
    expect(AUTHORIZE_PAGE).toMatch(
      /import\.meta\.env\.DEV\s*\n\s*\? decideDeviceCodeDev\(intent, code, session\.user\)\s*\n\s*: await decideDeviceCode\(/,
    );
  });

  it("redirects a successful decide with a 303 through noStoreRedirect", () => {
    expect(AUTHORIZE_PAGE).toMatch(/noStoreRedirect\(outcome\.location, 303\)/);
  });
});

describe("the GET branch", () => {
  it("dispatches enter_code when the code query param fails hasCode", () => {
    expect(AUTHORIZE_PAGE).toMatch(
      /if \(!hasCode\(codeParam\)\)\s*\{\s*view = \{ kind: "enter_code" \};/,
    );
  });

  it("branches DEV vs production for the lookup call", () => {
    expect(AUTHORIZE_PAGE).toMatch(
      /import\.meta\.env\.DEV\s*\n\s*\? lookupDeviceCodeDev\(codeParam, session\.user\)\s*\n\s*: await lookupDeviceCode\(/,
    );
  });
});

describe("Cache-Control", () => {
  it("is set to no-store on the page-level response", () => {
    expect(AUTHORIZE_PAGE).toContain('Astro.response.headers.set("Cache-Control", "no-store")');
  });
});

describe("the confirm form", () => {
  it("is exactly one method=post form carrying the hidden code and both intent buttons", () => {
    // Decoupled from the finish__form CSS class — the class is a styling
    // detail, not what makes this "the" POST form on the page.
    const postForms = AUTHORIZE_PAGE.match(/<form\b[^>]*\bmethod="post"/g) ?? [];
    expect(postForms).toHaveLength(1);
    expect(AUTHORIZE_PAGE).toMatch(/<input type="hidden" name="code" value=\{view\.code\} \/>/);
    expect(AUTHORIZE_PAGE).toContain('name="intent" value="authorize"');
    expect(AUTHORIZE_PAGE).toContain('name="intent" value="deny"');
  });

  it("asks the phishing-aware framing question naming the machine and the CLI command", () => {
    // The literal wording lives in AUTHORIZE_COPY; the page's own source is
    // checked for wiring that copy in, and the copy itself — asserted here
    // — is what makes it visible: "Did you just run `nemar auth login` on
    // <machine>?"
    expect(AUTHORIZE_PAGE).toContain("AUTHORIZE_COPY.confirm.questionPrefix");
    expect(AUTHORIZE_PAGE).toContain("AUTHORIZE_COPY.confirm.questionCommand");
    expect(AUTHORIZE_PAGE).toContain("AUTHORIZE_COPY.confirm.questionSuffix");
    expect(AUTHORIZE_PAGE).toMatch(/\{view\.machineName\}/);
    expect(AUTHORIZE_COPY.confirm.questionPrefix).toMatch(/Did you just run/);
    expect(AUTHORIZE_COPY.confirm.questionCommand).toBe("nemar auth login");
  });

  it("machine_name is rendered only inside {} expressions, never via set:html or innerHTML", () => {
    expect(AUTHORIZE_PAGE).not.toContain("set:html");
    expect(AUTHORIZE_PAGE).not.toContain("innerHTML");
    expect(AUTHORIZE_PAGE).toMatch(/\{view\.machineName\}/);
  });
});

describe("the enter-code form", () => {
  it("is a method=get form (both in the enter_code and refused-device_code_unknown views)", () => {
    const getForms = AUTHORIZE_PAGE.match(/<form\b[^>]*\bmethod="get"/g) ?? [];
    expect(getForms.length).toBeGreaterThanOrEqual(1);
    expect(AUTHORIZE_PAGE).not.toMatch(
      /<form\b[^>]*\bmethod="get"[^>]*action="\/cli\/authorize"[^>]*>\s*<input type="hidden" name="code"/,
    );
  });

  it("only renders beneath a refusal when showEnterCodeForm is set", () => {
    expect(AUTHORIZE_PAGE).toContain("view.showEnterCodeForm &&");
  });
});

describe("the unavailable view", () => {
  it("renders via unavailableMessage(view.reason), not a fixed sentence", () => {
    expect(AUTHORIZE_PAGE).toContain("unavailableMessage(view.reason)");
  });
});

describe("the done view", () => {
  it("renders via doneMessage(view.done, view.machine)", () => {
    expect(AUTHORIZE_PAGE).toContain("doneMessage(view.done, view.machine)");
  });
});

describe("no client script and no unsafe HTML sinks", () => {
  it("carries no <script> tag", () => {
    expect(AUTHORIZE_PAGE).not.toMatch(/<script/);
  });

  it("never renders an api_key", () => {
    expect(AUTHORIZE_PAGE).not.toContain("api_key");
  });

  it("uses no set:html or innerHTML anywhere on the page", () => {
    expect(AUTHORIZE_PAGE).not.toContain("set:html");
    expect(AUTHORIZE_PAGE).not.toContain("innerHTML");
  });
});
