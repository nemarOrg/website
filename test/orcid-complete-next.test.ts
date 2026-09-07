/**
 * `next` survives a brand-new ORCID sign-up (epic #1272 phase 2,
 * nemarOrg/website#316): `complete.astro` reads `?next=` and, when set,
 * finishes at `/dashboard?next=...` instead of `/welcome`; `dashboard.astro`
 * passes it on to `VerifyEmailStep`, which navigates there on success
 * instead of reloading. Source-level checks (`?raw`), the same convention
 * `test/account-tiers-ui.test.ts` and `test/cli-authorize-ui.test.ts` use —
 * this repo has no Astro rendering harness.
 *
 * The backend half (appending `?next=` to the `/auth/orcid/complete`
 * redirect) is phase 3's PR; this only exercises the website side, which
 * must already be correct so the day that lands, the trip completes with no
 * further website change.
 */

import { describe, expect, it } from "vitest";
import VERIFY_STEP from "../src/components/VerifyEmailStep.astro?raw";
import COMPLETE_PAGE from "../src/pages/auth/orcid/complete.astro?raw";
import DASHBOARD from "../src/pages/dashboard.astro?raw";
import UPLOAD from "../src/pages/upload.astro?raw";

describe("complete.astro reads and forwards next", () => {
  it("computes next via safeRedirectPath from its own query string", () => {
    expect(COMPLETE_PAGE).toContain('import { safeRedirectPath } from "../../../lib/auth"');
    expect(COMPLETE_PAGE).toMatch(
      /const next = safeRedirectPath\(new URL\(Astro\.request\.url\)\.searchParams\.get\("next"\)\)/,
    );
  });

  it("carries next on the form as a data attribute", () => {
    expect(COMPLETE_PAGE).toMatch(/<form class="finish__form" data-finish-form data-next=\{next\}/);
  });

  it("finishes at /dashboard?next=... instead of /welcome when next was supplied", () => {
    expect(COMPLETE_PAGE).toContain("const nextPath = form.dataset.next");
    expect(COMPLETE_PAGE).toMatch(
      /nextPath !== "\/" \? `\/dashboard\?next=\$\{encodeURIComponent\(nextPath\)\}` : "\/welcome"/,
    );
  });
});

describe("dashboard.astro forwards next to VerifyEmailStep", () => {
  it("derives verifyNext via safeRedirectPath, undefined for the ordinary case", () => {
    expect(DASHBOARD).toContain('import { getSession, safeRedirectPath } from "../lib/auth"');
    expect(DASHBOARD).toMatch(/const next = safeRedirectPath\(url\.searchParams\.get\("next"\)\)/);
    expect(DASHBOARD).toMatch(/const verifyNext = next !== "\/" \? next : undefined/);
  });

  it("passes verifyNext into the mounted VerifyEmailStep", () => {
    expect(DASHBOARD).toMatch(
      /<VerifyEmailStep email=\{session\.user\.email\} context="dashboard" next=\{verifyNext\} \/>/,
    );
  });

  it("still renders VerifyEmailStep only for the unverified tier", () => {
    expect(DASHBOARD).toMatch(/\{tier === "unverified" \?\s*\(\s*<VerifyEmailStep/);
  });
});

describe("VerifyEmailStep accepts an optional next and navigates there on success", () => {
  it("declares next as an optional prop and reads it onto the root element", () => {
    expect(VERIFY_STEP).toMatch(/next\?:\s*string/);
    expect(VERIFY_STEP).toContain("data-verify-next={next}");
  });

  it("reads the dataset value once, then branches every success path on it", () => {
    expect(VERIFY_STEP).toContain("const nextPath = root.dataset.verifyNext;");
    const branches =
      VERIFY_STEP.match(/nextPath \? \(location\.href = nextPath\) : location\.reload\(\)/g) ?? [];
    // Both success exits: the already-verified short-circuit and the
    // verify-code success path.
    expect(branches.length).toBe(2);
  });

  it("upload.astro's mount passes no next, so it keeps reloading in place", () => {
    // `nextPath` reads `root.dataset.verifyNext`, which Astro omits entirely
    // for an `undefined` prop — so upload.astro not passing `next` at all is
    // what makes the ternary's `: location.reload()` branch the one that
    // actually runs there, unchanged from before this feature.
    expect(UPLOAD).toMatch(/<VerifyEmailStep email=\{session\.user\.email\} context="upload" \/>/);
  });
});
