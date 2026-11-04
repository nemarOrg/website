/**
 * Wiring guard for the pending-signup page (`pages/auth/orcid/complete.astro`; nemar-cli ADR
 * 0119, decision 10).
 *
 * The API moved the pending-signup cookie to `__Host-nemar_orcid_pending`. The page checks that the
 * cookie is present before it shows the email form, and a signup that was in flight when the API
 * changed still holds the old name, so the page has to accept either (it does not bounce; the
 * API's finalize reads only the new name, so that signup fails there once). `lib/auth.test.ts` pins
 * `hasOrcidPendingCookie` itself; this pins that the page asks it, because a revert to a bare
 * `cookies.has("nemar_orcid_pending")` would pass every other test and bounce the signup.
 * Source-level, as in `test/logout-redirect.test.ts`: an Astro page needs a Workers runtime to run.
 */

import { describe, expect, it } from "vitest";
import COMPLETE from "../src/pages/auth/orcid/complete.astro?raw";

/** Drop comments so the assertions read code, not the prose explaining it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the pending-signup page's cookie check", () => {
  const code = withoutComments(COMPLETE);

  it("asks the helper that accepts both names", () => {
    expect(code).toMatch(/hasOrcidPendingCookie\(\s*Astro\.cookies\s*\)/);
  });

  it("does not check one name on its own", () => {
    expect(code).not.toMatch(/cookies\.has\(\s*["'`]/);
    expect(code).not.toMatch(/nemar_orcid_pending/);
  });
});
