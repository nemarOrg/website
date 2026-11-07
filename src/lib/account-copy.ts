/**
 * Every user-facing sentence about account tiers, upload access, and missing
 * profile fields — in one place, so the website and the CLI can say the same
 * thing (website#309, nemar-cli#1268 / epic #1250 phase 8).
 *
 * **Source of truth: nemar-cli `shared/contract`.** Phase 8 creates
 * `shared/contract/account-copy.ts` there with the SAME KEYS and the same
 * strings; the CLI reads it directly and this file is its copy, the same
 * arrangement `publication-block.ts` already has with
 * `publicationBlockReasonSchema`. The two repos share no package, so the
 * values are transcribed rather than imported, and
 * `test/account-copy-drift.test.ts` compares the two files whenever a
 * nemar-cli checkout sits beside this one (it skips, with a note, when none
 * does). Changing a sentence here means changing it there in the same breath.
 *
 * **Three rules this file has to keep, because the drift test and the
 * mirroring depend on them:**
 *
 * 1. *Every value is a literal string.* No template literals, no
 *    concatenation, no interpolation from a constant — the drift test reads
 *    the nemar-cli file as TEXT (it cannot import a module from outside this
 *    repo's dependency graph), so a computed value there would be invisible
 *    to it. Where a sentence embeds a number that lives somewhere else
 *    ({@link ACCOUNT_COPY}`["upload_access.request.why_hint"]` and the
 *    20-500 char bounds), the literal is written out and
 *    `account-copy.test.ts` asserts it still agrees with the constant.
 * 2. *Placeholders are `{name}`, filled by {@link fillCopy}.* A sentence with
 *    a moving part is a template, not a function, so it stays comparable as
 *    a string.
 * 3. *Keys are stable and dotted.* They are the mirroring contract; renaming
 *    one is a change on both sides.
 * 4. *Every key here has a consumer.* The mirroring is not symmetric: the
 *    nemar-cli contract legitimately carries keys this repo has no surface
 *    for (sandbox training, `nemar auth status` headings), and the drift test
 *    reports those as a note. A key on THIS side with nothing reading it is a
 *    different thing — copy that cannot be seen, kept in step with another
 *    repo for nothing — so `account-copy.test.ts` fails on one.
 *
 * What is deliberately NOT here:
 *
 * - **Refusal fallbacks.** `uploadAccessErrorMessage` / `profileErrorMessage`
 *   in `./account-tier.ts` render a REFUSED request, and prefer the backend's
 *   own `message` wherever it sent one. They mirror the backend's sentences
 *   rather than this file's, and importing them here would make the two
 *   modules circular for nothing.
 * - **Anchors and hrefs.** `./profile-gaps.ts` owns those: they are website
 *   routing, and the CLI has nothing to mirror them with.
 * - **Admin status vocabulary** (`UserStatusBadge.astro`,
 *   `ADMIN_TIER_LABELS`). Those name lifecycle rows for an operator, not the
 *   account model for its owner, and no CLI surface prints them.
 */

/**
 * The copy table. Read it through {@link accountCopy} (or index it directly —
 * the keys are typed).
 */
export const ACCOUNT_COPY = {
  // -------------------------------------------------------------------------
  // Tiers (nemar-cli ADR 0040: unverified -> base -> upload)
  // -------------------------------------------------------------------------
  "tier.unverified.label": "Email not verified",
  "tier.base.label": "Base access",
  "tier.upload.label": "Upload access",
  "tier.unverified.lede": "Verify your email address to activate your account.",
  // No `tier.base.lede` / `tier.upload.lede`: nothing renders a one-line
  // description of those two tiers. The base tier's explanation is
  // `upload_access.invite.body` on the card that offers the next step, and
  // the upload tier's is `upload_access.granted.body`. Adding a second
  // sentence for each would mean two keys to keep in step for one fact. See
  // the every-key-has-a-consumer rule in the header.

  // -------------------------------------------------------------------------
  // Upload access (nemar-cli ADR 0042: one request, one admin answer)
  // -------------------------------------------------------------------------
  "upload_access.section.title": "Upload access",
  "upload_access.section.lede":
    "A one-time admin grant. Reviewed against export-control and local-jurisdiction rules.",
  "upload_access.state.granted": "Granted",
  "upload_access.state.requested": "Requested",
  "upload_access.state.not_requested": "Not requested",
  "upload_access.invite.title": "Want to contribute a dataset?",
  "upload_access.invite.body":
    "Browsing, searching and downloading are open to your account already. Uploading, or being added as a collaborator on someone else’s dataset, needs one extra grant: an admin checks your GitHub handle and location against export-control and local-jurisdiction rules, once. Your email address must be verified first.",
  "upload_access.gate.title": "Ask for upload access first",
  "upload_access.gate.body":
    "Your account can browse, search and download everything public already. Uploading, or being added as a collaborator on someone else’s dataset, needs one extra grant, and your email address must be verified first: an admin checks your GitHub handle and where you’re based against export-control and local-jurisdiction rules. You ask once, and it is answered by email.",
  "upload_access.request.cta": "Request upload access",
  "upload_access.request.form_body":
    "Tell us what you plan to deposit, or which dataset you want to collaborate on. An admin reviews this alongside your name, username, GitHub handle and location, then grants access once.",
  "upload_access.request.why_label": "What do you intend to upload?",
  // The bounds are `WHY_MIN_CHARS` / `WHY_MAX_CHARS` in `./account-tier.ts`
  // (and `UPLOAD_ACCESS_WHY_*_CHARS` in nemar-cli shared/contract). Written
  // out rather than interpolated per rule 1 above; `account-copy.test.ts`
  // fails if the numbers here stop matching the constants.
  "upload_access.request.why_hint": "Describe what you intend to upload in 20-500 characters",
  "upload_access.requested.title": "Your request is with an admin",
  "upload_access.requested.lede": "An admin is reviewing your request.",
  "upload_access.requested.lede_dated": "An admin is reviewing your request from {date}.",
  "upload_access.requested.body.upload":
    "We’ll email you when there’s a decision, and this page will let you upload as soon as it’s granted.",
  "upload_access.requested.body":
    "We’ll email you when there’s a decision. Everything else on your account keeps working in the meantime.",
  "upload_access.requested.cta": "See the request",
  "upload_access.granted.body":
    "You can upload datasets from the upload page. Publishing one is a separate, per-dataset review you start from your dashboard.",
  "upload_access.unverified.body":
    "Verify your email address first — the review happens over email.",
  "upload_access.docs_link": "How upload access works",

  // -------------------------------------------------------------------------
  // Compute access (nemar-cli ADR 0118, the compute-access addendum, epic
  // #2021 phase D1; transcribed from nemar-cli 3a869903): its OWN grant, never
  // upload access. One request, one admin answer; the states are `none`,
  // `requested`, `active`, `suspended`, `denied` and `revoked`
  // (`src/lib/compute-access-state.ts`). `cli.compute_access.cta` is the
  // CLI's own and is not transcribed.
  // -------------------------------------------------------------------------
  "compute_access.section.title": "Compute access",
  "compute_access.section.lede":
    "A separate grant from upload access. An admin reviews each request against export-control and local-jurisdiction rules and the purpose you state, and a grant opens a starting allocation of service units.",
  "compute_access.state.none": "Not requested",
  "compute_access.state.requested": "Requested",
  "compute_access.state.active": "Active",
  "compute_access.state.suspended": "Suspended",
  "compute_access.state.denied": "Not granted",
  "compute_access.state.revoked": "Ended",
  "compute_access.request.cta": "Request compute access",
  "compute_access.request.form_body":
    "Tell us what you plan to compute. An admin reviews this alongside your name, affiliation and location, then answers once. You also accept the compute terms.",
  "compute_access.request.purpose_label": "What do you intend to compute?",
  // The bounds are `COMPUTE_PURPOSE_MIN_CHARS` / `COMPUTE_PURPOSE_MAX_CHARS` in
  // ./account-tier.ts; written out per rule 1 in the header, and
  // `account-copy.test.ts` fails if the numbers here stop matching them.
  "compute_access.request.purpose_hint":
    "Describe what you intend to compute in 20-1000 characters",
  "compute_access.request.terms_label": "I accept the compute terms",
  "compute_access.requested.title": "Your compute request is with an admin",
  "compute_access.requested.lede": "An admin is reviewing your request.",
  "compute_access.requested.lede_dated": "An admin is reviewing your request from {date}.",
  "compute_access.requested.body":
    "We’ll email you when there’s a decision. Everything else on your account keeps working in the meantime.",
  "compute_access.granted.body":
    "Compute access is active. Your balances are on your compute page, and you submit jobs with the `nemar compute` command line.",
  "compute_access.granted.link": "Open your compute page",
  "compute_access.closed.body":
    "This request has been answered and cannot be asked again. If you think that is a mistake, contact support and an admin will take another look.",
  // A suspended account is not a request that was answered: its access exists and is paused.
  "compute_access.suspended.body":
    "Your compute access is paused. Contact support to find out why or to ask for it to be lifted.",
  "compute_access.terms_unpublished.body":
    "Compute access is not open yet: the compute terms are not published. Please check back later.",
  "compute_access.docs_link": "How compute access works",

  // -------------------------------------------------------------------------
  // The compute page (`/compute`, website ADR 0030 phase E2, nemar-cli epic
  // #2021 phase E2). The first two are also printed by `nemar compute
  // balance`, so the two surfaces say one thing. Transcribed from nemar-cli
  // `shared/contract/account-copy.ts`.
  // -------------------------------------------------------------------------
  "compute_page.frozen.body":
    "Your pools are frozen, so new jobs are refused. Contact support to find out why.",
  "compute_page.units_note": "Amounts are service units (SU).",
  "compute_page.available_note":
    "Available is granted minus held minus charged and can be negative after an overrun.",
  "compute_page.queue_note":
    "It describes the queue of the whole platform, not yours, and it is a recent average, not a promise.",
  "compute_page.usage_note":
    "Net charge by UTC day of the charge, not the day a job was created. A day with no charge has no bar.",
  "compute_page.unreported_note":
    "NEMAR has not heard from the cluster about this job for a while. It may still finish.",

  // -------------------------------------------------------------------------
  // Profile gaps: the sentence, its two halves, and the vocabulary they use
  //
  // `gap.sentence` + " " + one of the `gap.set_on.*` templates is what
  // `describeGap` composes, and it is the sentence BOTH surfaces print:
  //
  //   GitHub handle is missing: needed to request upload access.
  //   Set it in Settings or run `nemar auth profile set-github`.
  // -------------------------------------------------------------------------
  "gap.sentence": "{label} is missing: needed {blocks}.",
  "gap.set_on.both": "Set it in {web} or run `{cli}`.",
  "gap.set_on.web": "Set it in {web}.",
  // There is no command-only template. Every field in the table has a web
  // location — the CLI half is what a field can lack (a name owned by a
  // verified ORCID record) — so a `Run {cli}.` sentence would be one no gap
  // could reach.
  "gap.blocks.verified": "to activate your account",
  "gap.blocks.upload_access": "to request upload access",
  "gap.blocks.compute_access": "to request compute access",
  "gap.blocks.publication": "to publish a dataset",
  // For a field this build has never heard of (the backend's `profile_gaps`
  // grew one), or one that names no block at all. Saying nothing about what
  // it stops is better than guessing.
  "gap.blocks.unknown": "to finish setting up your account",
  // Noun forms, for a surface that REPORTS what a field blocks rather than
  // instructing the person who has to fix it — the admin review card lists
  // "upload access and publication", not "to request upload access".
  "gap.blocks.noun.verified": "account activation",
  "gap.blocks.noun.upload_access": "upload access",
  "gap.blocks.noun.compute_access": "compute access",
  "gap.blocks.noun.publication": "publication",
  // Where a field this build does not recognise is set. Settings is the only
  // honest answer: it is the page that holds the account form.
  "gap.set_on.default_web": "Settings",

  // Field labels. These are the same labels a refused upload-access request
  // renders from its `missing` array, which is why `why` and `email_verified`
  // are here alongside the profile columns.
  "gap.field.email_verified.label": "A verified email address",
  "gap.field.username.label": "Username",
  "gap.field.given_name.label": "Given name",
  "gap.field.family_name.label": "Family name",
  "gap.field.orcid_verified.label": "Verified ORCID iD",
  "gap.field.github_username.label": "GitHub handle",
  "gap.field.city.label": "City",
  "gap.field.country.label": "Country",
  "gap.field.affiliation.label": "Affiliation",
  "gap.field.why.label": "A description of what you intend to upload",

  // Where each one is set. `.web` is prose that fits "Set it in ___"; `.cli`
  // is the exact command, printed inside backticks by the templates above.
  "gap.field.email_verified.set_on.web": "the verify step on your dashboard",
  "gap.field.email_verified.set_on.cli": "nemar auth resend-verification",
  "gap.field.username.set_on.web": "Settings",
  "gap.field.username.set_on.cli": "nemar auth profile set-username",
  "gap.field.given_name.set_on.web": "Settings",
  "gap.field.given_name.set_on.cli": "nemar auth profile set-name",
  "gap.field.family_name.set_on.web": "Settings",
  "gap.field.family_name.set_on.cli": "nemar auth profile set-name",
  // A verified ORCID iD owns the name: it is re-read on every sign-in and
  // `PATCH /auth/profile` refuses the edit (`name_is_orcid_canonical`), so
  // pointing this account at Settings would point it at a control it does
  // not get. No CLI command either — `profile set-name` is refused for the
  // same reason.
  "gap.field.given_name.set_on.web.orcid": "your ORCID record at orcid.org, then sign in again",
  "gap.field.family_name.set_on.web.orcid": "your ORCID record at orcid.org, then sign in again",
  "gap.field.orcid_verified.set_on.web": "Settings",
  "gap.field.orcid_verified.set_on.cli": "nemar auth profile orcid link",
  "gap.field.github_username.set_on.web": "Settings",
  "gap.field.github_username.set_on.cli": "nemar auth profile set-github",
  "gap.field.city.set_on.web": "Settings",
  "gap.field.city.set_on.cli": "nemar auth profile set-location",
  "gap.field.country.set_on.web": "Settings",
  "gap.field.country.set_on.cli": "nemar auth profile set-location",
  "gap.field.affiliation.set_on.web": "Settings",
  "gap.field.affiliation.set_on.cli": "nemar auth profile set-affiliation",
  "gap.field.why.set_on.web": "the request form in Settings",
  "gap.field.why.set_on.cli": "nemar auth request-upload-access",

  // The headings each surface puts the gap list under.
  "gaps.title": "What is still missing",
  "gaps.none": "Nothing outstanding — every field NEMAR needs is filled in.",
  "gaps.nudge.title": "Your profile isn’t finished yet",
  "gaps.nudge.cta": "Complete your profile",
  "gaps.upload.title": "Before you can ask, your account still needs:",
  "gaps.request.title": "Finish these first:",
  "gaps.admin.title": "Still missing",
  // The admin card reports rather than instructs: an admin cannot set another
  // person's city, so "Set it in Settings" would be advice for the wrong
  // reader. It names the field and what it blocks, and nothing else.
  "gaps.admin.item": "{label} — blocks {blocks}",
  "gaps.admin.none": "Nothing missing — every field the request needs is filled in.",
  "gaps.admin.not_loaded": "Not loaded — open the user page to see what is still missing.",

  // -------------------------------------------------------------------------
  // Onboarding
  // -------------------------------------------------------------------------
  "onboarding.username.auto_assigned.title": "We chose your username from your name",
  "onboarding.username.auto_assigned.body":
    "Your account needed a username to be listed as a dataset owner, so one was made from your name when you signed in. You can change it once, here, until an admin grants you upload access.",

  // -------------------------------------------------------------------------
  // Welcome (the two steps that are about the account model itself)
  // -------------------------------------------------------------------------
  "welcome.unverified.title": "Verify your email address",
  "welcome.unverified.body":
    "Authorizing with ORCID created your NEMAR account and signed you in. One step left: enter the 6-digit code we emailed you. That activates the account — no admin approval is involved.",
  "welcome.active.title": "Your account is active",
  "welcome.active.body":
    "Authorizing with ORCID created your NEMAR account and signed you in. There is no separate sign-up step and no approval queue: browse, search, and your dashboard all work right now.",
  "welcome.upload_access.title": "Ask for upload access when you’re ready to contribute",
  "welcome.upload_access.body":
    "Reading is open to every verified account. Uploading and compute need one extra grant, because an admin has to check your GitHub handle and location against export-control and local-jurisdiction rules first. You ask once, from Settings.",

  // -------------------------------------------------------------------------
  // Signing in to another site with a NEMAR account (nemar-cli ADR 0119): the
  // page at /oauth/authorize (`src/lib/oidc-authorize.ts`). `{client}` is the
  // client's registered name.
  // -------------------------------------------------------------------------
  "oidc.consent.title": "{client} wants to use your NEMAR account",
  "oidc.consent.acts_as_you":
    "If you allow it, {client} can act as you on NEMAR in the ways listed below.",
  "oidc.consent.compute_spend":
    "If you sign in and run compute with this app, it counts against your NEMAR compute allocation.",
  "oidc.consent.scopes_title": "It is asking to:",
  // One line per scope a person can grant, keyed by the scope's name.
  "oidc.consent.scope.openid": "Know which NEMAR account is yours",
  "oidc.consent.scope.profile": "See your name",
  "oidc.consent.scope.email": "See your email address",
  "oidc.consent.scope.orcid":
    "See your ORCID iD, and whether you proved it by signing in with ORCID",
  "oidc.consent.scope.nemar.account": "See your account type, status and access level",
  "oidc.consent.scope.offline_access": "Keep this access when you are not using it",
  "oidc.consent.scope.compute.read": "See your compute access, balances, usage and jobs",
  "oidc.consent.scope.compute.reserve":
    "Reserve compute time, report jobs and release reservations for you",
  "oidc.consent.scope.compute.submit": "Submit compute jobs that NEMAR runs for you",
  "oidc.consent.redirect_host": "Either answer sends you to {redirect_host}.",
  "oidc.consent.allow": "Allow",
  "oidc.consent.deny": "Deny",
  "oidc.rule.title": "You can’t sign in to {client} with this account",
  "oidc.rule.account_inactive": "Your NEMAR account is not active.",
  "oidc.rule.account_not_person":
    "{client} is only for personal accounts, and this account is not one.",
  "oidc.rule.orcid_not_proven":
    "{client} needs an ORCID iD you proved by signing in to NEMAR with ORCID. Link your ORCID iD in Settings, then try again.",
  "oidc.rule.return": "Return to {client}",
  "oidc.error.title": "This sign-in can’t continue",
  "oidc.error.invalid_client": "The site that sent you here is not one NEMAR signs people in to.",
  "oidc.error.invalid_redirect_uri":
    "The site that sent you here asked NEMAR to send you to an address it has not registered, so NEMAR will not send you there.",
  "oidc.error.invalid_request":
    "The sign-in request is incomplete or malformed. Go back to the site you came from and start again.",
  "oidc.error.consent_invalid":
    "This page has expired. Go back to the site you came from and start again.",
  "oidc.error.unavailable":
    "NEMAR could not complete this sign-in right now. Try again in a moment.",
  "oidc.error.rate_limited": "Too many sign-in attempts. Try again in a minute.",
} as const;

export type AccountCopyKey = keyof typeof ACCOUNT_COPY;

/** Typed read. Exists so a caller cannot mistype a key and get `undefined`
 *  rendered into a page — the union is the whole point. */
export function accountCopy(key: AccountCopyKey): string {
  return ACCOUNT_COPY[key];
}

/**
 * Fill a `{name}` template from {@link ACCOUNT_COPY}.
 *
 * A placeholder with no value is left as-is rather than replaced with an
 * empty string: "Set it in {web}." is visibly wrong and gets fixed, while
 * "Set it in ." reads like a rendering glitch nobody can attribute.
 */
export function fillCopy(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name] : whole,
  );
}
