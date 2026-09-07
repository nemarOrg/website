/**
 * Source-level guards for website#305: every page that can render an
 * identity-uniqueness refusal must go through the shared
 * `src/lib/identity-errors.ts` mapping, and none of them may branch on the
 * deprecated `orcid_already_linked` code as a case distinct from
 * `orcid_in_use`.
 *
 * Astro files have no rendering harness in this repo (page-level checks run
 * against a live server via `/browse`, see AGENTS.md), so reading the source
 * is the honest cheap check -- same pattern as `test/signin-notice.test.ts`.
 */

import { describe, expect, it } from "vitest";
import COMPLETE_PAGE from "../src/pages/auth/orcid/complete.astro?raw";
import LOGIN_PAGE from "../src/pages/login.astro?raw";
import SETTINGS_PAGE from "../src/pages/settings.astro?raw";

const ALL_PAGES = [
  { name: "login.astro", source: LOGIN_PAGE },
  { name: "settings.astro", source: SETTINGS_PAGE },
  { name: "auth/orcid/complete.astro", source: COMPLETE_PAGE },
];

// login.astro and settings.astro build their whole error-message record at
// module-evaluation time (an Astro frontmatter, not a browser script) and
// already guard every lookup into it with Object.hasOwn before indexing, so
// spreading the shared map straight into that record is safe there.
const SPREAD_PAGES = [
  { name: "login.astro", source: LOGIN_PAGE, importPath: "../lib/identity-errors" },
  { name: "settings.astro", source: SETTINGS_PAGE, importPath: "../lib/identity-errors" },
];

describe("shared identity-conflict mapping is used, not reimplemented", () => {
  for (const { name, source, importPath } of SPREAD_PAGES) {
    it(`${name} imports IDENTITY_CONFLICT_MESSAGES from the shared module`, () => {
      expect(source).toContain(`import { IDENTITY_CONFLICT_MESSAGES } from "${importPath}"`);
    });

    it(`${name} spreads the shared mapping into its local error-message record`, () => {
      expect(source).toMatch(/\.\.\.IDENTITY_CONFLICT_MESSAGES/);
    });
  }

  // complete.astro is a browser <script>: it looks up a code straight from a
  // fetch() JSON response, so a plain-object spread indexed without a guard
  // (`MESSAGES[code]`) would resolve a prototype key ("constructor",
  // "toString", ...) to a function instead of undefined. It must go through
  // the exported identityConflictMessage() helper, which applies the
  // Object.hasOwn guard internally, rather than reimplementing the guard or
  // (worse) indexing the shared map directly.
  it("complete.astro imports identityConflictMessage from the shared module", () => {
    expect(COMPLETE_PAGE).toContain(
      'import { identityConflictMessage } from "../../../lib/identity-errors"',
    );
  });

  it("complete.astro calls identityConflictMessage rather than indexing the map directly", () => {
    expect(COMPLETE_PAGE).toMatch(/identityConflictMessage\(/);
    expect(COMPLETE_PAGE).not.toMatch(/\.\.\.IDENTITY_CONFLICT_MESSAGES/);
    expect(COMPLETE_PAGE).not.toContain("IDENTITY_CONFLICT_MESSAGES[");
  });

  for (const { name, source } of ALL_PAGES) {
    it(`${name} does not branch on the deprecated orcid_already_linked code`, () => {
      // The only allowed appearance is inside a comment explaining the fold;
      // it must never be used as an object key (`orcid_already_linked:`) or
      // a switch/case/equality target, which would reintroduce a second
      // branch for what is now one case.
      expect(source).not.toMatch(/orcid_already_linked\s*:/);
      expect(source).not.toMatch(/["'`]orcid_already_linked["'`]\s*(===|==)/);
      expect(source).not.toMatch(/case\s+["'`]orcid_already_linked["'`]/);
    });
  }

  it("login.astro no longer hardcodes its own orcid_linked_other sentence", () => {
    // It still renders the code, but the text now comes from the shared map,
    // not a locally duplicated string literal.
    expect(LOGIN_PAGE).not.toMatch(/orcid_linked_other:\s*"/);
  });

  it("settings.astro no longer hardcodes its own orcid_linked_other sentence", () => {
    expect(SETTINGS_PAGE).not.toMatch(/orcid_linked_other:\s*"/);
  });

  it("complete.astro no longer hardcodes its own email_in_use sentence", () => {
    expect(COMPLETE_PAGE).not.toMatch(/email_in_use:\s*"/);
  });
});
