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
    expect(AUTHORIZE_PAGE).toContain("Astro.redirect(`/login?next=${encodeURIComponent(here)}`)");
  });

  it("sends a stale-session (signed_out) visitor to /login with error=session_required", () => {
    expect(AUTHORIZE_PAGE).toContain(
      "`/login?error=session_required&next=${encodeURIComponent(here)}`",
    );
    expect(AUTHORIZE_PAGE).toMatch(
      /kind === "signed_out"[\s\S]{0,40}Astro\.redirect\(sessionRequiredRedirect\)/,
    );
  });
});

describe("the POST branch", () => {
  it("dispatches on Astro.request.method", () => {
    expect(AUTHORIZE_PAGE).toContain('Astro.request.method === "POST"');
  });

  it("compares Origin to Astro.url.origin before doing anything else", () => {
    expect(AUTHORIZE_PAGE).toContain('Astro.request.headers.get("origin")');
    expect(AUTHORIZE_PAGE).toMatch(/origin !== Astro\.url\.origin/);
    expect(AUTHORIZE_PAGE).toMatch(/status: 403/);
  });

  it("requires a form content type before reading the body", () => {
    expect(AUTHORIZE_PAGE).toContain("application/x-www-form-urlencoded");
    expect(AUTHORIZE_PAGE).toContain("multipart/form-data");
  });

  it("wraps formData() in try/catch and 400s a parse failure", () => {
    expect(AUTHORIZE_PAGE).toMatch(/try\s*\{\s*form = await Astro\.request\.formData\(\)/);
    expect(AUTHORIZE_PAGE).toMatch(/catch[\s\S]{0,80}status: 400/);
  });

  it("never pins a production origin — forwards Astro.url.origin instead", () => {
    expect(AUTHORIZE_PAGE).not.toContain("https://app.nemar.org");
    expect(AUTHORIZE_PAGE).toContain("origin: Astro.url.origin");
  });

  it("redirects a successful decide with a 303", () => {
    expect(AUTHORIZE_PAGE).toMatch(/Astro\.redirect\(outcome\.location, 303\)/);
  });
});

describe("Cache-Control", () => {
  it("is set to no-store", () => {
    expect(AUTHORIZE_PAGE).toContain('Astro.response.headers.set("Cache-Control", "no-store")');
  });
});

describe("the confirm form", () => {
  it("is exactly one method=post form carrying the hidden code and both intent buttons", () => {
    const postForms = AUTHORIZE_PAGE.match(/<form class="finish__form" method="post"/g) ?? [];
    expect(postForms).toHaveLength(1);
    expect(AUTHORIZE_PAGE).toMatch(/<input type="hidden" name="code" value=\{view\.code\} \/>/);
    expect(AUTHORIZE_PAGE).toContain('name="intent" value="authorize"');
    expect(AUTHORIZE_PAGE).toContain('name="intent" value="deny"');
  });

  it("asks the phishing-aware framing question naming the machine and the CLI command", () => {
    // The literal wording lives in AUTHORIZE_COPY (decision 4); the page's
    // own source is checked for wiring that copy in, and the copy itself —
    // asserted here — is what makes it visible: "Did you just run
    // `nemar auth login` on <machine>?"
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
    const getForms = AUTHORIZE_PAGE.match(/<form class="finish__form" method="get"/g) ?? [];
    expect(getForms.length).toBeGreaterThanOrEqual(1);
    expect(AUTHORIZE_PAGE).not.toMatch(
      /<form class="finish__form" method="get"[^>]*action="\/cli\/authorize"[^>]*>\s*<input type="hidden" name="code"/,
    );
  });

  it("only renders beneath a refusal when showEnterCodeForm is set", () => {
    expect(AUTHORIZE_PAGE).toContain("view.showEnterCodeForm &&");
  });
});

describe("the done view", () => {
  it("wires both AUTHORIZE_COPY.done sentences in, and they say what a done view must", () => {
    expect(AUTHORIZE_PAGE).toContain("AUTHORIZE_COPY.done.authorized");
    expect(AUTHORIZE_PAGE).toContain("AUTHORIZE_COPY.done.denied");
    expect(AUTHORIZE_COPY.done.authorized).toMatch(/close this tab/i);
    expect(AUTHORIZE_COPY.done.denied).toMatch(/Nothing was authorized/);
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
