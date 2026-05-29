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

**Deploy target:** Cloudflare Pages, project `nemar-website` on the SCCN Cloudflare account. Production branch is currently `feature/issue-1-epic-nemar-redesign` until Phase 5 cutover, then swaps to `main`.

**Two custom domains on Pages, one build:**
- `ww2.nemar.org` — beta marketing surface (anonymous, cacheable). Skips `/auth/me` entirely. The redesigned Astro build lives here today.
- `app.nemar.org` — authenticated surface (cookie-scoped to this host, no edge cache).
- `nemar.org` (apex) — **still on the legacy F5 origin**, NOT this Pages project. Classified as "marketing" in code so the eventual DNS cutover is a one-line constant flip (`MARKETING_BASE_URL` in `src/lib/host.ts`) plus a redeploy; nothing else changes.

`src/middleware.ts` reads `Astro.url.hostname` and 301-redirects mismatches across known production hosts (e.g. `/dashboard` on `ww2.nemar.org` → `https://app.nemar.org/dashboard`). Anything else (localhost, `*.pages.dev` previews) runs in single-host mode with no redirects so QA stays cheap. Route classification lives in `src/lib/host.ts`. The session cookie is scoped to `app.nemar.org` so it never leaks to `data.nemar.org`, `api.nemar.org`, or `docs.nemar.org`. **Cloudflare Pages dashboard:** custom domains attached to the `nemar-website` Pages project are `ww2.nemar.org` and `app.nemar.org`; the apex `nemar.org` is not attached yet.

**Architecture:** Server-rendered Astro pages at the Worker edge. Three backend services are reused, never reimplemented:
- `api.nemar.org/datasets` — D1-backed catalog list + per-id catalog row
- `data.nemar.org/<id>/metadata.json` — neuroschema v0.3.0 doc
- `data.nemar.org/<id>/<version>/{manifest.json,<path>}` — BIDS-shaped file index + 302-to-presigned-S3 byte access

## Architecture Map

```
src/
  layouts/Base.astro                  shared shell (nav + footer + theme bootstrap)
  pages/
    index.astro                       landing (hero + search + stat tiles)
    discover.astro                    filter sidebar + offset-paginated dataset list
    dataset/[id].astro                detail (SSR fetch fan-out, prov toggle, README, BIDS tree, rail)
    about.astro support.astro
    community.astro citation-dashboard.astro    Phase 4 stubs
    docs/index.astro
    404.astro
  components/                         all .astro components; scoped <style> per file
  lib/                                 typed helpers + clients
    api.ts                            api.nemar.org client (unwraps {dataset:...})
    data-api.ts                       data.nemar.org client (landing/metadata/manifest/README fetch)
    qa.ts                             /qa/* contract (Phase 3, pending nemar-cli#511 backend)
    filters.ts                        FilterState ↔ URL params; modality AND/OR
    provenance.ts                     detectProvenance for on*; listMirrorVersions
    format.ts                         null-safe bytes/date/relative-time/modality split
    bids-tree.ts                      manifest paths → nested TreeNode
    neuroschema.ts                    types mirroring data.nemar.org/<id>/metadata.json
    markdown.ts                       zero-dep CommonMark subset
  styles/
    tokens.css                        CSS variables; light + dark themes
    reset.css global.css
test/
  fixtures/                           qa-aggregates, qa-file-dataqual, qa-hed-summary (Phase 3)
public/                               static logos + brain hero assets
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

## Development Workflow

1. **Check context:** Read `.context/handoff.md` first (it has the most recent session state). Then `.context/plan.md`.
2. **Branch:** `gh issue develop <issue>` for non-trivial work; epic-dev workflow for multi-phase features.
3. **Code:** Follow patterns in this file + the rules. **Component styles are scoped per .astro file** — duplicated layout CSS in nested components is intentional, not DRY-violating (see BidsTree.astro / BidsDirChildren.astro).
4. **Test:** real APIs only. Vitest covers pure helpers in `src/lib/*.test.ts`. Astro page rendering verified via `/browse` against the dev server or a Cloudflare Pages preview deploy.
5. **Commit:** atomic, <50 chars, no emojis, no AI attribution.
6. **PR:** target the epic branch (`feature/issue-1-epic-nemar-redesign`), not `main`, until Phase 5 cutover.

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

---

Remember: this is a frontend over established backends. The interesting decisions are about *how to surface* what the backend provides, not about new infrastructure.
