/**
 * Wiring guard for the sign-out redirect (#385).
 *
 * `src/lib/host.test.ts` pins `SIGNED_OUT_PATH` itself: an app route that is
 * not cross-host redirected without a session. Nothing there proves the
 * handler still redirects to it, so a revert to `Location: "/"` would pass
 * every other test. Source-level assertion, as in
 * `test/dataset-card-updated.test.ts`: the handler needs a Workers runtime to
 * execute.
 *
 * What this catches is sign-out sending the person to `/`. On the app host
 * that route answers `301 -> https://nemar.org/` once the session cookie is
 * gone, and a browser applies the page's CSP `form-action 'self'` to every hop
 * of a form redirect chain.
 */

import { describe, expect, it } from "vitest";
import LOGOUT from "../src/pages/api/auth/logout.ts?raw";

/** Drop comments so the assertions read code, not the prose explaining it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("sign-out redirect", () => {
  const code = withoutComments(LOGOUT);

  it("sends both HTML branches (dev and production) to SIGNED_OUT_PATH", () => {
    expect(code.match(/Location:\s*SIGNED_OUT_PATH/g)).toHaveLength(2);
  });

  it("never redirects a sign-out to the marketing root", () => {
    expect(code).not.toMatch(/Location:\s*["']\/["']/);
  });
});
