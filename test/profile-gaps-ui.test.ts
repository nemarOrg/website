/**
 * Wiring guards for the profile-gap surfaces (website#309).
 *
 * Source-level assertions, matching `test/account-tiers-ui.test.ts` and the
 * rest of `test/*.test.ts`: Astro files have no rendering harness in this repo
 * (page-level checks run against a live server via `/browse`, see AGENTS.md),
 * so reading the source is the honest cheap check.
 *
 * What they exist to catch is the one regression this issue is about — a
 * surface that goes back to wording a missing field in its own words. Nothing
 * in `src/lib/profile-gaps.test.ts` can see a page that stops calling the
 * module, and nothing in the page can fail on its own for describing a gap
 * differently; it just quietly disagrees with the CLI again.
 */

import { describe, expect, it } from "vitest";
import PROFILE_NUDGE from "../src/components/ProfileNudge.astro?raw";
// Vite's `?raw`, not node:fs — `astro check` type-checks every file under the
// repo without node types, so a readFileSync here would fail typecheck in CI
// while passing locally under vitest.
import USER_ADMIN_ROW from "../src/components/admin/UserAdminRow.astro?raw";
import { ACCOUNT_COPY } from "../src/lib/account-copy";
import ADMIN_USER_DETAIL from "../src/pages/admin/users/[username].astro?raw";
import DASHBOARD from "../src/pages/dashboard.astro?raw";
import ONBOARDING from "../src/pages/onboarding.astro?raw";
import SETTINGS from "../src/pages/settings.astro?raw";
import UPLOAD from "../src/pages/upload.astro?raw";
import WELCOME from "../src/pages/welcome.astro?raw";

/** The five pages the issue names, plus the two admin surfaces. */
const SURFACES: ReadonlyArray<[string, string]> = [
  ["dashboard.astro", DASHBOARD],
  ["settings.astro", SETTINGS],
  ["upload.astro", UPLOAD],
  ["onboarding.astro", ONBOARDING],
  ["welcome.astro", WELCOME],
  ["admin/UserAdminRow.astro", USER_ADMIN_ROW],
  ["admin/users/[username].astro", ADMIN_USER_DETAIL],
];

/**
 * Every `.astro` and `.ts` source under `src/`, as text, minus the copy table
 * itself and the unit tests beside it.
 *
 * Eager and raw so the consumer check below can grep the whole tree: a key is
 * "used" when some page, component or lib names it, and there is no cheaper
 * way to ask that question than looking. `account-copy.ts` is excluded
 * because it is the definition — including it would make every key trivially
 * used, which is the exact failure this is here to catch.
 */
const SRC_FILES: Record<string, string> = {
  ...(import.meta.glob("../src/pages/**/*.astro", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>),
  ...(import.meta.glob("../src/components/**/*.astro", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>),
  ...(import.meta.glob("../src/layouts/**/*.astro", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>),
  ...(import.meta.glob("../src/lib/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>),
};

const CONSUMER_SOURCES = Object.entries(SRC_FILES)
  .filter(([path]) => !path.endsWith("/account-copy.ts") && !path.endsWith(".test.ts"))
  .map(([, source]) => source)
  .join("\n");

describe("every copy key has a consumer", () => {
  it("finds each key named by a page, component or lib", () => {
    // The mirroring is not symmetric. nemar-cli's contract may carry keys
    // this repo has no surface for — the drift test reports those as a note —
    // but a key on THIS side that nothing reads is copy nobody can see, kept
    // in step with another repo for nothing. Four such keys shipped in the
    // first draft of this branch.
    const orphans = Object.keys(ACCOUNT_COPY).filter(
      (key) => !CONSUMER_SOURCES.includes(`"${key}"`),
    );
    expect(
      orphans,
      "unused copy keys: consume them or delete them (see account-copy.ts rule 4)",
    ).toEqual([]);
  });

  it("is actually reading sources, not an empty haystack", () => {
    // A glob that resolved to nothing would make the check above pass for
    // every key at once, which is the one way it could be silently useless.
    expect(Object.keys(SRC_FILES).length).toBeGreaterThan(20);
    expect(CONSUMER_SOURCES).toContain('ACCOUNT_COPY["gaps.title"]');
    expect(CONSUMER_SOURCES).not.toContain("the copy table. Read it through");
  });
});

describe("wording comes from one source", () => {
  it.each(SURFACES)("%s reads its account copy from the module", (_name, src) => {
    expect(src).toContain("account-copy");
    expect(src).toContain("ACCOUNT_COPY[");
  });

  it.each(SURFACES)("%s never spells a gap sentence itself", (_name, src) => {
    // `describeGap` composes it from `account-copy.ts`; a page that writes
    // the words out has left the contract without failing anything else.
    expect(src).not.toContain("is missing: needed");
    expect(src).not.toMatch(/Set it in \w+ or run/);
  });

  it.each(SURFACES)("%s does not re-word the tier or the request", (_name, src) => {
    // The four sentences that used to be duplicated across these pages. Each
    // is now one key; finding the literal again means a copy was pasted back.
    expect(src).not.toContain("Want to contribute a dataset?");
    expect(src).not.toContain("Ask for upload access first");
    expect(src).not.toContain("An admin is reviewing your request");
    expect(src).not.toMatch(/A one-time admin grant/);
  });
});

describe("the dashboard nudge", () => {
  it("takes resolved gaps, not a field-name list", () => {
    expect(PROFILE_NUDGE).toContain(
      'import { type ProfileGap, gapTail } from "../lib/profile-gaps"',
    );
    expect(PROFILE_NUDGE).toMatch(/gaps: readonly ProfileGap\[\]/);
    // The pre-#309 prop. Passing field names again would put the wording
    // back in the component.
    expect(PROFILE_NUDGE).not.toContain("formatFieldList");
    expect(PROFILE_NUDGE).not.toContain("ProfileField");
  });

  it("renders one line per gap, with the label linked at the field", () => {
    expect(PROFILE_NUDGE).toMatch(/gaps\.map\(\(gap\) => \(/);
    expect(PROFILE_NUDGE).toContain('<a class="nudge__field" href={gap.href}>{gap.label}</a>');
    expect(PROFILE_NUDGE).toContain("{gapTail(gap)}");
  });

  it("keys the dismissal on the gap set, so filling one field re-surfaces it", () => {
    expect(PROFILE_NUDGE).toMatch(
      /dismissKey = `nemar:profile-nudge:\$\{userId\}:\$\{gaps[\s\S]{0,120}\.sort\(\)/,
    );
  });

  it("stays a nudge: dismissible, and gating nothing", () => {
    expect(PROFILE_NUDGE).toContain("data-profile-nudge-dismiss");
    expect(PROFILE_NUDGE).toContain('localStorage.setItem(key, "1")');
  });

  it("is fed by the dashboard from the resolved identity", () => {
    // `/auth/me` carries no username, so passing `session.user` alone would
    // silently drop the username gap for every account.
    expect(DASHBOARD).toContain("<ProfileNudge gaps={gaps} userId={session.user.id} />");
    expect(DASHBOARD).toContain("profileGaps({ ...session.user, username: identity.username })");
  });
});

describe("Settings", () => {
  it("puts the gap list at the top of the account card", () => {
    // Before the account fields, not after them: the list is what the person
    // came to act on, and every control it names is on the same screen.
    const gapsAt = SETTINGS.indexOf("data-account-gaps");
    const kvAt = SETTINGS.indexOf('<dl class="kv">');
    expect(gapsAt).toBeGreaterThan(-1);
    expect(gapsAt).toBeLessThan(kvAt);
    expect(SETTINGS).toContain('ACCOUNT_COPY["gaps.title"]');
  });

  it("derives it from the same module as the dashboard", () => {
    expect(SETTINGS).toContain("profileGaps({ ...session.user, username: identity.username })");
    expect(SETTINGS).toContain("{gapTail(gap)}");
  });

  it("renders a refusal's missing list through describeGap", () => {
    // This is the sentence-for-sentence parity the issue asks for: the words
    // the request comes back with are the words the nudge already used.
    expect(SETTINGS).toContain("gapsForFields(missing, { orcidVerified })");
    expect(SETTINGS).toContain("describeGap(gap)");
    expect(SETTINGS).toContain("gapTail(gap)");
  });

  it("renders a positive empty state instead of vanishing", () => {
    // A block that only appears while something is wrong makes its own
    // absence ambiguous: "nothing outstanding" and "this build does not
    // check" look identical from the outside.
    expect(SETTINGS).toContain("data-account-gaps-none");
    expect(SETTINGS).toContain('ACCOUNT_COPY["gaps.none"]');
    expect(SETTINGS).toMatch(/gaps\.length === 0 \? \(/);
    // Not wrapped in a `gaps.length > 0 &&` guard any more.
    expect(SETTINGS).not.toContain("{gaps.length > 0 && (");
  });

  it("names the upload page once in the granted paragraph", () => {
    // The copy sentence already says "from the upload page"; the link used to
    // repeat the noun and left the paragraph ending on a dangling duplicate
    // after the publishing clause.
    // Anchored on the paragraph, not on the branch: `uploadAccess.kind ===
    // "granted"` also opens the status badge above it.
    const block = SETTINGS.match(
      /\{uploadAccess\.kind === "granted" && \(\s*<p class="upload-access__body">([\s\S]*?)<\/p>/,
    )?.[1];
    expect(block, "granted branch not found in settings.astro").toBeTruthy();
    const rendered = (block as string)
      .replace(
        /\{ACCOUNT_COPY\["upload_access\.granted\.body"\]\}/,
        ACCOUNT_COPY["upload_access.granted.body"],
      )
      .replace(/\{" "\}/g, " ")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    expect(rendered).toBe(`${ACCOUNT_COPY["upload_access.granted.body"]} Upload now.`);
    expect(rendered.match(/upload page/gi)).toHaveLength(1);
  });

  it("tells the browser script whether a verified iD owns the name", () => {
    // Without it a refusal naming given_name/family_name points a
    // verified-ORCID account at Settings fields it does not get.
    expect(SETTINGS).toContain('data-orcid-verified={orcidVerified ? "true" : "false"}');
    expect(SETTINGS).toContain('form.dataset.orcidVerified === "true"');
  });
});

describe("/upload", () => {
  it("lists what would block the request, before the request link", () => {
    const gapsAt = UPLOAD.indexOf("upload-gate__gaps-list");
    const ctaAt = UPLOAD.indexOf('<a class="upload-gate__cta" href="/settings#upload-access">');
    expect(gapsAt).toBeGreaterThan(-1);
    expect(gapsAt).toBeLessThan(ctaAt);
  });

  it("lists only the gaps that would refuse the request", () => {
    // A publication-only gap is not what this page is about, and naming it
    // beside a request CTA would read as another reason the request will
    // fail.
    expect(UPLOAD).toContain(
      'gapsBlocking(profileGaps({ ...session.user, username: identity.username }), "upload_access")',
    );
  });

  it("spends the identity lookup only on the state that renders the list", () => {
    expect(UPLOAD).toMatch(/uploadState === "request_access"\s*\?\s*await fetchAccountIdentity\(/);
  });

  it("keeps the dropzone gated on the tier, not on the gaps", () => {
    // The gaps are informational here. `showsUploadForm` is still the only
    // thing between an account and the form (website#301).
    expect(UPLOAD).toMatch(/\{showsUploadForm\(uploadState\) && \(\s*<form class="upload-form"/);
    expect(UPLOAD).not.toMatch(/requestGaps\.length[^}]*showsUploadForm/);
  });
});

describe("onboarding", () => {
  it("offers the one-time change when the username was assigned", () => {
    expect(ONBOARDING).toContain("session.user.username_auto_assigned === true");
    expect(ONBOARDING).toContain('ACCOUNT_COPY["onboarding.username.auto_assigned.title"]');
    expect(ONBOARDING).toContain('ACCOUNT_COPY["onboarding.username.auto_assigned.body"]');
  });

  it("stops self-gating away while that offer is outstanding", () => {
    // The page redirects onward when nothing is outstanding; an assigned
    // username raises no step, so without this the offer could never be seen.
    expect(ONBOARDING).toContain("if (steps.length === 0 && !usernameAssigned) {");
    expect(ONBOARDING).toContain("const showUsername = needsUsername || usernameAssigned;");
  });

  it("does not re-send an assigned username that was not edited", () => {
    // Re-sending the handle the row already holds risks a `username_taken`
    // collision with itself, for no change.
    expect(ONBOARDING).toContain('data-username-owned={usernameAssigned ? "true" : "false"}');
    expect(ONBOARDING).toContain('if (!usernameUnchanged) put("username", usernameEl);');
    // Keeping the assigned handle and continuing is an acceptance, not an
    // empty form.
    expect(ONBOARDING).toMatch(/if \(usernameUnchanged\) \{\s*location\.href = next;/);
  });

  it("treats an absent flag as false, so nothing changes until phase 8", () => {
    expect(ONBOARDING).not.toContain("username_auto_assigned !== false");
    expect(ONBOARDING).not.toContain("username_auto_assigned ?? true");
  });
});

describe("the admin surfaces", () => {
  it.each([
    ["UserAdminRow.astro", USER_ADMIN_ROW],
    ["admin/users/[username].astro", ADMIN_USER_DETAIL],
  ])("%s shows the requester's gaps from the shared module", (_name, src) => {
    expect(src).toContain("profileGaps(gapAccountFromDetail(");
    expect(src).toContain("describeGapBlocks(gap)");
    expect(src).toContain('ACCOUNT_COPY["gaps.admin.title"]');
    expect(src).toContain("data-user-gaps");
  });

  it("distinguishes a detail fetch that did not land from an account with nothing missing", () => {
    // The listing carries no city or country, so a field nobody asked for is
    // not a field the user left blank — collapsing them would have an admin
    // chasing someone over a 502.
    expect(USER_ADMIN_ROW).toContain(
      "const reviewGaps = detail ? profileGaps(gapAccountFromDetail(detail)) : null;",
    );
    expect(USER_ADMIN_ROW).toContain('ACCOUNT_COPY["gaps.admin.not_loaded"]');
    expect(USER_ADMIN_ROW).toContain('ACCOUNT_COPY["gaps.admin.none"]');
  });

  it("leaves approve available whatever the gap list says", () => {
    // The backend decides (and refuses an unverified email with a sentence
    // saying so). An admin granting access to an account with an outstanding
    // field is a judgement this card informs, not one it blocks.
    for (const src of [USER_ADMIN_ROW, ADMIN_USER_DETAIL]) {
      expect(src).toContain("canApproveUser(");
      expect(src).not.toMatch(/canApprove\s*=[^;]*[Gg]aps/);
    }
  });
});
