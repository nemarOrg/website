/**
 * Placement and wiring guards for the account-tier surfaces (website#301).
 *
 * Source-level assertions rather than rendered-DOM ones, matching
 * `test/signin-notice.test.ts` and `test/use-this-data-placement.test.ts`:
 * Astro files have no rendering harness in this repo (page-level checks run
 * against a live server via `/browse`, see AGENTS.md), so reading the source
 * is the honest cheap check.
 *
 * What these exist to catch is the class of regression the tier work is most
 * exposed to — a page that still tells a base-tier user to wait for an admin,
 * a dropzone whose gate quietly widens back out to "profile complete", or a
 * missing-field link pointing at an id nothing carries. None of those are
 * reachable from the unit tests in `src/lib/*.test.ts`, which cover the
 * derivations but not which page consumes them.
 */

import { describe, expect, it } from "vitest";
// Vite's `?raw`, not node:fs — `astro check` type-checks every file under the
// repo without node types, so a readFileSync here would fail typecheck in CI
// while passing locally under vitest.
import VERIFY_STEP from "../src/components/VerifyEmailStep.astro?raw";
import USER_ADMIN_ROW from "../src/components/admin/UserAdminRow.astro?raw";
import { uploadAccessMissingFields } from "../src/lib/account-tier";
import { DOCS_ACCOUNT_SETTINGS_PATH, DOCS_UPLOAD_ACCESS_PATH } from "../src/lib/docs-base";
import ADMIN_USERS from "../src/pages/admin/users.astro?raw";
import DASHBOARD from "../src/pages/dashboard.astro?raw";
import LOGIN_PENDING from "../src/pages/login/pending.astro?raw";
import LOGIN_VERIFY from "../src/pages/login/verify.astro?raw";
import ONBOARDING from "../src/pages/onboarding.astro?raw";
import SETTINGS from "../src/pages/settings.astro?raw";
import UPLOAD from "../src/pages/upload.astro?raw";
import WELCOME from "../src/pages/welcome.astro?raw";

/**
 * Drop comments so a copy assertion reads the words a USER sees, not the
 * prose explaining why they are absent. Without this, a comment saying
 * "nothing here mentions sandbox" fails the assertion it documents.
 *
 * Deliberately crude — `//` inside a string literal (an href, say) would take
 * the rest of that line with it. That only ever removes text from the haystack
 * these tests search, so it can hide a regression but never invent one; every
 * assertion below is written as `toContain` against markup that carries no
 * `//`, or as a `not.toMatch` where a false pass is the safe direction.
 */
function visibleCopy(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Every page that used to tell a signed-in user an admin was reviewing them. */
const TIER_SURFACES: ReadonlyArray<[string, string]> = [
  ["dashboard.astro", DASHBOARD],
  ["upload.astro", UPLOAD],
  ["welcome.astro", WELCOME],
  ["settings.astro", SETTINGS],
  ["login/pending.astro", LOGIN_PENDING],
];

describe("the under-admin-review copy is gone", () => {
  // The single sentence this whole issue is about. `pending` no longer means
  // "an admin is looking at you" — it means "your inbox is unproved", and the
  // old copy named a queue nobody was in.
  it.each(TIER_SURFACES)("%s does not claim an account is under admin review", (_name, src) => {
    const copy = visibleCopy(src);
    expect(copy).not.toMatch(/under admin review/i);
    expect(copy).not.toMatch(/awaiting admin approval/i);
    expect(copy).not.toMatch(/will review your account/i);
  });

  it.each(TIER_SURFACES)("%s never tells a web user to run sandbox training", (_name, src) => {
    // Sandbox training is CLI-only (nemar-cli ADR 0040) and the web upload
    // gate does not check it, so naming it here would send a browser user to
    // a terminal for a step that changes nothing for them.
    expect(visibleCopy(src)).not.toMatch(/sandbox/i);
  });
});

describe("the verify-your-email step", () => {
  it("is mounted on both the dashboard and the upload page", () => {
    for (const src of [DASHBOARD, UPLOAD]) {
      expect(src).toContain('import VerifyEmailStep from "../components/VerifyEmailStep.astro"');
      expect(src).toContain("<VerifyEmailStep");
    }
  });

  it("renders only for the unverified tier on each", () => {
    expect(DASHBOARD).toMatch(/\{tier === "unverified" \?\s*\(\s*<VerifyEmailStep/);
    expect(UPLOAD).toMatch(/\{uploadState === "verify_email" && \(\s*<VerifyEmailStep/);
  });

  it("offers both halves of the flow: request a code, then submit one", () => {
    expect(VERIFY_STEP).toContain("data-verify-send");
    expect(VERIFY_STEP).toContain("data-verify-code");
    expect(VERIFY_STEP).toContain("requestEmailVerificationCode");
    expect(VERIFY_STEP).toContain("verifyEmailCode");
  });

  it("routes every failure through the shared mapper rather than status text", () => {
    // Handling code_expired / code_incorrect / 429 inline is how the two
    // surfaces would drift; `verifyEmailFailure` is the one definition.
    expect(VERIFY_STEP).toContain("verifyEmailFailure");
    expect(VERIFY_STEP).toContain("failure.needsNewCode");
  });

  it("does not leave a spent code in the box", () => {
    // needsNewCode means the code can never work again; leaving the form up
    // walks the user into a second guaranteed failure.
    expect(VERIFY_STEP).toMatch(/requireNewCode[\s\S]{0,200}form\.hidden = true/);
  });

  it("reloads on success rather than patching one banner", () => {
    // The tier changes what the whole surface renders.
    expect(VERIFY_STEP).toMatch(/Verified[\s\S]{0,200}location\.reload\(\)/);
  });
});

describe("the upload dropzone is gated on service_access alone", () => {
  it("derives its state from the shared helper, not from a local rule", () => {
    expect(UPLOAD).toContain("deriveUploadPageState");
    expect(UPLOAD).toContain("showsUploadForm");
  });

  it("wraps the form in showsUploadForm and nothing else", () => {
    expect(UPLOAD).toMatch(/\{showsUploadForm\(uploadState\) && \(\s*<form class="upload-form"/);
    // The pre-#301 gate was `gate !== "block"`, which shipped the form to any
    // account with a complete profile whether or not it held the grant.
    expect(UPLOAD).not.toContain('gate !== "block"');
    expect(UPLOAD).not.toContain("uploadGate");
  });

  it("shows an ungranted account the request CTA, not a profile gate", () => {
    expect(UPLOAD).toContain('uploadState === "request_access"');
    expect(UPLOAD).toContain('href="/settings#upload-access"');
  });

  it("keeps ADR 0011's warn branch for grandfathered grant-holders", () => {
    expect(UPLOAD).toContain('uploadState === "warn"');
    expect(UPLOAD).toContain("upload-warn__title");
  });
});

describe("onboarding", () => {
  it("is self-gating: it redirects onward when nothing is outstanding", () => {
    expect(ONBOARDING).toContain("onboardingSteps");
    expect(ONBOARDING).toMatch(/steps\.length === 0[\s\S]{0,120}Astro\.redirect\(next\)/);
  });

  it("sends an unverified account to verify first instead of asking for a name", () => {
    expect(ONBOARDING).toMatch(
      /session\.user\.status === "pending"[\s\S]{0,120}Astro\.redirect\("\/dashboard"\)/,
    );
  });

  it("prefills the username from the suggestion endpoint", () => {
    expect(ONBOARDING).toContain("fetchUsernameSuggestion");
    expect(ONBOARDING).toContain('value={suggestion.suggestion ?? ""}');
  });

  it("validates the username live and handles the 409 at the field", () => {
    expect(ONBOARDING).toContain("validateUsername");
    expect(ONBOARDING).toMatch(/code === "username_taken"[\s\S]{0,300}usernameEl\.focus\(\)/);
  });

  it("shows the ORCID-canonical note instead of an editable name field", () => {
    expect(ONBOARDING).toContain("nameMissingUnderOrcid");
    expect(ONBOARDING).toContain("orcid.org/my-orcid");
  });

  it("is where sign-in routes after a successful code", () => {
    expect(LOGIN_VERIFY).toContain("/onboarding?next=");
    // An unverified account goes to the dashboard's verify step, not to the
    // legacy "account under review" page.
    expect(LOGIN_VERIFY).not.toContain('location.href = "/login/pending"');
  });
});

describe("Settings", () => {
  it("carries the ids the missing-field links point at", () => {
    // `uploadAccessMissingFields` builds `/settings#<id>` hrefs; a rename on
    // either side produces a link that scrolls nowhere.
    const anchors = uploadAccessMissingFields([
      "username",
      "given_name",
      "family_name",
      "github_username",
      "city",
      "country",
    ]);
    for (const field of anchors) {
      const id = (field.href ?? "").split("#")[1];
      expect(id, `${field.field} must resolve to an id`).toBeTruthy();
      expect(SETTINGS, `settings.astro is missing id="${id}"`).toContain(`id="${id}"`);
    }
  });

  it("has an upload-access section the CTAs can link to", () => {
    expect(SETTINGS).toContain('id="upload-access"');
    for (const src of [DASHBOARD, UPLOAD, WELCOME]) {
      expect(src).toContain("/settings#upload-access");
    }
  });

  it("renders all three upload-access states", () => {
    expect(SETTINGS).toContain('uploadAccess.kind === "granted"');
    expect(SETTINGS).toContain('uploadAccess.kind === "requested"');
    expect(SETTINGS).toContain('uploadAccess.kind === "not_requested"');
  });

  it("offers the request flow only to a base-tier account with no open request", () => {
    expect(SETTINGS).toMatch(
      /\{tier === "base" && uploadAccess\.kind === "not_requested" && \(\s*<form class="upload-access__form"/,
    );
  });

  it("renders the refusal's missing list as links", () => {
    expect(SETTINGS).toContain("uploadAccessMissingFields");
    expect(SETTINGS).toContain("data-upload-access-missing-list");
    expect(SETTINGS).toMatch(/createElement\("a"\)[\s\S]{0,120}a\.href = field\.href/);
  });

  it("locks the username once the grant is held, and explains why", () => {
    expect(SETTINGS).toContain("const usernameLocked = session.user.service_access === true;");
    expect(SETTINGS).toContain("data-username-locked-note");
    // The backend's own 409 is still rendered, so a stale session flag cannot
    // let someone submit into a lock.
    expect(SETTINGS).toContain('code !== "username_taken" && code !== "username_locked"');
  });

  it("hides the name fields entirely behind a verified ORCID iD", () => {
    // Not merely disabled: the backend refuses the edit, so a submittable
    // control would exist only to fail.
    expect(SETTINGS).toMatch(/\{!orcidVerified && \(\s*<div class="flow" data-name-flow/);
    expect(SETTINGS).toContain("data-name-orcid-note");
  });

  it("reports the tier rather than a two-value status", () => {
    expect(SETTINGS).toContain("deriveAccountTier");
    expect(SETTINGS).toContain("tierLabel");
  });
});

describe("admin users queue", () => {
  it("defaults to the awaiting-approval chip and backs it with the server predicate", () => {
    expect(ADMIN_USERS).toContain('{ value: "awaiting", label: "Awaiting approval" }');
    expect(ADMIN_USERS).toContain("{ awaitingApproval: true }");
    // The old default was `status=verified`, which is now the whole base tier.
    expect(ADMIN_USERS).not.toContain('? "verified"');
  });

  it("approves by numeric id so a username-less web account is reachable", () => {
    expect(ADMIN_USERS).toContain("approveUserById");
    expect(ADMIN_USERS).not.toMatch(/\bapproveUser\b(?!ById)/);
    expect(USER_ADMIN_ROW).toContain("data-user-approve");
    expect(USER_ADMIN_ROW).toContain("data-user-id={user.id}");
  });

  it("renders the backend's refusal message, not just its code", () => {
    expect(ADMIN_USERS).toContain("friendlyApprove");
  });

  it("shows a review card with everything the decision is about", () => {
    expect(USER_ADMIN_ROW).toContain("data-user-review");
    for (const label of [
      "<dt>Name</dt>",
      "<dt>Username</dt>",
      "<dt>Email</dt>",
      "<dt>ORCID</dt>",
      "<dt>GitHub</dt>",
      "<dt>City</dt>",
      "<dt>Country</dt>",
      "<dt>Affiliation</dt>",
    ]) {
      expect(USER_ADMIN_ROW).toContain(label);
    }
    expect(USER_ADMIN_ROW).toContain("user-row__why-text");
    expect(USER_ADMIN_ROW).toContain("requestedDate");
  });

  it("warns when approval will be refused for an unverified email", () => {
    expect(USER_ADMIN_ROW).toMatch(/\{!emailVerified && \(/);
  });

  it("shows the tier in the summary row", () => {
    expect(USER_ADMIN_ROW).toContain("<dt>Tier</dt>");
    expect(USER_ADMIN_ROW).toContain("ADMIN_TIER_LABELS[tier]");
  });

  it("keeps revoke available on an approved account", () => {
    expect(USER_ADMIN_ROW).toContain('const canRevoke = actionable && user.status === "approved"');
    expect(ADMIN_USERS).toContain("revokeUser");
  });

  it("renders the request text as inert text, never as markup", () => {
    // It is untrusted prose written by the requester, sitting on an admin page.
    expect(USER_ADMIN_ROW).not.toMatch(/set:html[\s\S]{0,80}whyText/);
    expect(USER_ADMIN_ROW).toContain("{whyText ||");
  });
});

describe("docs links", () => {
  it("uses the two named slugs under /web/", () => {
    expect(DOCS_ACCOUNT_SETTINGS_PATH).toBe("/web/account-settings/");
    expect(DOCS_UPLOAD_ACCESS_PATH).toBe("/web/upload-access/");
  });

  it("resolves them through resolveDocsBase rather than hardcoding the host", () => {
    for (const [name, src] of [
      ["settings.astro", SETTINGS],
      ["upload.astro", UPLOAD],
      ["dashboard.astro", DASHBOARD],
      ["welcome.astro", WELCOME],
      ["VerifyEmailStep.astro", VERIFY_STEP],
    ] as const) {
      expect(src, `${name} should import the docs base`).toContain("resolveDocsBase");
      expect(src, `${name} should not hardcode a new docs.nemar.org account URL`).not.toMatch(
        /https:\/\/docs\.nemar\.org\/web\/(account-settings|upload-access)/,
      );
    }
  });

  it("links Upload access from the surfaces that gate on it", () => {
    for (const src of [SETTINGS, UPLOAD, DASHBOARD, WELCOME]) {
      expect(src).toContain("DOCS_UPLOAD_ACCESS_PATH");
    }
  });

  it("links Account settings from the account surfaces", () => {
    for (const src of [SETTINGS, ONBOARDING, VERIFY_STEP]) {
      expect(src).toContain("DOCS_ACCOUNT_SETTINGS_PATH");
    }
  });
});
