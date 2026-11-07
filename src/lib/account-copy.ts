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
    "A separate grant from upload access. An admin reviews each request against export-control and local-jurisdiction rules and the purpose you state, and a grant lets you use compute within the limits an administrator sets.",
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
  // Compute, administrator side (website#497, epic #2021): the admin Compute tab.
  // Exact words for an administrator; the person-facing `compute_access.state.*`
  // keys above soften denied and revoked and are not reused here. Refusal
  // sentences are NOT keys: they come from the response `error`. The tab offers
  // no owner-only or cost-bearing action; the lede says where those live.
  // -------------------------------------------------------------------------
  "compute_admin.page.title": "Compute",
  "compute_admin.page.lede":
    "Compute access requests, and a read-only view of pools, usage, flagged jobs and reconciliation. A grant opens an allocation the person can spend, so each request is decided by a person, one at a time.",
  "compute_admin.page.cli_note":
    "Owner policy, legal holds, record reads, moving a charge, pool grants and adjustments, and cancelling a job are done with `nemar admin compute` in the command line, not here.",
  "compute_admin.page.order_note":
    "Accounts are listed in the order they were created, not the order they asked in.",
  "compute_admin.view.nav": "Compute views",
  "compute_admin.view.requests": "Requests",
  "compute_admin.view.pools": "Pools",
  "compute_admin.view.usage": "Usage",
  "compute_admin.view.flagged": "Flagged jobs",
  "compute_admin.view.drift": "Reconciliation",
  "compute_admin.state.nav": "Filter requests by state",
  "compute_admin.state.requested": "Requested",
  "compute_admin.state.active": "Active",
  "compute_admin.state.suspended": "Suspended",
  "compute_admin.state.denied": "Denied",
  "compute_admin.state.revoked": "Revoked",
  "compute_admin.state.all": "All",
  "compute_admin.requests.none": "No accounts in this view.",
  "compute_admin.pager.next": "Next page",
  "compute_admin.pager.first": "First page",
  "compute_admin.row.not_set": "not set",
  "compute_admin.row.no_username": "no username",
  "compute_admin.row.account_kind": "{kind} account",
  "compute_admin.row.stated_country": "Stated country",
  "compute_admin.row.stated_country_hint":
    "Check this against the export-control rules before granting. This page does not rule on it.",
  "compute_admin.row.city": "City",
  "compute_admin.row.affiliation": "Affiliation",
  "compute_admin.row.email": "Email",
  "compute_admin.row.orcid": "ORCID iD",
  "compute_admin.row.requested": "Requested",
  "compute_admin.row.terms": "Terms accepted",
  "compute_admin.row.terms_value": "{version}, {date}",
  "compute_admin.row.purpose": "Stated purpose",
  "compute_admin.row.show_full_purpose": "Show full purpose",
  "compute_admin.row.granted": "Granted {date} by account #{id}",
  "compute_admin.row.not_notified": "No administrator has been emailed about this request yet.",
  "compute_admin.row.open_in_users": "Open in Users",
  "compute_admin.action.grant": "Grant",
  "compute_admin.action.grant_again": "Grant again",
  "compute_admin.action.lift_suspension": "Lift suspension",
  "compute_admin.action.deny": "Deny",
  "compute_admin.action.suspend": "Suspend",
  "compute_admin.action.revoke": "Revoke",
  "compute_admin.self_grant.disabled":
    "You cannot grant your own compute access. Ask another administrator or an owner.",
  "compute_admin.dialog.title.grant": "Grant compute access?",
  "compute_admin.dialog.title.deny": "Deny this request?",
  "compute_admin.dialog.title.suspend": "Suspend compute access?",
  "compute_admin.dialog.title.revoke": "Revoke compute access?",
  "compute_admin.dialog.consequence.grant":
    "Opens the owner’s default allocation once for this account (a repeat grant adds nothing), unfreezes the account’s pools, and lets the person run jobs. The person is emailed.",
  "compute_admin.dialog.consequence.deny":
    "Closes this request. The person is emailed and cannot ask again; only an administrator can grant later.",
  "compute_admin.dialog.consequence.suspend":
    "Freezes the account’s pools, cancels its live jobs and ends its compute sign-ins. A grant lifts the suspension. The person is emailed.",
  "compute_admin.dialog.consequence.revoke":
    "Freezes the account’s pools, cancels its live jobs and ends its compute sign-ins. Only a new grant restores access. The person is emailed.",
  "compute_admin.dialog.reason_label": "Reason (optional)",
  "compute_admin.dialog.reason_hint": "Recorded in the audit log. The person is not sent it.",
  "compute_admin.dialog.reason_count": "{count} of {max}",
  "compute_admin.dialog.ack_export_review":
    "I reviewed this person’s name, affiliation and stated country against the export-control rules",
  "compute_admin.dialog.type_word": "Type {word} to confirm",
  "compute_admin.dialog.cancel": "Cancel",
  "compute_admin.result.working": "Working",
  "compute_admin.result.granted": "Granted.",
  "compute_admin.result.granted_opened": "Granted. Opened {cpu} CPU SU and {gpu} GPU SU.",
  "compute_admin.result.granted_zero_default":
    "Granted. The owner’s default allocation is zero, so nothing was opened.",
  "compute_admin.result.granted_already":
    "Granted. An earlier grant already opened the default allocation, so nothing more was opened.",
  "compute_admin.result.granted_other": "Granted. The allocation answered: {reason}.",
  "compute_admin.result.denied": "Denied.",
  "compute_admin.result.suspended":
    "Suspended. The account’s pools are frozen and its live jobs are being cancelled.",
  "compute_admin.result.revoked":
    "Revoked. The account’s pools are frozen and its live jobs are being cancelled.",
  "compute_admin.result.email_not_sent":
    "The decision stands, but the person could not be emailed. Tell them.",
  "compute_admin.result.state_changed":
    "Someone else may have decided this first. The row shows the current state.",
  "compute_admin.result.unconfirmed":
    "The result is not confirmed. The row shows what the server says now.",
  "compute_admin.result.stale": "This account was not found. Reload the page.",
  "compute_admin.result.reread_failed":
    "The current state could not be read. Reload the page before deciding again.",
  "compute_admin.result.signed_out": "You are signed out. Sign in again, then retry.",
  "compute_admin.section.failed": "Could not load {what}: {reason}",
  "compute_admin.col.holder": "Holder",
  "compute_admin.col.pool": "Pool",
  "compute_admin.col.granted": "Granted (SU)",
  "compute_admin.col.held": "Held (SU)",
  "compute_admin.col.charged": "Charged (SU)",
  "compute_admin.col.available": "Available (SU)",
  "compute_admin.col.frozen": "Frozen",
  "compute_admin.col.updated": "Updated",
  "compute_admin.col.partition": "Partition",
  "compute_admin.col.source": "Front door",
  "compute_admin.col.users": "Distinct people",
  "compute_admin.col.jobs": "Jobs",
  "compute_admin.col.job": "Job",
  "compute_admin.col.account": "Account",
  "compute_admin.col.state": "State",
  "compute_admin.col.flags": "Flags",
  "compute_admin.col.failure": "Failure",
  "compute_admin.col.created": "Created",
  "compute_admin.col.ended": "Ended",
  "compute_admin.col.slurm": "Scheduler job",
  "compute_admin.col.elapsed": "Elapsed (s)",
  "compute_admin.col.resources": "Nodes, CPUs, GPUs",
  "compute_admin.col.ingested": "Ingested",
  "compute_admin.ref.account": "account #{id}",
  "compute_admin.ref.no_account": "no account",
  "compute_admin.pools.platform": "Platform budgets",
  "compute_admin.pools.partner": "Partner pools",
  "compute_admin.pools.account": "Account pools",
  "compute_admin.pools.none_platform": "No platform budgets are recorded.",
  "compute_admin.pools.none": "No pools are recorded in this group.",
  "compute_admin.pools.frozen": "Frozen",
  "compute_admin.pools.open": "Open",
  "compute_admin.usage.quarter": "Quarter",
  "compute_admin.usage.counts_note":
    "These are counts of people and jobs, not service units. A person is counted once however many jobs they ran, and jobs that skipped the reservation or could not be attributed are left out.",
  "compute_admin.usage.totals": "Total",
  "compute_admin.usage.none": "No jobs were recorded in this quarter.",
  "compute_admin.flag.nav": "Filter jobs by flag",
  "compute_admin.flag.unreserved": "Unreserved",
  "compute_admin.flag.unattributed": "Unattributed",
  "compute_admin.flag.mismatch": "Mismatch",
  "compute_admin.flag.overrun": "Overrun",
  "compute_admin.flag.meaning.unreserved":
    "The job skipped the reservation. Its charge went to a partner pool and not to a person.",
  "compute_admin.flag.meaning.unattributed":
    "The job skipped the reservation and its owner maps to no active account.",
  "compute_admin.flag.meaning.mismatch":
    "NEMAR’s record and the scheduler’s accounting disagree for this job.",
  "compute_admin.flag.meaning.overrun":
    "The job used more than its hold, and the excess is recorded as an overrun in the ledger.",
  "compute_admin.flag.followup":
    "Moving the charge of an unreserved job to a person is an owner action in the command line.",
  "compute_admin.flagged.none": "No jobs carry this flag. That is a fact about this read only.",
  "compute_admin.flagged.platform_failure": "NEMAR’s fault",
  "compute_admin.flagged.partner": "Partner: {state}, {flag}",
  "compute_admin.drift.paused":
    "Reconciliation is paused while compute is off. An empty list below does not mean nothing is unmatched.",
  "compute_admin.drift.status": "Status",
  "compute_admin.drift.compute_on": "Compute is on.",
  "compute_admin.drift.compute_off": "Compute is off.",
  "compute_admin.drift.tapis": "Scheduler gateway: token {token}, health {health}.",
  "compute_admin.drift.attention": "Needs a person to look",
  "compute_admin.drift.attention_none": "No attention count is positive.",
  "compute_admin.drift.unmatched": "Accounting rows no job claims",
  "compute_admin.drift.unmatched_shown": "Showing the newest {shown} of {total}.",
  "compute_admin.drift.unmatched_none": "No accounting rows are waiting for a job.",
  "compute_admin.drift.not_priced": "not priced",
  "compute_admin.drift.mismatch": "Jobs flagged mismatch",
  "compute_admin.drift.mismatch_more": "See the Flagged jobs view for the rest",
  "compute_admin.unavailable.title": "Not available yet",
  "compute_admin.unavailable.usage_by_day":
    "Service units charged by day, partition and front door across the platform are not served by any admin read yet.",
  "compute_admin.unavailable.drift_difference":
    "The difference between NEMAR’s ledger and the supercomputer’s accounting, per job or per day, and the tolerance it is measured against are not served by any admin read yet. No row is marked over tolerance because this page has no tolerance to apply.",
  "compute_admin.unavailable.link": "Tracking issue",
  "compute_admin.badge.awaiting_decision": "awaiting decision",

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
