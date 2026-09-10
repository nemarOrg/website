/**
 * Source-level guards for `/auth/docs/authorize` (nemarOrg/nemar-cli#1338), in the style of
 * `test/cli-authorize-ui.test.ts`: this repo has no Astro rendering harness, so reading the page
 * source via Vite's `?raw` (never `node:fs` — `astro check` type-checks every file under the repo
 * with no `@types/node`) is the honest cheap check for a server-rendered page with no client script.
 *
 * WHY THIS FILE EXISTS SEPARATELY from `src/lib/docs-authorize.test.ts`. That file covers the pure
 * helpers, which is where the `next` validation lives and where an attacker-supplied value is
 * refused. It cannot cover the PAGE's decisions, and the page is where four load-bearing lines live
 * that no helper test can reach: the `Origin` header that stops the backend answering 403, the
 * `pathname + search` that makes the return address survive sign-in, `no-store` on every early
 * return, and the environment check that refuses to mint a grant this deployment could not spend.
 * Each of those can be broken by a plausible refactor while every existing test stays green.
 */

import { describe, expect, it } from "vitest";
import DOCS_AUTHORIZE_PAGE from "../src/pages/auth/docs/authorize.astro?raw";

describe("the admin gate", () => {
  it("reuses adminGate rather than re-deriving the rule", () => {
    expect(DOCS_AUTHORIZE_PAGE).toContain("adminGate(session, here)");
  });

  it("passes the path AND query into the gate, so the inner next survives sign-in", () => {
    // Passing only `url.pathname` would strand every visitor on the docs admin index after signing
    // in, instead of the page the docs host sent them to fetch. Nothing else in the flow would fail.
    expect(DOCS_AUTHORIZE_PAGE).toContain("const here = `${url.pathname}${url.search}`");
  });
});

describe("the environment check runs before anything is minted", () => {
  it("resolves a handoff target from the API base and the configured docs base", () => {
    expect(DOCS_AUTHORIZE_PAGE).toContain(
      "docsHandoffTarget(apiBase(), import.meta.env.PUBLIC_DOCS_BASE_URL ?? null)",
    );
  });

  it("only calls the backend inside the ready branch", () => {
    // The order is the whole point: a grant minted on a deployment whose docs base is production
    // while its API is not could only be spent against a database that never saw it, and the
    // visitor would be handed to the wrong host. Refusing afterwards would be too late.
    const readyAt = DOCS_AUTHORIZE_PAGE.indexOf('handoff.kind === "ready"');
    const grantAt = DOCS_AUTHORIZE_PAGE.indexOf("await requestDocsGrant(");
    expect(readyAt).toBeGreaterThan(-1);
    expect(grantAt).toBeGreaterThan(readyAt);
  });

  it("answers 503 rather than 200 when it refuses", () => {
    expect(DOCS_AUTHORIZE_PAGE).toMatch(/handoff\.reason[\s\S]{0,120}Astro\.response\.status = 503/);
  });
});

describe("the backend call", () => {
  it("pins Origin to the request's own origin, never a hardcoded host", () => {
    // `isAllowedOrigin` on the backend refuses a MISSING Origin, and every cookie-authenticated
    // POST checks Origin BEFORE authentication, so dropping this line turns the whole flow into a
    // 403 that looks like a backend outage. Using the request's own origin is also what lets
    // staging's test.nemar.org pass the *.nemar.org rule.
    expect(DOCS_AUTHORIZE_PAGE).toContain("origin: Astro.url.origin");
    expect(DOCS_AUTHORIZE_PAGE).not.toMatch(/origin:\s*"https:\/\//);
  });

  it("forwards the visitor's own cookie header", () => {
    expect(DOCS_AUTHORIZE_PAGE).toContain('Astro.request.headers.get("cookie")');
  });
});

describe("each outcome maps to one destination", () => {
  it("hands a minted code to the docs callback", () => {
    expect(DOCS_AUTHORIZE_PAGE).toMatch(
      /kind === "handoff"[\s\S]{0,120}noStoreRedirect\(docsCallbackUrl\(docsBase, outcome\.code, next\)\)/,
    );
  });

  it("treats a backend 401 as no session at all", () => {
    expect(DOCS_AUTHORIZE_PAGE).toMatch(
      /kind === "signed_out"[\s\S]{0,200}\/login\?error=session_required&next=\$\{encodeURIComponent\(here\)\}/,
    );
  });

  it("forwards the backend's 404 for a non-admin unchanged, never a 403", () => {
    expect(DOCS_AUTHORIZE_PAGE).toMatch(/kind === "not_found"[\s\S]{0,120}noStoreRedirect\("\/404"\)/);
    expect(DOCS_AUTHORIZE_PAGE).not.toMatch(/status:\s*403/);
  });

  it("answers 503 for an unavailable backend instead of rendering a 200", () => {
    expect(DOCS_AUTHORIZE_PAGE).toMatch(/unavailable[\s\S]{0,400}Astro\.response\.status = 503/);
  });
});

describe("no-store on every response", () => {
  it("never calls the bare Astro.redirect - every redirect goes through noStoreRedirect", () => {
    // Matches an actual call site, not the doc comment above explaining why the helper exists,
    // which necessarily also contains the words `Astro.redirect(`.
    expect(DOCS_AUTHORIZE_PAGE).not.toMatch(/return Astro\.redirect\(/);
  });

  it("the noStoreRedirect helper itself sets Cache-Control: no-store", () => {
    expect(DOCS_AUTHORIZE_PAGE).toMatch(
      /function noStoreRedirect\([\s\S]{0,200}"Cache-Control":\s*"no-store"/,
    );
  });

  it("sets no-store on the page-level response too, before the gate runs", () => {
    const noStoreAt = DOCS_AUTHORIZE_PAGE.indexOf(
      'Astro.response.headers.set("Cache-Control", "no-store")',
    );
    const gateAt = DOCS_AUTHORIZE_PAGE.indexOf("adminGate(session, here)");
    expect(noStoreAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(noStoreAt);
  });
});

describe("nothing about the failure reaches the visitor", () => {
  it("renders only the fixed copy, never an upstream status or body", () => {
    expect(DOCS_AUTHORIZE_PAGE).toContain("DOCS_AUTHORIZE_COPY.errorTitle");
    expect(DOCS_AUTHORIZE_PAGE).toContain("DOCS_AUTHORIZE_COPY.errorBody");
    expect(DOCS_AUTHORIZE_PAGE).not.toMatch(/\{\s*outcome\.kind\s*\}/);
  });

  it("has no client-side script", () => {
    expect(DOCS_AUTHORIZE_PAGE).not.toMatch(/<script(?![^>]*\bis:raw\b)/);
  });
});
