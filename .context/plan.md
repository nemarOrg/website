# nemar-website Development Plan

Updated 2026-07-24. See `.context/handoff.md` for the latest session narrative.

## Project Overview

**Goal:** nemar.org redesign — Astro frontend on Cloudflare Pages,
reusing the `api.nemar.org` (D1 catalog) and `data.nemar.org` (BIDS HTTPS) backends.

**Stack:** Astro 6, Bun, Cloudflare Pages (SCCN account), Biome, Vitest, vanilla CSS tokens.

**Branches:** `main` = production (`nemar-website` Pages project, CF GitHub integration →
ww2.nemar.org + app.nemar.org). `staging` = fast-forward mirror of `main` deployed to
test.nemar.org (`nemar-website-test` project) against the nemar-cli `dev`-branch backends
(api-test/data-test/zarr-test). The redesign epic branch is retired.

## Shipped (high level)

- Redesign epic #1 phases 1–3: landing, Discover, dataset detail, QA/HED panels, EEG viewer.
- Auth: ORCID sign-in (#128/#130), onboarding fields (#131), settings self-service frontend
  (#132–135 via PR #144) — name, email change, ORCID link/unlink, profile fields.
- Researcher dashboard: my-datasets, publish status, collaborators, upload flow with
  client-side BIDS pre-check (`src/lib/bids-precheck.ts`), delete/publish request dialogs.
- Admin: `/admin/publication-requests` (approve/deny, role-gated).
- Staging site test.nemar.org + noindex for non-prod hosts (epic #923 Phase 6–7).
- OG cards, schema.org groundwork, theme-aware hero, channel/montage filters.

## Current workstreams

### 1. Account features blocked on backend field exposure
Settings shows "ORCID not connected" / empty GitHub despite linked ORCID because
`/auth/me` returns only `id/email/role/status`. Frontend is complete and correct.
Fix is nemar-cli#910 (expose profile fields), plus #911 (email change), #912 (profile
PATCH), #913 (ORCID re-link) for the corresponding settings actions. Implement on
nemar-cli `dev`, verify on test.nemar.org, then promote.

### 2. Admin portal epic — [website#158](https://github.com/nemarOrg/website/issues/158)
Port dashboard.nemar.org (nemar-observability Worker) into `/admin` on app.nemar.org:
observability overview tiles (public snapshot JSON), signup approvals, publication
requests (exists), import/quarantine triage, notices. Pure frontend; nemar-cli
`/admin/*` + cookie auth already work. Phases in the epic issue.

### 3. Upload UX: real in-browser BIDS validation
Replace/augment the hand-rolled `bids-precheck.ts` structural scan with the same
deno-based bids-validator nemar-cli uses (browser build), so users get real validation
errors before bytes move. Spec in progress; issue to be filed.

### 4. Staging QA loop
test.nemar.org now auto-deploys on push to `staging` (secrets landed 2026-07-20).
Login on staging: email-code flow returns `dev_code` in non-production backends;
ORCID sign-in may fail (sandbox callback registration). Seeding a real ORCID into
staging D1 is being documented.

## Cross-repo dependencies (open nemar-cli issues)

- #910/#911/#912/#913 — settings self-service backend (see workstream 1)
- #511 — QA sync + `/qa/*` route (Phase 3 live data)
- #512 — OpenNeuro import backfill (sparse `on*` rail)
- #513 — BIDS-shaped download filenames
- #653 — `license` on catalog rows (Discover license filter)

## Historical phase issues

Redesign epic #1 (phases: #2 ✓, #3 ✓, #4 QA/HED shipped website-side, #5 Phase 4
citation/community/docs still open, #6 Phase 5 apex-DNS cutover still open — the
production-branch swap to `main` is done; `nemar.org` apex DNS is still legacy F5).
Researcher dashboard epic #10 largely shipped (dashboard/upload/settings live).
