# Handoff — nemar.org website

**Last session:** 2026-08-02 (second session that day: production promotion).

## Promotion session addendum (2026-08-02, later)

Everything below shipped to **production** the same day:

- nemar-cli `dev` → `main` promoted (v0.9.7, separate session). Deploy Backend green;
  migration 0066 (`auth_codes.user_id`) verified present on prod D1 via read-only
  `pragma_table_info`. The deploy log said "No migrations to apply" because the
  promotion prep had already applied it.
- Website `staging` → `main` promoted as **v0.2.3** via release PR #228. Key discovery:
  the documented `git push origin origin/staging:main` is REJECTED by the `keep-main`
  ruleset even with all four checks green on the commit (checks evaluate as "expected"
  on a bare push). Promotion is a `staging` → `main` PR with a regular merge commit —
  v0.2.2 (PR #225) went the same way. AGENTS.md/CLAUDE.md now say so.
- Verified live on production (app.nemar.org, 0.2.3+298df492):
  - `POST /auth/orcid/start?mode=relink` with correct Origin, no session → 302
    `/login?error=session_required`; forged Origin → 403.
  - GET with `mode=relink` mints a state cookie whose decoded `mode` is `"login"`
    (ADR 0022 coercion live).
  - `/login?error=session_required` and `?error=orcid_relink_session` render their copy.
  - New API routes live on api.nemar.org (403/400 refusals, not 404).
- `release.yml` worked end-to-end: tag v0.2.3, GitHub Release, back-merge, staging now
  0.2.4-dev0.

Remaining (needs a human): **ORCID relink end-to-end on production Settings with a real
ORCID iD** — the only path no curl can walk. Then website#226.

## TL;DR — where we are right now

`staging` leads `main` (inverted 2026-07-29; see AGENTS.md "Branch ↔ environment map").
The apex cutover is DONE — nemar.org is the Astro site; the old handoff's cutover
section is history, AGENTS.md carries the current host model.

**This session shipped the entire settings self-service backend stack** (nemar-cli
epic #1019, closed) plus the website-side relink hardening, all reviewed by parallel
subagent panels with every finding addressed:

- **nemar-cli #912 → PR #1050 (merged to dev):** `PATCH /auth/profile` — GitHub
  handle checks mirroring CLI signup (dedup 409 / live existence / canonical
  casing), city/country non-empty (export control), `profile_updated` audit row.
  The Settings "Save profile" button now works on test.nemar.org with no frontend
  change.
- **nemar-cli #913 → PR #1051 (merged to dev) + ADR 0022:** ORCID re-link. The
  security-critical part: `mode=relink` is minted ONLY by an authenticated,
  Origin-checked `POST /auth/orcid/start`; a GET coerces to login (a forged link
  degrades to the old `orcid_already_have` refusal). Route-level no-mock tests in
  `backend/test/orcid-relink-route.test.ts` pin conflict-beats-relink ordering.
- **nemar-cli #911 → PR #1053 (merged to dev) + migration 0066:** email change.
  Codes are BOUND to the requesting session (`auth_codes.user_id`) — a second
  signed-in user reading a shared inbox cannot claim the address. Sign-in verify
  filters `user_id IS NULL`, change verify filters `user_id = session user`.
  Rate-limited in the auth-ip bucket + a per-account 5/hour cap across targets;
  off-prod sends restricted to synthetic targets (no admin bypass).
- **website PR #227 (merged to staging):** the Settings relink confirm submits a
  real form POST (companion to ADR 0022 — the proxy forwards the browser's verb
  and Origin; NEVER pin Origin there, that would launder cross-site posts).
  Settings finally renders `?error=` ORCID codes; both error maps use
  `Object.hasOwn` (a `?error=constructor` URL used to render `[object Object]`).

**Housekeeping:** stale nemar-cli#910 closed (its backend shipped to prod 2026-07-24).
Issues #911/#912/#913/#1019 closed with dispositions — remember PRs merged to `dev`
never auto-close issues (default branch is `main`); close them by hand.

## Verified on live staging (2026-08-02)

- `curl -s https://test.nemar.org/version.json` → 0.2.3-dev1 (post-#227 build).
- `POST test.nemar.org/auth/orcid/start?mode=relink` without a session → 302
  `/login?error=session_required` (full chain: Astro proxy → verb+Origin forward →
  backend POST gate).
- `?error=constructor` on /login → generic copy (prototype-key guard live).
- E2E suites green against the dev worker: profile block 8/8, email change 4/4
  (incl. cross-user redemption refusal), relink route tests 7/7 local.

## Immediate pick-ups

- ~~Promote nemar-cli `dev` → `main`.~~ DONE (v0.9.7 + website v0.2.3, see addendum).
  Still open from it: **verify ORCID relink on production Settings with a real ORCID
  iD** — staging structurally cannot complete ORCID OAuth (test.nemar.org callback
  not registered with ORCID; epic #923 known limitation), and curl cannot walk the
  OAuth consent step.
- **website#226 — profile-completeness push** (filed this session, decisions
  locked: dismissible dashboard nudge + hard city/country gate at /upload; GitHub
  required only at publish, matching #129). Frontend-only; backend dependency
  (#912) is on dev now.
- **Browser QA of signed-in Settings on test.nemar.org** was cut short (Chrome
  extension disconnected; Playwright download was mid-flight at session end). The
  API + HTTP layers are verified; a human click-through of profile save + email
  change UI on test.nemar.org would close the loop. Fixture `pl-webqa@nemar.test`
  (approved, ORCID-linked profile) is seeded for exactly this.
- Follow-ups filed: nemar-cli#1052 (validateGitHubUsername: retry transport +
  distinguish GitHub outage from 404), nemar-cli#1054 (notify the OLD address on
  email change — the only tamper signal in a passwordless architecture).

## Gotchas learned this session (these cost real time)

- **Never park a real GitHub handle on a persistent dev-DB fixture row.** The
  profile E2E stored `octocat` on the fixed fixture user; `test/api.test.ts`
  asserts `/auth/check-github?username=octocat` → `registered: false`, so
  api-test + integration-dev went red on BOTH open PRs. Tests now use `mojombo`
  and clear the handle in teardown.
- **PRs to `dev` don't auto-close nemar-cli issues** (default branch is `main`) —
  that's how #910 sat open for a week after shipping.
- **The state cookie for ORCID OAuth is unsigned base64url JSON.** Safe today only
  because no privileged mode can be minted without an authenticated POST
  (ADR 0022). If a future mode carries privilege, sign the state (`signPending`
  pattern) — don't extend the precedent.
- **`auth_codes` is shared by two flows with disjoint invariants** (sign-in:
  address MUST have a users row; email-change: address MUST NOT). The `user_id`
  column (0066) makes the separation structural; keep both verify filters if the
  table grows a third purpose.
- **cfman injects the account id** — `bunx cfman wrangler --account sccn -- ...`
  works without CLOUDFLARE_ACCOUNT_ID in env (shell-sourcing test/.env.test can
  mangle values; use the test suite's own parser via a bun script instead).
- **A fresh Worker deploy can 404 new routes for ~1 minute** (propagation). Probe
  the route before concluding the code is wrong.

## Standing gotchas (still true)

- `staging` leads; feature PRs target `staging`; promotion is a `staging` → `main`
  **release PR with a regular merge commit** after Prepare release (a direct push is
  rejected by the ruleset even with green checks — see AGENTS.md). `keep-main`
  requires green lint/typecheck/test/build.
- test.nemar.org runs single-host mode — cross-host redirects, signed-in redirect
  suppression, canonical origins are all inert there (website#212).
- Staging D1 (`nemar-db-dev`) holds ~600 real user emails + a live RESEND key.
  The #1008 allowlist and the email-change synthetic-target gate exist for that
  reason; don't weaken them for QA convenience.
- Session cookie is `Domain=app.nemar.org`; browser-side authenticated calls go
  through same-origin proxies. OG cards under `public/og/` are generated.
- `imageService: "passthrough"` stays; no npm/npx/pnpm — bun/bunx only.

## Epic backlog

- **Settings self-service — DONE, live on prod** (v0.9.7 backend + v0.2.3 website).
- **Profile completeness — website#226** (nudge + upload gate), then the
  service-access grant queue once nemar-cli#1023 lands.
- **Contribute / upload — website#164** (#161 in-browser BIDS validation).
- **Legacy onboarding gate — website#129 + nemar-cli#833** (parked).
- Standalone: website#173 (AbortSignal audit), nemar-cli#1010 (flaky
  integration-dev), nemar-cli#1052, nemar-cli#1054.
