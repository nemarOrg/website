# NEMAR Website — Development Instructions

> Tool-agnostic project instructions for any coding agent (Codex, Cursor, Copilot, Windsurf,
> Claude Code, ...). Claude Code reads this via `@AGENTS.md` in `CLAUDE.md`.

**This file is the rules, not the reference.** What it keeps is what can go badly wrong in THIS
checkout and is not obvious from the code, plus the shape of the code itself. What describes the
platform lives at `docs.nemar.org` and is linked below.

This file was 486 lines, much of it a second copy of material the documentation site already
carried. Two copies drift, which is why nemar-cli ADR 0057 made the docs site canonical. If you
are about to add a paragraph here explaining how part of the platform works, it belongs on
`docs.nemar.org`; add a link here instead.

**Purpose:** the public front door for the Neuroelectromagnetic Data Archive and Tools Resource
(NEMAR). Astro frontend consuming `api.nemar.org` (Cloudflare Workers + D1) and `data.nemar.org`
(BIDS HTTPS view, manifests, metadata), both from `nemarOrg/nemar-cli`.

**Stack:** Astro 6 with `@astrojs/cloudflare`, `output: "server"`,
`imageService: "passthrough"`. Bun for packages (`bun.lock`), Biome for lint and format, Vitest
for unit tests, hand-rolled SVG charts with no chart library.

---

## Retrieval: how to read the linked material

Public pages need nothing: fetch the URL. **Every page also has a Markdown mirror at the same
path plus `.md`**, which is what to fetch if you are a program rather than a browser, and
`https://docs.nemar.org/llms.txt` indexes them.

```bash
curl -s https://docs.nemar.org/develop/website-release.md
```

Pages under `/admin/` are gated: `nemarOrg/docs` is private at source and the gate admits the
`admin` and `owner` roles only. An admin holding a NEMAR CLI key reads one without a browser:

```bash
nemar admin docs admin/operations/systems-inventory
```

---

## If you cannot read something you need

**Open the issue anyway.** Losing read access must not cost you the ability to report a problem
(nemar-cli ADR 0057).

If you hit an admin-adjacent problem, or need a runbook you cannot open, file the issue on the
relevant repository, say plainly what you could not read and what you were trying to do, and tag
**`@nemarOrg/admins`**. Someone with access will either answer or open the page for you.

Escalation replaces read access. **Silence does not.** A blocked agent that stops without saying
so is the failure mode this instruction exists to prevent.

---

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
    cli/authorize.astro               device-auth grant confirm/deny page (epic #1272 phase 2; app host)
    api/auth/**                       session-backed proxies: code, email change, profile, unlink, logout, keys
    api/v1/[...path].ts               generic authenticated API proxy
    dashboard.astro                   my-datasets list + publish status (app host)
    upload.astro upload/success.astro upload flow (dropzone + BIDS pre-check + direct-to-storage PUTs)
    settings.astro                    account: name/email/ORCID/GitHub/profile self-service; CLI keys card
    admin/publication-requests.astro  admin-only (role=admin; 404s for others)
    about.astro support.astro community.astro
    og/** robots.txt.ts 404.astro
  components/                         all .astro components; scoped <style> per file
  lib/                                 typed helpers + clients
    api.ts / api-base.ts              api.nemar.org client (unwraps {dataset:...}); env-aware base
    data-api.ts / data-base.ts        data.nemar.org client (landing/metadata/manifest/README fetch)
    auth.ts auth-dev.ts auth-proxy.ts orcid-proxy.ts   session types/helpers, dev mock session, backend proxies
    dashboard-api.ts admin-api.ts collaborators-api.ts upload-client.ts   authenticated API clients
    device-auth-api.ts                device-authorization grant client: lookup/confirm/deny, list keys
    device-authorize.ts               pure view model for /cli/authorize (no mirrored refusal vocabulary)
    device-authorize-dev.ts           astro-dev stand-in for the device-auth + keys backend (epic #1272 phase 2)
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
    eeg-viewer/                       WebGL EEG viewer (traces, topo, montages, recording nav, background preload, HED/SCORE annotation authoring)
  styles/
    tokens.css                        CSS variables; light + dark themes
    reset.css global.css
test/
  fixtures/                           qa-aggregates, qa-file-dataqual, qa-hed-summary (Phase 3)
public/                               static logos + brain hero assets (og/ cards are generated, gitignored)
```

---

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

---

## Environment Setup

```bash
bun install        # never npm; lockfile is bun.lock
bun run dev        # http://localhost:4321
bun run build      # outputs dist/
bun run test       # vitest unit tests
bun run typecheck  # astro check (must stay green)
bun run lint       # biome
```

## Quick Commands

```bash
bun run dev                   # http://localhost:4321
bun run build && bun run preview
bun run typecheck             # 0 errors required before commit
bun run test                  # 1402/1402 unit tests at last count
bun run lint                  # biome check
bun run bump <arg>            # version bump; workflows normally do this for you
```

---

## Development Workflow

1. **Check context:** Read `.context/handoff.md` first (it has the most recent session state). Then `.context/plan.md`.
2. **Branch:** `gh issue develop <issue>` for non-trivial work; epic-dev workflow for multi-phase features.
3. **Code:** Follow patterns in this file + the rules. **Component styles are scoped per .astro file** — duplicated layout CSS in nested components is intentional, not DRY-violating (see SiteNotices.astro / admin/notices.astro's matched notice-tone rules).
4. **Test:** real APIs only. Vitest covers pure helpers in `src/lib/*.test.ts`. Astro page rendering verified via `/browse` against the dev server or a Cloudflare Pages preview deploy.
5. **Commit:** atomic, <50 chars, no emojis, no AI attribution. Never hand-edit the version
   in `package.json` on a feature branch — the workflows own it (see Versioning above).
6. **PR:** target `staging`, not `main`. See the branch map above — staging leads.
   **`Closes #N` will not close anything.** GitHub only honours closing keywords for PRs
   merged into the *default* branch, which here is `main`; every feature PR merges into
   `staging`. So close the issue by hand after merging, with a comment naming the PR and
   the merge commit. nemar-cli has the identical gap with `dev` — it is how nemar-cli#910
   sat open for a week after shipping, and how #984 and #985 sat open for eleven days after
   being fixed. Do not assume an open issue means unshipped work; check for a merged PR
   that references it.
7. **QA on test.nemar.org:** merging to `staging` auto-deploys there against the nemar-cli `dev`
   backends, and auto-bumps `-devN`. Confirm you are looking at your build with
   `curl -s https://test.nemar.org/version.json` before trusting what you see. Remember
   staging runs in single-host mode, so host-routing and canonical-origin changes are not
   covered here (website#212).
8. **Promote:** run **Prepare release** on `staging` first (it strips `-devN` to the release
   version and re-runs CI + deploy), then open and merge a `staging` → `main` PR with a
   regular merge commit (direct pushes to `main` are rejected — see the promotion note
   above). Production deploys automatically from `main` via the Cloudflare GitHub
   integration, and `release.yml` tags `vX.Y.Z`, cuts the release, and reopens the next
   `-dev0` cycle on staging.
9. **Verify production**, especially for anything staging structurally could not cover.
   `curl -s https://nemar.org/version.json` should report the clean version just tagged.

## Recording decisions

When you make (or discover) an architecture-level decision, add an ADR under
`.context/decisions/` and link it from that folder's README index. This is part of the
Development Workflow above: land the ADR in the same PR as the change it justifies, so the
rationale travels with the code. Routine choices that are obvious from reading the code do
not need one.

---

Remember: this is a frontend over established backends. The interesting decisions are about *how to surface* what the backend provides, not about new infrastructure.

---

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

## Project-Specific Guidelines

- **Astro scoped `<style>` doesn't cross component boundaries.** If two components share styling (e.g., `SiteNotices.astro` and `src/pages/admin/notices.astro`'s matched notice-tone rules), duplicate the CSS in both files with a sync comment. Don't try to "DRY" with a global stylesheet — the components are intentionally self-contained.
- **Multi-modality filtering is a known tradeoff.** Server-side offset pagination + client-side AND/OR multi-modality means the `total_count` in the count display reflects server total, not client-filtered count when 2+ modalities are selected. Move AND/OR to the API only when the backend supports it.
- **Logo SVG (`public/nemar-logo.svg`) uses `currentColor`** — themes via parent color inheritance. Don't hardcode fill.
- **Brain hero (`public/hero-brain.png`) uses mix-blend-mode tricks.** Dark mode: `screen` blend; light mode: `filter: invert + multiply`. Don't refactor without verifying both themes.
---

## Everything else is on the documentation site

| If you need | Go to |
|---|---|
| **How a release reaches nemar.org** | [website releases](https://docs.nemar.org/develop/website-release/) |
| The API this site consumes | [API reference](https://docs.nemar.org/platform/api/) |
| Dataset bytes and byte-range access | [data API](https://docs.nemar.org/platform/data-api/) |
| Which host serves what | [hosts and routes](https://docs.nemar.org/platform/hosts-and-routes/) |
| Account tiers and upload access | [account and access](https://docs.nemar.org/cli/reference/account-access/) |
| DOIs and versioning | [DOI and versioning](https://docs.nemar.org/platform/doi-and-versioning/) |
| What the web surface does, for users | [web guides](https://docs.nemar.org/web/getting-started/) |

Gated, and worth knowing exist:

| If you need | Go to |
|---|---|
| Hosts, deploy procedures, cron schedules | [systems inventory](https://docs.nemar.org/admin/operations/systems-inventory/) |
| `test.nemar.org` and the exemplar fleet | [staging environment](https://docs.nemar.org/admin/operations/staging-environment/) |
| Proven recipes and their gotchas | [validated workflows](https://docs.nemar.org/admin/operations/validated-workflows/) |

**The deploy and staging procedures moved.** They used to run to 133 lines here and are now on
those two gated pages, which `nemar-cli` also points at, so there is one copy rather than two.
What stayed below is the part that is about THIS codebase rather than about the platform: the
host helpers, the cache namespace, and the security headers, which are code you edit here.

---

## Context files, which stay in this repository

- `.context/handoff.md` — **latest session state.** Read first when resuming.
- `.context/plan.md` — current tasks and phases
- `.context/research.md`, `.context/ideas.md`, `.context/scratch_history.md`
- `.context/decisions/` — **ADRs.** One file per significant, hard-to-reverse decision
  (`NNNN-short-kebab-title.md`). See `.context/decisions/README.md` for the convention and the
  index. Copy `0000-template.md`; number sequentially; **never delete an ADR, supersede it.**
  Write one when a decision is expensive to reverse, cuts off other reasonable paths, has been
  argued more than once, or embeds a non-obvious constraint. `ideas.md` is where a decision is
  first sketched; promote the ones that meet that bar.

`.rules/` holds the detailed standards, including the **NO MOCK policy** in
`.rules/testing.md`.

**ADRs stay next to the code they bind** and are not moving to the documentation site.
