/**
 * Source-level guards for the unsubscribe page (`src/pages/unsubscribe/[token].astro`, epic
 * nemarOrg/nemar-cli#2260 phase 5), in the style of `test/cli-authorize-ui.test.ts`: there is no
 * Astro rendering harness in this repo, so the page's states are tested through the pure view
 * (`src/lib/mail-unsubscribe.test.ts`) and these checks pin how the page uses it.
 */

import { describe, expect, it } from "vitest";
import BASE from "../src/layouts/Base.astro?raw";
import PAGE from "../src/pages/unsubscribe/[token].astro?raw";

const frontmatter = PAGE.split("---")[1] ?? "";

describe("the page never acts on load", () => {
  it("reads only the info route while rendering, and never imports the press", () => {
    expect(frontmatter).toContain("await fetchUnsubscribeInfo(token)");
    expect(PAGE).not.toContain("postUnsubscribe");
    expect(PAGE).not.toMatch(/method:\s*"POST"/);
  });

  it("asks the API only for a token of the right shape", () => {
    expect(frontmatter).toMatch(
      /isMailUnsubscribeToken\(token\)\s*\?\s*await fetchUnsubscribeInfo\(token\)\s*:\s*\{ kind: "invalid" \}/,
    );
  });

  it("changes mail only through the two form posts to the endpoint", () => {
    const forms = [...PAGE.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
    expect(forms).toHaveLength(2);
    for (const form of forms) {
      expect(form).toContain('method="post"');
      expect(form).toContain('action="/api/mail/unsubscribe"');
    }
    expect(PAGE).toContain('<input type="hidden" name="scope" value="category" />');
    expect(PAGE).toContain('<input type="hidden" name="scope" value="all" />');
    expect(PAGE).toContain("Unsubscribe from {label}");
    expect(PAGE).toContain("Unsubscribe from all NEMAR community mail");
  });

  it("runs no script of its own", () => {
    expect(PAGE).not.toMatch(/<script\b/);
  });
});

describe("what the page says", () => {
  it("renders every view state", () => {
    for (const state of ["invalid", "unavailable", "ask", "done"]) {
      expect(PAGE).toContain(`view.state === "${state}"`);
    }
  });

  it("explains recalls from the account copy, and links settings and the policy", () => {
    expect(frontmatter).toContain("const recallWhy = mailRecallWhy();");
    expect(PAGE).toContain("{recallWhy}");
    expect(PAGE).toContain('href="/settings"');
    expect(PAGE).toContain("href={COMMUNITY_MAIL_POLICY_URL}");
  });

  it("gives every link on the page rel=noreferrer", () => {
    const anchors = [...PAGE.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) expect(a).toContain('rel="noreferrer"');
  });
});

describe("privacy", () => {
  it("sets the privacy headers and answers with the view's status", () => {
    expect(frontmatter).toMatch(
      /for \(const \[name, value\] of Object\.entries\(UNSUBSCRIBE_PRIVACY_HEADERS\)\) \{\s*Astro\.response\.headers\.set\(name, value\);/,
    );
    expect(frontmatter).toContain("Astro.response.status = statusForView(view);");
  });

  it("asks the layout for a robots meta, which the layout renders", () => {
    expect(PAGE).toMatch(/<Base [^>]*\bnoindex\b[^>]*>/);
    expect(BASE).toContain('{noindex && <meta name="robots" content="noindex, nofollow" />}');
  });
});
