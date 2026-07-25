# Handoff — nemar.org website

**Last session:** 2026-07-24/25.

## TL;DR — where we are right now

`main` is production (Cloudflare GitHub integration → `nemar-website` Pages project,
ww2.nemar.org + app.nemar.org; apex nemar.org still legacy F5). `staging` is a
fast-forward mirror of `main` deploying test.nemar.org against the nemar-cli `dev`
backends. See AGENTS.md "Branch ↔ environment map".

**New this session: the `/admin` portal is live on app.nemar.org.** Phases 1–3 of
epic #158 shipped to production (PR #171 → `b58093f`; PR #174 → `92cf934`).
Phases 4–5 (imports/quarantine triage, notices) are not yet scoped.

## What happened this session

1. **ADR 0010 landed** (PR #166). The tiered-access decision (base auto on ORCID vs
   admin-granted service access) is now recorded in `.context/decisions/`.
   Note: `main` is protected — 4 required checks — so even docs need a PR.
2. **Admin portal epic #158, Phases 1–2 shipped to prod** (PR #171 → `b58093f`):
   - **Phase 1 (#167, PR #169):** `adminGate()` extracted from the previously-inlined
     gate (404-not-403 preserved), `ADMIN_TABS`, `AdminLayout.astro`,
     `/admin` route, `publication-requests` refactored onto the shell (URL and
     behaviour unchanged), UserMenu → `/admin`, and additive `AuthUser.backend_role`
     carrying the uncollapsed `owner|admin|member` for owner-only gating.
   - **Phase 2 (#168, PR #170):** fail-soft observability client + hand-rolled SVG
     tile grid / breakdowns / sparklines, wired into `/admin` at `6b06d26`.
   - Verified in prod: anonymous `/admin` → 302 `/login?next=%2Fadmin`.
3. **Phase 3 (#172, PR #174 → `92cf934`) — users admin, shipped.** Signup-approval
   queue, user detail, approve/revoke + owner-only role change and delete,
   awaiting-approval badge in the shared shell. Review caught one real bug, fixed
   before merge: **self-targeting actions weren't gated client-side.** The backend
   blocks self-revoke / self-role-change / self-delete to prevent lockout, but the
   UI walked an owner through the full typed confirmation before surfacing the 400.
   Now gated via an exported, tested `isSelf()` helper that compares ids **as
   strings** — `Number(session.user.id)` would be `NaN` for the dev mock's
   non-numeric ids, so the bug would have looked fixed locally while staying live
   in production. Self-*approve* is deliberately not gated: the backend permits it.
4. **Two upstream issues filed** from things found while reading the real backends
   (see "Blockers found this session").

## Gotchas learned this session (these cost real time)

- **`main` requires branches to be up to date.** A PR cut before another merge lands
  goes `mergeStateStatus: BEHIND` and `gh pr merge` refuses with a misleading
  "add --auto" hint. Fix: merge `main` into the branch, re-run gates, wait for CI.
- **`Closes #N` does not fire for PRs merged into a non-default branch.** Phase PRs
  targeting an epic branch leave their issues open; close them by hand.
- **Phase PRs → epic branch are squash-merged** (matches the prior epic's history:
  single-parent commits). The "regular merge commit, never squash" rule in the
  global instructions governs merges to `main`, not phase→epic.
- **Local dev cannot authenticate a dev-mock session against production
  `api.nemar.org`.** This is pre-existing (the publication-requests page has the
  same limitation), not new. To exercise admin UI locally you need a fixture API
  server pointed at via `PUBLIC_API_BASE_URL`. Consequence: **Phase 3's UI was
  verified against fixtures, not live data — it deserves a real admin pass on a
  preview deploy.**
- **Dev admin session recipe** (`astro dev` only): emails ending `@nemar.admin` get
  `role: "admin"` in the dev mock; accepted code is `123456`.
  `POST /api/auth/code/request` then `/api/auth/code/verify`. Note the mock yields
  `admin`, not `owner`, which makes it a good test that owner-only controls are
  *absent*.
- **First `/admin` request under `astro dev` can exceed 5s** (Vite cold dependency
  optimization) and trip the observability deadline, rendering the degraded
  "Overview data is unavailable" state. Re-request warm before believing it.
  Warm render is ~370ms.

## The recurring bug class to watch for

**An optional `AbortSignal` that is never defaulted.** Three separate places in this
codebase pass `signal: init.signal` where callers supply nothing. A `try/catch`
around `fetch` covers a request that *fails* — it does not cover one that *hangs*
(connection opens, never writes a response): that promise never settles, so there is
nothing to catch. These clients run during SSR, so an unbounded one stalls the page
render itself.

- Fixed in `observability.ts` (Phase 2 review) and `users-admin-api.ts` (Phase 3),
  both via `resolveSignal()` = `AbortSignal.timeout()` combined with any caller
  signal through `AbortSignal.any()`. Decorative fetches get a shorter deadline than
  primary content — the awaiting-approval badge uses 2s because it is awaited from
  the shared `AdminLayout` on *every* admin page.
- **Still outstanding: website#173** — same pattern in `admin-api.ts`, and an audit
  of `dashboard-api.ts`, `collaborators-api.ts`, `upload-client.ts`.
- Test it by driving the real abort path (a fetch that only settles by rejecting on
  its signal's abort event), never a faked timer.

## Blockers found this session

- **nemar-cli#1023 (filed)** — no admin endpoints exist to grant/revoke service
  access, and `GET /admin/users` doesn't project `service_access` or the
  city/country/affiliation fields ADR 0010 requires for export-control review. The
  enforcement half of tiered access shipped; the granting half was never built.
  This is why the service-access queue was cut from Phase 3.
- **nemar-cli#1012 (pre-existing, open)** — ORCID/web signups land with
  `username = NULL`, and every admin write endpoint except delete is keyed by
  username, so those users are unaddressable. Phase 3 renders them with an
  explanation + issue link and offers only the id-keyed delete (owner-only). Do not
  "fix" this by hiding those rows: they are exactly the population the approval
  queue exists to serve.

## Immediate pick-ups

- **Real admin pass on a preview deploy** of the users admin. It was verified
  against a fixture API server, not live data (see the dev-auth gotcha above), so
  the owner-only affordances and the null-username rows deserve one look with a
  real admin session before they're trusted.
- **Promote nemar-cli `dev` → `main`** — still the blocker for `/auth/me` profile
  fields (#1007) reaching production app.nemar.org. Check the grandfather backfill
  count first; the upload gate is stricter now.
- **Phases 4–5 of #158** (imports/quarantine triage, notices) — not yet scoped into
  issues.
- **Design pass**: the admin active tab uses `--brand-teal`/`--brand-navy` while
  `DatasetTabs` uses theme-aware `--color-fg`/`--color-bg`. Both token-based, but
  they read as two systems side by side.
- **Owner actions for real-ORCID staging login** — register
  `https://test.nemar.org/auth/orcid/callback` on the production ORCID app +
  `wrangler secret put ORCID_API_BASE --env dev` = `https://orcid.org`.

## Epic backlog

- **Admin portal — website#158.** Phases 1–2 shipped, Phase 3 in review, 4–5 open.
  Phase 2 of tiered access (the service-access grant queue) belongs here once
  nemar-cli#1023 lands.
- **Tiered access — nemar-cli#1013.** Phase 1 shipped to dev (ADR 0010). Children:
  #1012, #1016, #1018, #1014, and the new #1023.
- **Settings self-service backends — nemar-cli#1019.** #910 merged to dev;
  remaining #911 (email change), #912 (PATCH /auth/profile), #913 (ORCID re-link).
- **Contribute / upload — website#164.** #161 (in-browser BIDS validation) + the
  upload-page `service_access` gate.

Standalone: nemar-cli#1010 (flaky integration-dev CI), website#173.
Parked: legacy import (nemar-cli#833 / website#129).
Redesign-epic remnants: website#5 (Phase 4 citation/community/docs), #6 (apex DNS).

## Standing gotchas

- `staging` must stay a fast-forward of `main`; never commit to it directly.
- nemar-cli has no staging branch: its `dev` Worker serves the `*-test.nemar.org`
  domains with D1 `nemar-db-dev`, a partial prod mirror **containing real user
  emails**. Careful with bulk ops.
- `imageService: "passthrough"` stays (sharp doesn't run in Workers).
- Session cookie is `Domain=app.nemar.org`; browser-side authenticated calls go
  through the same-origin `/api/v1/[...path]` proxy.
- OG cards under `public/og/` are generated, not source.
- `/admin` cannot be edge-cached: `isPublicCacheable` requires an explicit
  `Cache-Control: public, max-age`, which Astro SSR pages don't emit, and
  authenticated traffic bypasses the cache entirely.
