# Handoff — nemar.org website

**Last session:** 2026-10-06.

## 2026-10-06 — Release 0.2.29: Try again in the viewer (website#416)

Staging `0.2.29-dev2` was prepared as `0.2.29` and promoted through #433.
The release holds one change, the viewer's Try again button (#428), plus the changelog cut (#431),
the `package.json` description (#432) and the release-review fixes (#436).

- **`private.nemar.org` is deliberately not advertised.**
  The host does not resolve yet and nothing links to `/auth/private/authorize`;
  that surface has its own suite of work and ships separately, so do not add a link until the host is live.
- **Release review (two Sonnet reviewers):** no blocker. Fixed in #436: the outage message's Try again is
  now described by its sentence and the changelog says so only where it is true, a failed retry that ends
  in a message with no button puts the focus on the message, `RETRY_CLASS` lives in `eeg-viewer/retry.ts`
  with a test that reads the stylesheet, and three comments were corrected.
- **Filed, not fixed:** website#434 (Reload page in an embed counts one more call under the embed's own
  host; measured in Chromium and WebKit, and the suggested `replaceState` plus `reload` does not help)
  and website#435 (no end-to-end spec: eight mutations of the retry code left all 3010 tests green).
- **Known flake:** `generate-og-images.mjs` failed one CI build on a 500 from `api.nemar.org/datasets`
  (the same URL answered 200 six times a minute later); the re-run passed. A production build runs the
  same script, so if a Cloudflare build fails on `[og] catalog fetch failed`, retry the deployment.
- Still open from 2026-10-05: nemar-observability#98, website#425, and the legal look at the
  "Your Privacy Choices" icon on the embed.

## 2026-10-05 — Embeddable signal viewer, edge counting, release 0.2.28 (website#410)

Released to production as **0.2.28** (#424, `51160dad`); staging is at `0.2.29-dev0`.

- **Embed route** `/dataset/<id>/embed` (ADR 0023): the only frameable route (`frame-ancestors *`, no
  `X-Frame-Options`); everything else stays `'self'` + `SAMEORIGIN`. Verified on production for
  nemar.org, www and ww2; app.nemar.org 301s to the apex. The viewer orchestration is shared with the
  dataset page through `src/lib/eeg-viewer/viewer-session.ts`, so a viewer feature is built once.
  The embed hides the time readout everywhere and the overview strip at 560 px or less
  (#420, #422); at 360 x 480 the toolbar is two rows.
- **Edge counting** (ADR 0024): each GET 200 on the embed route writes one Analytics Engine point
  (`EMBED_ANALYTICS`: `nemar_website_embeds` on production, `nemar_website_embeds_dev` on
  previews and staging). The production smoke row (`on007753`, `smoke.invalid`, `iframe`) is in.
- **Reading the counts:** an Account Analytics Read token is in Infisical (project `nemar`, env
  `dev`, path `/observability/cloudflare`) and on the `nemar-observability-dev` Worker. The
  scratch script that queried it (`query-smoke.sh`, in that session's scratchpad) injected it with
  `infisical run` and printed counts only; an agent must not read or print the token itself.
- **Footer:** "Your Privacy Choices" at the end of the copyright line (#414).
- **Cloudflare Web Analytics** automatic setup is off for the nemar.org site (#418); its beacon
  was always blocked by the CSP and is gone from every host.
- **Docs:** nemarOrg/docs#61 is live (privacy policy "Embedded viewer" section, embedding guide).
  docs#62 (the dashboard sentences) is a draft that merges with nemar-observability#98.
- **Release-review fixes** (#426): `?view=` and `?v=` are quoted back only when they look like a
  recording name or a version (`displayableViewParam`, `displayableVersion`).

### Open

- nemar-observability#98, the dashboard "Signal viewer" entry: reviewed through four rounds and
  clean; merging it to `main` deploys production (migrations 0006 to 0009). Embedding sites are
  counted on the public page and never named; admins get hosts through the bearer drill-down
  `embed-sites`. Follow-ups: nemar-observability#99 (Umami vars on dev), #100 (`resolveAdmin`),
  #101 (preset-claim nits). The dev Worker's cron fires at :17, not :47 (likely a stale trigger;
  check the Triggers tab).
- website#425 (admin portal list of embedding sites). website#416 shipped in 0.2.29.
- `private.nemar.org` does not resolve yet; nothing links to `/auth/private/authorize`.
- The embed uses the "Your Privacy Choices" icon for a link to the policy; the release reviewer
  suggested a legal look, since that icon usually signals an opt-out.

## 2026-09-29 — News section and landing highlights (website#371)

On `feature/issue-371-news` (worktree `website-worktrees/news`), PR #372 into `staging`.
Backend half: nemar-cli#1553 (issue nemar-cli#1551), into `dev`.

- **Landing:** the two feature cards under the hero became three live columns
  (`Highlights.astro`): newest news, most cited datasets (to the citation dashboard),
  latest datasets. Each fails soft to a dropped column.
- **"Most cited last month" is not built yet**, on purpose (a month, because citations arrive
  too slowly for a week). Nothing records when a citation was found, and diffs of
  nemar-citations history are dominated by pipeline re-runs. nemar-citations#247 proposes a
  `first_seen` signal with a 30-day window; the column shows all-time counts until then.
- **News:** `/news`, `/news/<slug>`, `/news/feed.xml`, `/news/media/<file>` (same-origin image
  proxy, host-neutral; ADR 0020), `/og/news/<slug>.png` (build-time card, banner fallback).
  Admin at `/admin/news` with an editor (Markdown preview, banner and inline image upload by
  button, drop, or paste; drafts, scheduling, backdating).
- **Images live in R2**, bucket `NEWS_MEDIA` on the API Worker: `nemar-news-media` (prod) and
  `nemar-news-media-dev` (dev). Both must exist before the backend deploys, or the deploy fails.
- **Seed:** `scripts/seed-news.mjs` with an admin API key creates the first five posts,
  dated by first production release. Idempotent. Needs to run per environment after the
  backend is there.
- **Deploy order:** buckets, then nemar-cli, then seed, then this site. Without `/news`, the
  landing news column is absent but `/news` says the news could not load.
- **Local E2E:** plain `wrangler dev` of the backend does not start from a fresh local D1
  (migration 0021, nemar-cli#1324). What worked: a Bun script mounting the backend's route
  modules on `realD1(freshDb())` from `backend/test/helpers/d1.ts` and Miniflare's R2, with
  other paths proxied to api.nemar.org, and the site run with `PUBLIC_API_BASE_URL` pointed at it.

### Where it stands (end of 2026-09-29)

- **Staging is done; production is not.** nemar-cli#1553 was squash-merged into `dev` as
  `53f3a246` and is deployed to api-test.nemar.org (0.10.10-dev5). website#372 was merged into
  `staging` as `1b08d1c` (merge commit). nemar-cli#1551 and website#371 were closed by hand.
- **Both buckets exist** on the SCCN account. The `CLOUDFLARE_API_TOKEN` secrets of nemar-cli
  and website now carry Workers R2 Storage Edit; before that, the dev deploy failed on the
  bucket check with Cloudflare error 10000.
- **Staging data:** the five seed posts (#1, #3 to #6) and `staging-test-post` (#7), a labeled
  test post for trying the pages and the editor. It exists only on dev; do not recreate it on
  production. A 43-byte probe GIF sits unreferenced in `nemar-news-media-dev`.
- **Dev admin key:** account `nemarAdminTest` in `~/.config/nemar/config.json` (user
  `sshirazi`, owner on the dev database, signed in with ORCID; `apiUrl` is
  `https://api-test.nemar.org`). `nemar auth switch nemarAdminTest` targets dev.
- **GitHub never delivered the `1b08d1c` push** (no Auto Bump, CI, Deploy staging, or any
  app's check suite). Deploy staging and CI were dispatched by hand; the next merge (#373)
  bumped to `0.2.22-dev1` as usual. It is a GitHub-side fault on this repository, seen three
  times since 2026-09-28 on `staging` and `main`: evidence in website#374, and
  `push-watchdog.yml` as the stopgap until it clears.
- **QA on test.nemar.org passed:** landing with three columns (the test post leads), `/news`
  with all six posts, articles (banner, inline figure with caption, headings, code, lists), RSS,
  unknown slug 404, media through the same-origin proxy (bad names 404 before any upstream
  call), and `/admin/news` redirecting to sign-in. `/sitemap.xml` is 404 on staging by design
  (noindex host). The staging deploy sets `NEMAR_SKIP_OG_GENERATE=1`, so no news OG cards
  exist there and `/og/news/<slug>.png` falls back to the banner; the cards can only be
  checked on production.

### Production steps, for the promotion session

In this order. The site must not reach production before the backend serves `/news`, and
seeding before the site's production build is what lets the news OG cards render (otherwise
they fall back to the banner until the next scheduled rebuild).

1. Promote nemar-cli `dev` to `main`, which brings #1553. `nemar-news-media` already exists.
   Check that `curl -s https://api.nemar.org/news` answers `{"posts":[],...}`.
2. Seed production from this repository with a production admin key, dry run first:
   `NEMAR_API_KEY=... bun scripts/seed-news.mjs --api https://api.nemar.org --images ~/Desktop --dry-run`,
   then without `--dry-run`. The five screenshots are `~/Desktop/nemar-*.png`. One upload on
   staging failed with `ECONNRESET` and the rerun went through; the script skips slugs that
   already exist.
3. Run Prepare release on `staging`, then open and merge the `staging` to `main` PR.
   Within a minute, confirm that Release and CI started for the merge commit and that
   Cloudflare is building it. GitHub has been dropping pushes to this repository
   (website#374); the first merge of release #368 ran nothing and left the PR open. If
   nothing started, dispatch Release on `main` and retry the Cloudflare deployment. This
   promotion also brings `push-watchdog.yml` to `main`, after which a dropped push is
   replayed automatically.
4. Verify on production what staging cannot cover (website#212): `/news/media/<file>` answers
   on both nemar.org and app.nemar.org (host-neutral), `/admin/news` lives on app.nemar.org,
   and `https://nemar.org/og/news/<slug>.png` redirects to `/og/news-card/<slug>.png`.

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
