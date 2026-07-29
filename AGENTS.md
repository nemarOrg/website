# nemar-website Instructions

## Project Context

**Purpose:** Redesign of nemar.org — the public front door for the Neuroelectromagnetic Data Archive and Tools Resource (NEMAR). Astro frontend that consumes the existing `api.nemar.org` (Cloudflare Workers + D1 catalog) and `data.nemar.org` (BIDS HTTPS view, manifests, metadata) backends from `nemarOrg/nemar-cli`.

**Tech Stack:**
- Astro 6 with `@astrojs/cloudflare` adapter, `output: "server"`, `imageService: "passthrough"` (don't change — sharp doesn't run in the Workers runtime)
- Bun for package management (lockfile: `bun.lock`). **Never npm / npx / pnpm.**
- Biome for lint + format
- Vitest for unit tests
- Hand-rolled SVG charts (no chart-lib dep)
- Vanilla CSS with token variables (no Tailwind, no CSS-in-JS)

**Deploy target:** Cloudflare Pages, project `nemar-website` on the SCCN Cloudflare account. Production branch is `main` (the Phase 5 cutover happened; the old epic branch `feature/issue-1-epic-nemar-redesign` is retired). Prod deploys via Cloudflare's GitHub integration on push to `main`; there is no prod deploy workflow file in this repo.

**Branch ↔ environment map** (mirrors nemar-cli's `dev`/`main` split):

| Website branch | Deploys to | Pages project | Backend it talks to | nemar-cli branch |
|---|---|---|---|---|
| `main` | nemar.org / www / ww2 / app.nemar.org | `nemar-website` (CF GitHub integration) | api/data/zarr.nemar.org | `main` |
| `staging` | test.nemar.org | `nemar-website-test` (`.github/workflows/deploy-test.yml`) | api-test/data-test/zarr-test.nemar.org | `dev` |

There is deliberately no `dev` branch in this repo — `staging` is the website's counterpart to nemar-cli's `dev`.

**`staging` leads `main`; it does not trail it.** Feature PRs target `staging`, land there,
deploy to test.nemar.org against the nemar-cli `dev` backends, get QA'd, and only then does
`staging` promote to `main` as a single merge. Do not merge feature PRs straight to `main`.

This was the other way round until 2026-07-29 (`staging` was kept as a fast-forward mirror of
`main`, refreshed after each production merge). That made staging incapable of catching
anything: by the time it ran the code, the code was already in production.

**Staging cannot exercise two-host routing.** `test.nemar.org` is in neither `APP_HOSTS` nor
`MARKETING_HOSTS`, so `hostMode()` returns `"single"` and every cross-host redirect is inert
there — as it is on `*.pages.dev` previews. Anything touching `src/lib/host.ts`,
`src/middleware.ts` host dispatch, or canonical origins is therefore **not** covered by a
staging soak and needs a deliberate check on the real hosts after promotion. Tracked in
website#212 (staging needs an app-host counterpart).

Promotion, once staging is verified:

```bash
git fetch origin
git push origin origin/staging:main    # fast-forward; branch protection requires green checks
```

**Four custom domains on Pages, one build** (apex cutover done 2026-07-29, website#190):
- `nemar.org` (apex) — the canonical marketing surface. Anonymous and edge-cacheable; skips `/auth/me`. `MARKETING_BASE_URL` points here.
- `www.nemar.org` — CNAME to the apex, but attached to Pages in its own right because **Pages is Host-strict** and would not serve it otherwise.
- `ww2.nemar.org` — the pre-cutover marketing host. **Still serving, deliberately.** The old apex→ww2 bridge was a bare 301 with no `Cache-Control`, so browsers cached it persistently; if ww2 redirected back to the apex those clients would loop forever and no server-side change could reach them. Leaving it up means a poisoned cache lands on a working page. Retire only once those entries age out. Its canonical tags already point at the apex, so it does not compete in search.
- `app.nemar.org` — authenticated surface (cookie-scoped to this host, no edge cache).

The legacy HUBzero site moved to `ww1.nemar.org` (A → `132.249.225.118`, proxied). SDSC added a `ServerAlias` and made its `<base href>` follow the request host, without which ww1 would render but eject visitors to the apex on their first click.

`src/middleware.ts` reads `Astro.url.hostname` and 301-redirects mismatches across known production hosts (e.g. `/dashboard` on `nemar.org` → `https://app.nemar.org/dashboard`). Anything else (localhost, `test.nemar.org`, `*.pages.dev` previews) runs in single-host mode with no redirects — cheap for QA, but see the staging caveat above: it also means staging cannot exercise any of this. Route classification lives in `src/lib/host.ts`. The session cookie is scoped to `app.nemar.org` so it never leaks to `data.nemar.org`, `api.nemar.org`, or `docs.nemar.org`.

**Marketing routes render on the app host for signed-in users** (website#210). `getCrossHostRedirect` suppresses the marketing-bound redirect when a session cookie is present, so clicking Discover from the dashboard no longer bounces to a host the cookie cannot reach. The suppression is one-directional by design: marketing→app is never suppressed, because the marketing host's responses are shared edge-cache entries and must not vary per user. Canonical origin therefore follows the **route**, not the serving host — see `canonicalOriginFor`.

**Architecture:** Server-rendered Astro pages at the Worker edge. Three backend services are reused, never reimplemented:
- `api.nemar.org/datasets` — D1-backed catalog list + per-id catalog row
- `data.nemar.org/<id>/metadata.json` — neuroschema v0.3.0 doc
- `data.nemar.org/<id>/<version>/{manifest.json,<path>}` — BIDS-shaped file index + 302-to-presigned-S3 byte access

## Architecture Map

```
src/
  layouts/Base.astro                  shared shell (nav + footer + theme bootstrap)
  middleware.ts                       two-host routing, session (/auth/me proxy), edge cache, security headers
  pages/
    index.astro                       landing (hero + search + stat tiles)
    discover.astro                    filter sidebar + offset-paginated dataset list
    dataset/[id].astro                detail (SSR fetch fan-out, prov toggle, README, BIDS tree, rail)
    dataset/[id]/collaborators.astro  per-dataset collaborator management (app host)
    login.astro login/*.astro signup.astro welcome.astro    sign-in (ORCID + email code) + onboarding
    auth/orcid/{start.ts,callback.ts,complete.astro}        ORCID OAuth proxy flow
    api/auth/**                       session-backed proxies: code, email change, profile, unlink, logout
    api/v1/[...path].ts               generic authenticated API proxy
    dashboard.astro                   my-datasets list + publish status (app host)
    upload.astro upload/success.astro upload flow (dropzone + BIDS pre-check + direct-to-storage PUTs)
    settings.astro                    account: name/email/ORCID/GitHub/profile self-service
    admin/publication-requests.astro  admin-only (role=admin; 404s for others)
    about.astro support.astro community.astro
    og/** robots.txt.ts 404.astro
  components/                         all .astro components; scoped <style> per file
  lib/                                 typed helpers + clients
    api.ts / api-base.ts              api.nemar.org client (unwraps {dataset:...}); env-aware base
    data-api.ts / data-base.ts        data.nemar.org client (landing/metadata/manifest/README fetch)
    auth.ts auth-dev.ts auth-proxy.ts orcid-proxy.ts   session types/helpers, dev mock session, backend proxies
    dashboard-api.ts admin-api.ts collaborators-api.ts upload-client.ts   authenticated API clients
    bids-precheck.ts                  hand-rolled client-side BIDS structural pre-check (upload)
    flags.ts                          feature flags (ORCID_SIGNIN_ENABLED, WEB_SIGNIN_ENABLED, ...)
    host.ts                           two-host route classification + noindex/production host logic
    qa.ts                             /qa/* contract (Phase 3, pending nemar-cli#511 backend)
    filters.ts                        FilterState ↔ URL params; modality AND/OR; license tier
    tags.ts                           modality/license/keyword classification + /discover hrefs
    provenance.ts                     detectProvenance for on*; listMirrorVersions
    format.ts                         null-safe bytes/date/relative-time/modality split
    bids-tree.ts                      manifest paths → nested TreeNode
    neuroschema.ts                    types mirroring data.nemar.org/<id>/metadata.json
    markdown.ts                       zero-dep CommonMark subset
    eeg-viewer/                       WebGL EEG viewer (traces, topo, montages)
  styles/
    tokens.css                        CSS variables; light + dark themes
    reset.css global.css
test/
  fixtures/                           qa-aggregates, qa-file-dataqual, qa-hed-summary (Phase 3)
public/                               static logos + brain hero assets (og/ cards are generated, gitignored)
```

## Environment Setup

```bash
bun install        # never npm; lockfile is bun.lock
bun run dev        # http://localhost:4321
bun run build      # outputs dist/
bun run test       # vitest unit tests
bun run typecheck  # astro check (must stay green)
bun run lint       # biome
```

## Deploy (SCCN Cloudflare account)

**On the marketing surface, "deployed" and "visible" are different things.**
`ww2.nemar.org` responses are edge-cached by `src/middleware.ts`, and the
cached artifact is the page HTML — component markup and hashed asset URLs
included. `app.nemar.org` skips the cache entirely (authenticated), so the
two hosts can disagree for hours and it reads like a host-specific rendering
bug rather than a cache one. That is exactly how website#188 presented.

The cache namespace is now derived from the build commit
(`__EDGE_CACHE_NAMESPACE__` in `astro.config.mjs`), so a deploy invalidates
by construction. To confirm a change is actually live, compare the **served
asset hash** across hosts rather than trusting the deploy's green tick:

```bash
curl -s https://ww2.nemar.org/ | grep -o '_astro/index\.[A-Za-z0-9]*\.css'
curl -s https://app.nemar.org/login | grep -o '_astro/index\.[A-Za-z0-9]*\.css'
curl -sD- -o/dev/null https://ww2.nemar.org/ | grep -i x-nemar-cache
```

Different hashes with `x-nemar-cache: HIT` means ww2 is still serving a
previous build. Grep the bundle for a marker unique to your change — a
generic declaration like `text-align:center` appears throughout and will
false-positive.

```bash
# Build
rm -rf dist && bun run build

# Deploy — CLOUDFLARE_ACCOUNT_ID must be set in your shell because the SCCN
# token lacks the memberships scope wrangler tries to call when enumerating
# accounts. The account id is org-internal; export it from your shell rc or
# read it from a password manager rather than committing it here.
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:?set SCCN account id in env}" \
  bunx cfman wrangler --account sccn pages deploy dist \
  --project-name nemar-website \
  --branch main \
  --commit-dirty=true
```

## Staging (test.nemar.org)

A second, separate Cloudflare Pages project — `nemar-website-test` — serves
`test.nemar.org` for QA against the nemar-cli staging APIs (epic #923 Phase
6). It is a distinct project from prod `nemar-website`, not a Pages preview
branch, so it gets its own custom domain and its own `SESSION_SECRET`.

- **Branch mapping:** the website `staging` branch is the counterpart of
  nemar-cli's `dev` branch (which deploys api-test/data-test/zarr-test).
  Feature PRs land here first and `staging` promotes to `main`; see
  "Branch ↔ environment map" above. Land work via PR rather than pushing
  commits straight onto the branch, so it stays reviewable.
- **What staging cannot cover:** `test.nemar.org` resolves to single-host
  mode, so cross-host redirects, the signed-in redirect suppression
  (website#210), and app-vs-marketing canonical origins are all inert here.
  Verify those on production after promotion. Tracked in website#212.
- **Config:** `wrangler.test.toml` (separate from `wrangler.toml` so prod
  vars never sync onto the test project).
- **Deploy:** `.github/workflows/deploy-test.yml`, triggered by pushing to
  the `staging` branch or `workflow_dispatch`. It builds with
  `PUBLIC_API_BASE_URL=https://api-test.nemar.org`,
  `PUBLIC_DATA_BASE_URL=https://data-test.nemar.org`,
  `PUBLIC_ZARR_BASE_URL=https://zarr-test.nemar.org` (Astro inlines `PUBLIC_*`
  at build time — that's why staging needs its own build+deploy job, not just
  a runtime var override), then deploys with wrangler. The repo secrets
  (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, Pages:Edit scope) were
  added 2026-07-20, so pushes to `staging` deploy automatically — no manual
  deploy needed. The prod project keeps deploying via Cloudflare's GitHub
  integration; this workflow never touches it.
- **Noindex:** every non-production host (`test.nemar.org`, `*.pages.dev`
  previews) gets `X-Robots-Tag: noindex, nofollow` on every SSR response
  (`isNoindexHost` in `src/lib/host.ts`, threaded through
  `applySecurityHeaders`/`withSecurityHeaders` in `src/middleware.ts`) plus a
  `Disallow: /` from the dynamic `src/pages/robots.txt.ts`. Only
  `app.nemar.org` and the marketing hosts (`isProductionHost`) are
  crawlable. Local dev (`localhost`, `127.0.0.1`) is exempt from noindex —
  there's nothing to keep crawlers off of there.
- **Signing in on test.nemar.org:** use the email-code form (enabled on
  non-production builds via `webSigninEnabled()` in `src/lib/flags.ts`,
  issue #159). Sign-in there is allowlisted (nemar-cli#1008, because the
  staging D1 mirrors real production users): admins/owners (code arrives
  by real email) plus the shared QA account **`test@nemar.org`**
  (`test-web`, a normal approved member for upload/flow QA) and the
  `@nemar.test` fixtures. For the synthetic accounts the backend echoes
  the code as `dev_code` and `/login/verify` surfaces + prefills it, so
  no inbox is needed. Seed extra fixture users with nemar-cli's
  `scripts/seed-dev-db.sql` or the admin-gated
  `POST /admin/test-fixtures/seed-web-user`.
- **ORCID limitation (confirmed, nemar-cli epic #923 known limitation):**
  `https://test.nemar.org/auth/orcid/callback` is not registered with ORCID,
  so ORCID sign-in cannot complete on staging. Non-production backends
  default to sandbox.orcid.org (a separate identity space — real iDs can't
  authenticate there). To make a *real* ORCID iD work on staging: register
  the test.nemar.org callback as an extra redirect URI on the production
  ORCID app, then `wrangler secret put ORCID_API_BASE --env dev` =
  `https://orcid.org` on the nemar-cli dev worker. Owner actions, not code.
- **Staging D1 is not synthetic:** `nemar-db-dev` is a partial production
  mirror (~722 datasets, ~600 users with real emails, live RESEND key).
  Don't run bulk operations against it casually.

## Development Workflow

1. **Check context:** Read `.context/handoff.md` first (it has the most recent session state). Then `.context/plan.md`.
2. **Branch:** `gh issue develop <issue>` for non-trivial work; epic-dev workflow for multi-phase features.
3. **Code:** Follow patterns in this file + the rules. **Component styles are scoped per .astro file** — duplicated layout CSS in nested components is intentional, not DRY-violating (see BidsTree.astro / BidsDirChildren.astro).
4. **Test:** real APIs only. Vitest covers pure helpers in `src/lib/*.test.ts`. Astro page rendering verified via `/browse` against the dev server or a Cloudflare Pages preview deploy.
5. **Commit:** atomic, <50 chars, no emojis, no AI attribution.
6. **PR:** target `staging`, not `main`. See the branch map above — staging leads.
7. **QA on test.nemar.org:** merging to `staging` auto-deploys there against the nemar-cli `dev`
   backends. Verify the change on that deploy. Remember staging runs in single-host mode, so
   host-routing and canonical-origin changes are not covered here (website#212).
8. **Promote:** `git push origin origin/staging:main` once staging looks right. Production
   deploys automatically from `main` via the Cloudflare GitHub integration.
9. **Verify production**, especially for anything staging structurally could not cover.

## [CRITICAL] Core Principles

### Reuse the backend; don't reinvent
- `api.nemar.org` and `data.nemar.org` are the source of truth for dataset metadata, manifests, and bytes. If you need a new field, file a `nemarOrg/nemar-cli` issue first, don't synthesize it in the frontend.
- Where the upstream is sparse, fall back gracefully (see how `on*` datasets enrich from the catalog row). File the gap as an upstream issue.

### NO MOCKS in tests
- Pure helpers get unit tests with real-shape inputs (captured fixtures under `test/fixtures/`).
- Page-level tests run against the live dev server or a deploy preview via `/browse`.
- See `.rules/testing.md` for the full policy.

### Theme-aware UI is non-negotiable
- Every visual decision uses tokens from `src/styles/tokens.css`. Light and dark are equal citizens.
- Theme bootstrap script in `src/layouts/Base.astro` prevents FOUC. Don't move it.
- Components that need theme-specific CSS use `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } }` + `:root[data-theme="dark"] { ... }`.

### Null-safety on backend-shaped data
- Catalog rows for `ds*` and unsynced `on*` datasets ship with null timestamps, null modalities, null author strings.
- `formatDate(null) === ""`, `formatRelativeTime(null) === ""`, `splitModalities("") === []`. **Don't tighten these types** — Astro silently drops cards whose render throws.

### Download links must route through `data.nemar.org`
- Never use the manifest's direct `url` field for downloads. Always build `data.nemar.org/<id>/<v>/<bids-path>`.
- This puts the Worker in the chain so it can set `Content-Disposition` (filename preservation, tracked at nemar-cli#513).

### Backend reuse: don't reimplement filters
- `api.nemar.org/datasets` supports `limit`, `offset`, `search`, `modality` (single), `sort`. Use those.
- Filters the API doesn't support (multi-modality AND/OR, ranges) apply *client-side per page only* — a known tradeoff with offset pagination, documented in `.context/handoff.md`.

## [NEVER DO THIS]

- Never use `npm`, `pnpm`, or `npx`; always `bun` / `bunx`
- Never change `imageService: "passthrough"` to anything else (sharp breaks Workers)
- Never use mocks, stubs, or fake data in tests
- Never commit `.env` or credentials. The `CLOUDFLARE_API_TOKEN` is read from the environment by `cfman`, never write it to a file in this repo.
- Never use the manifest's direct `url` field for download links — route through `data.nemar.org/<id>/<v>/<path>`
- Never use emojis in commits, PRs, or code
- Never carry forward review findings as "deferred"; file an issue and link it

## Backend dependency map

Open dependencies blocking work in this repo:

| Issue | Blocks | Status |
|---|---|---|
| `nemar-cli#511` | Phase 3 — `/qa/*` endpoint for QualityPanel + Vis modal data | not started |
| `nemar-cli#512` | `on*` detail page right rail (sparse metadata.json + catalog row) | not started |
| `nemar-cli#513` | BIDS-shaped download filenames (currently SHA-named) | not started |
| `nemar-cli#653` | `license` on catalog rows → Discover license tier filter (color works today; filtering is a guarded no-op until this lands) | not started |
| `nemar-cli#910` | Settings self-service (#132/#135) — expose `given_name`, `family_name`, `orcid`, `orcid_verified`, `github_username`, `city`, `country`, `affiliation` on `/auth/me` (today: id/email/role/status only). Name backfill is nemar-cli#836; profile columns are migrations 0051/0052 | not started |
| `nemar-cli#911` | Settings self-service email change (#133) — `POST /auth/email/change/{request,verify}`, reuse `auth_codes` + email sender | not started |
| `nemar-cli#912` | Settings self-service profile edit (#135) — `PATCH /auth/profile` (github_username/city/country/affiliation; enforce city/country non-empty) | not started |
| `nemar-cli#913` | Settings ORCID re-link (#134) — callback must replace an existing identity for the current user (today a different iD returns `orcid_already_have`). `POST /auth/orcid/unlink` already exists (nemar-cli#832) | not started |

The frontend has fallbacks for all of these so the site ships standalone. When any upstream lands, no frontend change is needed (those are already wired through correct paths — `Dataset.license` is already an optional field).

## Quick Commands

```bash
bun run dev                   # http://localhost:4321
bun run build && bun run preview
bun run typecheck             # 0 errors required before commit
bun run test                  # 87/87 unit tests at last count
bun run lint                  # biome check
```

## Project-Specific Guidelines

- **Astro scoped `<style>` doesn't cross component boundaries.** If two components share row layout (e.g., `BidsTree.astro` and `BidsDirChildren.astro`), duplicate the CSS in both files with a sync comment. Don't try to "DRY" with a global stylesheet — the components are intentionally self-contained.
- **Multi-modality filtering is a known tradeoff.** Server-side offset pagination + client-side AND/OR multi-modality means the `total_count` in the count display reflects server total, not client-filtered count when 2+ modalities are selected. Move AND/OR to the API only when the backend supports it.
- **Logo SVG (`public/nemar-logo.svg`) uses `currentColor`** — themes via parent color inheritance. Don't hardcode fill.
- **Brain hero (`public/hero-brain.png`) uses mix-blend-mode tricks.** Dark mode: `screen` blend; light mode: `filter: invert + multiply`. Don't refactor without verifying both themes.

## Context Files

- `.context/handoff.md` — **latest session state.** Read first when resuming.
- `.context/plan.md` — current tasks and phases
- `.context/research.md` — technical explorations
- `.context/ideas.md` — design concepts
- `.context/scratch_history.md` — failed attempts + lessons
- `.context/decisions/` — **Architecture Decision Records (ADRs).** One file per
  significant, hard-to-reverse decision (`NNNN-short-kebab-title.md`). See
  `.context/decisions/README.md` for the convention and index. Copy `0000-template.md`
  to start a new ADR; number sequentially; never delete an ADR, supersede it. Write one
  when a decision is expensive to reverse, cuts off other reasonable paths, has been argued
  more than once, or embeds a non-obvious constraint. `ideas.md` is where a decision is
  first sketched; promote the ones that meet that bar into an ADR.

## Recording decisions

When you make (or discover) an architecture-level decision, add an ADR under
`.context/decisions/` and link it from that folder's README index. This is part of the
Development Workflow above: land the ADR in the same PR as the change it justifies, so the
rationale travels with the code. Routine choices that are obvious from reading the code do
not need one.

---

Remember: this is a frontend over established backends. The interesting decisions are about *how to surface* what the backend provides, not about new infrastructure.
