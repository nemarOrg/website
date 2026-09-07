# Handoff — nemar.org website

**Last session:** 2026-09-07.

## 2026-09-07 — CLI device-authorize page + Settings keys card (epic #1272 phase 2)

Implemented on `feature/issue-316-cli-authorize` (worktree `website-cli-authorize`),
tracking nemarOrg/website#316 and nemar-cli #1282,
against the epic branch's phase-1 backend (nemar-cli ADR 0047, PR #1287).
Pushed as nemarOrg/website#317.
Not yet merged to `staging` — the lead reviews and merges this PR.

- **`/cli/authorize`** — the page a person lands on to authorize `nemar auth login` on a new machine.
  Server-rendered, no client script:
  a `method="get"` form for a code typed by hand,
  a `method="post"` form with `Authorize`/`Deny` buttons once a live code resolves,
  and a post-redirect-get (`303`) after either decision so a refresh can never re-submit.
  `src/lib/device-auth-api.ts` is the wire client
  (never throws; `{ status, body } | { status: "network" }`);
  `src/lib/device-authorize.ts` is the pure view model,
  mirroring no refusal-code vocabulary (ADR 0005) —
  every sentence a person reads comes verbatim off the wire.
  `src/lib/device-authorize-dev.ts` stands in for the backend under `astro dev`.
- **`/cli` joined `APP_ROUTE_PREFIXES`** in `src/lib/host.ts` —
  otherwise an anonymous first hit on the app host 301s to `nemar.org` first,
  costing an extra redirect hop through the marketing host before landing back on `/login`.
- **Settings gained a "CLI keys" card** (`id="cli-keys"`, between `#upload-access` and Appearance):
  the list is fetched server-side with `Origin: Astro.url.origin` pinned
  (the cookie path 403s `"Origin not allowed"` without one);
  create and revoke go through new same-origin routes
  (`api/auth/keys.ts`, `api/auth/keys/[id].ts`);
  revoke sits behind `ConfirmDialog`.
- **`next` now survives a brand-new ORCID sign-up mid-flow**:
  `auth/orcid/complete.astro` reads `?next=` and finishes at `/dashboard?next=...`
  instead of `/welcome` when set;
  `dashboard.astro` forwards it to `VerifyEmailStep`,
  which navigates there on success instead of reloading.
  The backend half — appending `?next=` to the `/auth/orcid/complete` redirect —
  is phase 3's PR, in the CLI repo;
  this side is ready for it and behaves exactly as before until it lands.
- **ADR 0016** records two non-obvious constraints:
  Origin must be pinned to `Astro.url.origin` (never a hardcoded production host)
  on every cookie-path call this page or the keys card makes,
  and the confirm/deny POST always ends in a redirect or an in-place refusal render,
  never a plain re-render that could re-submit the form.
- **Build hygiene**: the dev-store seed calls
  (`seedDeviceCodes`/`seedApiKeys` in `device-authorize-dev.ts`)
  needed `/* @__PURE__ */` annotations —
  without them, Rollup kept the calls as bare unassigned statements in the production bundle
  (dev-only machine names and codes included),
  even though every real call site is behind `import.meta.env.DEV` and gets eliminated.
  Confirmed clean: `dist/_worker.js/index.js` carries none of
  `dev-laptop`, `dev-desktop`, `dev-headless`, `nmr_dv*`, `seedDeviceCodes`, or `seedApiKeys`
  after `bun run build`.

**Review round (same day, before merge)**: four review agents found real gaps, all fixed as
separate commits on the same branch.
`Astro.redirect()` builds a fresh `Response` and does not merge `Astro.response.headers`,
so every redirect on `/cli/authorize` needed its own `no-store`
(a `noStoreRedirect` helper now carries it, plus the bare 403/400 responses).
The Settings key-create handler now parses the response body in its own try/catch
(separate from the fetch itself),
requires a non-empty `api_key` before opening the reveal panel,
and never reports a 2xx-but-unreadable body as a network error.
The dev store's `decideDeviceCodeDev` now gates the account check on `authorize` only —
`deny` is ungated, matching the backend's real `POST /auth/device/deny` route —
and answers `account_revoked` for a `disabled` persona, not just `account_pending` for `pending`.
`decisionView` now validates `ok === true` on a 200 body rather than accepting any object,
and every `unavailable` state carries a `reason` (`network` / `server` / `malformed`)
that is logged, with a machine-aware done-view sentence
("Your terminal on `<machine>` will finish signing in on its own").
ADR 0016's Context and Decision sections had two factual errors,
now corrected rather than left to an Update note since the PR had not yet merged:
confirm/deny are cookie-only via `webSessionMiddleware` and call `isAllowedOrigin` directly
(only `/auth/keys` goes through `resolveActingAccount`),
and the predicted staging 403 from a pinned Origin does not reproduce —
`isAllowedOrigin` accepts any `*.nemar.org` host today, `app.nemar.org` included.

Gates run clean from the worktree: `bun run lint`, `bun run typecheck` (0 errors), `bun run test`,
`bun run build`, and the dev-store-string bundle check.
End-to-end confirm with a real ORCID account needs `api-test.nemar.org`,
which only deploys from nemar-cli `dev` — recorded on #1282 once the epic reaches there.

## 2026-08-03 — funder fix + profile completeness (v0.2.4)

Two features landed on `staging` and a stale-docs trap got closed.

- **#204 (PR #230)** — `Funding.funder` never existed; the API sends `funder_name`, so
  every dataset page rendered blank funder chips. Renamed the field, added the two the
  type omitted (`award_uri`, `funder_identifier_type`), and added
  `displayableFunding()` in `format.ts` which trims and drops nameless entries so a null
  cannot recreate the blank chip. A reviewer surveyed the whole catalog to settle whether
  dropping nameless entries hides data: **1080 funding entries across 408 datasets**, all
  with `funder_name`, none with `funder`, none with award data and no funder name. So no
  compatibility branch was needed and nothing is hidden.
- **#226 (PR #231)** — dismissible dashboard nudge + server-side city/country gate on
  `/upload`. `src/lib/profile.ts` is the single definition of "complete". The gate
  **withholds** the form rather than hiding it. Review caught two things worth
  remembering: `canUpload()` was dead code while `upload.astro` re-derived the same
  decision inline (two definitions free to drift — now the page calls the helper), and the
  nudge's dismissal key was not scoped per user, so on a shared browser one account's
  dismissal suppressed the banner for the next. The key now includes `session.user.id`.
- **`@nemar.blank` dev persona** (`auth-dev.ts`) — the dev mock always issued a complete
  profile, so neither new state was reachable locally. Verified the DEV gate holds: a
  production build contains zero occurrences of `nemar.blank`, `buildDevUser`, or the
  persona strings.
- **#232** — `Closes #N` does nothing here. GitHub honours closing keywords only on PRs
  merged to the *default* branch (`main`), and every feature PR targets `staging`.
  nemar-cli has the same gap with `dev`. Now in AGENTS.md. **When auditing, cross-check
  open issues against merged PRs before calling anything unshipped** — that mistake made
  nemar-cli#984/#985 look open eleven days after they were fixed.

Verified end-to-end on the deployed `test.nemar.org` with a real backend session
(`pl-webqa@nemar.test`): nudge copy renders, `/upload` shows the gate with **zero**
`data-upload-form` in the HTML, dismissal key is `nemar:profile-nudge:951:...`, and
dataset pages render real funder names.

Gotcha worth keeping: `POST /api/auth/code/verify` on staging requires `remember` in the
body (zod-validated); omitting it 400s with a confusing ZodError. The per-email code
request is rate-limited to 1/min, so a retry loop silently returns no `dev_code`.

## Earlier: promotion session addendum (2026-08-02)

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
ORCID iD** — the only path no curl can walk. (website#226 is done, see the 2026-08-03
section above.)

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
- ~~website#226 — profile-completeness push.~~ DONE 2026-08-03 (PR #231).
- **Next candidates, in the order I'd take them:** #209 (JSON-LD share-alike
  `conditionsOfAccess`, small and self-contained), #201 (upload retry re-runs
  `createDraftDataset` instead of retrying finalize — a real bug), #208
  (eeg-viewer leaves zarr fetches in flight on unmount; no `AbortController`
  in `store.ts` at all). #4 (Phase 3 data quality) is blocked on **coverage**,
  not code: the components and the client-side walker already exist but only
  31 of 754 managed datasets have QA artifacts in S3, and the hallu sync
  cannot run unattended until nemar-cli#522/#526 land. See the status comment
  on #4.
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
