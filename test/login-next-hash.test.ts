/**
 * The /login script carries the page's fragment (`#compute-access` from Settings) through sign-in
 * (website#498). The rule is `nextWithHash` in `src/lib/auth.ts` (tested in `auth.test.ts`); this guards
 * that the script uses it and that the next hops still validate `next`.
 */
import { describe, expect, it } from "vitest";
import LOGIN from "../src/pages/login.astro?raw";
import VERIFY from "../src/pages/login/verify.astro?raw";

describe("the login page script", () => {
  it("appends the location hash to next through nextWithHash, once, before the request", () => {
    expect(LOGIN).toContain('import { nextWithHash } from "../lib/auth";');
    expect(LOGIN).toContain('nextWithHash(form.dataset.next ?? "/", location.hash)');
    expect(LOGIN.indexOf("nextWithHash(form")).toBeLessThan(LOGIN.indexOf('params.set("next"'));
  });

  it("the verify page still validates next with safeRedirectPath", () => {
    expect(VERIFY).toContain('safeRedirectPath(url.searchParams.get("next"))');
  });

  it("the ORCID button's server-computed link is not changed (a fragment cannot reach it)", () => {
    expect(LOGIN).toContain("safeRedirectPath(");
  });
});
