# Handoff — nemar.org website

**Last session:** 2026-07-24.

## TL;DR — where we are right now

`main` is production (Phase 5 branch cutover done; the redesign epic branch is retired).
Prod deploys via Cloudflare's GitHub integration to the `nemar-website` Pages project
(ww2.nemar.org + app.nemar.org; apex nemar.org still legacy F5). The `staging` branch
(a fast-forward mirror of `main`) auto-deploys test.nemar.org via
`.github/workflows/deploy-test.yml` (secrets landed 2026-07-20) against the nemar-cli
`dev`-branch backends (api-test/data-test/zarr-test). See AGENTS.md
"Branch ↔ environment map".

Auth, dashboard, upload, settings, collaborator management, and one admin page
(`/admin/publication-requests`) are all live on app.nemar.org.

## What happened this session (2026-07-24)

1. **Staging stood up as the counterpart of nemar-cli `dev`:** `staging`
   fast-forwarded to `main`, deploy verified green, test.nemar.org serving with
   noindex. Decision: keep the branch name `staging` (no `dev` branch here).
2. **Settings "ORCID not connected" root-caused:** frontend is correct;
   production `/auth/me` returns only `id/email/role/status` because nemar-cli#910
   never landed (migrations 0051/0052 added the columns; the endpoint change didn't).
   **Fix implemented:** nemar-cli PR #1007 (branch `feature/issue-910-auth-me-profile-fields`,
   base `dev`) — extends `findSessionByCookieId` SQL + `publicUser()` to return
   given_name/family_name/orcid/orcid_verified (boolean)/github_username/city/country/affiliation.
   After it merges to `dev` you can verify on test.nemar.org, then promote dev → main.
   Settings *edit* actions still need nemar-cli #911 (email change), #912 (PATCH
   /auth/profile), #913 (ORCID re-link) — all still open.
3. **Staging sign-in unblocked, safely:** website PR #160 (issue #159) makes the
   email-code form build-aware (`webSigninEnabled()` in `src/lib/flags.ts`: on for
   non-prod backends + astro dev, off for prod and prod-build previews) and
   surfaces/prefills the backend's `dev_code` on /login/verify. Because the staging
   D1 mirrors real users and `dev_code` is echoed to the requester, nemar-cli
   PR #1009 (issue #1008) allowlists non-prod code issuance: admins/owners (real
   email delivery, never echoed) + `test@nemar.org` (`test-web`, normal approved
   member, the shared upload-QA account — already seeded into nemar-db-dev) +
   `@nemar.test` fixtures (dev_code echoed for these synthetic accounts only).
   ORCID on test.nemar.org still can't complete — callback unregistered (owner
   action; see AGENTS.md staging section for the two options).
4. **Admin portal planned:** epic **website#158** — port dashboard.nemar.org
   (nemar-observability Worker) into `/admin` on app.nemar.org. Key facts: all admin
   authority is nemar-cli `/admin/*` behind adminMiddleware; the observability
   dashboard is a thin Bearer-relay with one tile-grid page; nemar-cli auth accepts
   the session cookie, and the website already has the role-gate + cookie/proxy
   patterns (`admin-api.ts`, `/api/v1/[...path].ts`). Pure frontend work, 5 phases
   in the epic. Snapshot JSON: `GET dashboard.nemar.org/observability/api/snapshot`
   (public; SSR-fetch it). Drill-down lists must come from nemar-cli `/admin/*`
   directly (the observability drilldown endpoint is Bearer-only).
5. **In-browser BIDS validation planned:** issue **website#161** — replace the
   hand-rolled `bids-precheck.ts`-only flow with real `@bids/validator` (browser
   build, `fileListToTree` + `validate`), pinned to nemar-cli's
   `validator-version.json` (2.4.1) for CLI/CI/web lockstep.
6. **Docs refreshed:** AGENTS.md (branch map, architecture map, staging login,
   PII caution for nemar-db-dev), CLAUDE.md (worktrees), deploy-test.yml comments,
   `.context/plan.md` rewritten.

## Open PRs / immediate pick-ups

- **nemar-cli PR #1007** (auth: /auth/me profile fields) — review, merge to `dev`,
  wait for `deploy-dev`, then check test.nemar.org settings shows ORCID/GitHub.
  The live passwordless suite asserts the new fields at dev→main promotion.
- **website PR #160** (staging email sign-in) — review, merge to `main`, then
  `git push origin origin/main:staging` and QA the dev_code sign-in flow on
  test.nemar.org end to end (sign in as `test@nemar.org`).
- **nemar-cli PR #1009** (staging sign-in allowlist, issue #1008) — merge to `dev`
  BEFORE or together with website #160 reaching test.nemar.org; it closes the
  mirrored-real-users sign-in hole that the email form would otherwise open.
- **nemar-cli PR #965** (`fix/seed-web-user-failopen`, open since 2026-07-21) —
  pre-existing, small: makes the seed-web-user fixture guard fail-closed. Worth
  merging.
- **Owner actions for real-ORCID staging login:** register
  `https://test.nemar.org/auth/orcid/callback` on the production ORCID app +
  `wrangler secret put ORCID_API_BASE --env dev` = `https://orcid.org`
  (see AGENTS.md staging section; alternative: register on sandbox and use a
  sandbox test account).

## Next big workstreams (in rough priority order)

1. Admin portal epic website#158 (phases 1–5; start with the shell + overview).
2. In-browser BIDS validation website#161.
3. Settings edit backends: nemar-cli #912 (PATCH /auth/profile) → #911 (email
   change) → #913 (ORCID re-link). Frontend for all three already shipped in PR #144.
4. Phase 4 pages (citation dashboard / community / docs; issues #5) and the apex
   DNS cutover (#6) remain open from the redesign epic.

## Gotchas (current)

- `staging` must stay a fast-forward of `main`; never commit to it directly.
- nemar-cli has NO staging branch: its `dev` branch Worker (`nemar-api-dev`)
  serves both the raw workers.dev URL and the `*-test.nemar.org` domains, with
  D1 `nemar-db-dev` — a partial prod mirror containing real user emails. Careful
  with bulk ops.
- `imageService: "passthrough"` stays (sharp doesn't run in Workers).
- Session cookie is `Domain=app.nemar.org`; browser-side authenticated calls go
  through the same-origin `/api/v1/[...path]` proxy.
- OG cards under `public/og/` are generated, not source.
- The website role mapping collapses backend `owner|admin` → `"admin"`; owner-only
  admin UI (delete user, bulk ops) needs the raw role — plan for it in epic #158.
