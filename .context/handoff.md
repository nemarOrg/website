# Handoff — nemar.org redesign

**Last session:** 2026-05-15. **Resume target:** tomorrow.

## TL;DR — where we are right now

The redesign epic [`nemarOrg/website#1`](https://github.com/nemarOrg/website/issues/1) is in flight on the epic branch. Phases 1+2 are merged into the epic; Phase 3 has an open PR. The site is live on Cloudflare Pages under the SCCN account at the rotating preview URLs; production branch is currently pointed at the epic branch (will swap to `main` after Phase 5).

**Latest deploy:** https://fa9dbfa0.nemar-website.pages.dev (epic branch + design fixes)

## Phase status

| Phase | Issue | PR | Status |
|---|---|---|---|
| 1 — Foundation + Discover | website#2 | #7 | merged into epic |
| 2 — Dataset detail | website#3 | #8 | merged into epic |
| 2 polish | (no issue) | #9 | merged into epic |
| 3 — QA + HED viz (website side) | website#4 | **#11 open against epic** | code complete, render verified with `?qa=fixture`, awaiting nemar-cli#511 backend |
| 4 — Citation Dashboard + Community + Docs | website#5 | not started | next |
| 5 — Live-features arch + cutover | website#6 | not started | last |

## What ships today on the preview

Everything from Phases 1+2 plus a stream of post-merge design fixes:

- Landing: brain hero (legacy `brain-blue.png` recolored per theme via `filter: invert + multiply` in light mode, `mix-blend-mode: screen` in dark), CSS-only twinkle particles, hero stat tiles (645 datasets, 8.9K participants, 5.65 TB), two CTAs (Browse / Contribute → 404 placeholder for the upload flow), themed light/dark with persistence
- Discover: filter sidebar (modality OR/AND, participants range, has-HED, has-QA disabled with Phase 3 pill), **always-on SearchBar** above the cards, server-side offset pagination across all 65 pages (10 per page)
- Dataset detail: header card, action bar (Download zip, **Compute instructions** modal with 3 routes, Issues, GitHub, OpenNeuro), DOI badge with copy, **ProvenanceToggle** (compact chip near the ID — replaces the giant ProvenanceCard) for `on*` datasets, VersionSwitcher, README with GitHub-raw fallback + expand/collapse, BIDS file tree (Vis/View placeholders still tagged "soon" until Phase 3 lands), Right rail with license, BIDS version, modalities, tasks, datatypes, sessions, publish date, authors w/ ORCID, funding, keywords, related identifiers
- Theme toggle cycles system → dark → light → system
- 404 page

## What's pending in Phase 3 (PR #11)

Phase 3 worktree: `/Users/yahya/Documents/git/nemar/website-phase3/` on `feature/issue-4-phase3-qa-hed`.

What's there but not yet merged:

- `src/lib/qa.ts` + 18 unit tests — types for QaAggregates, QaSummary, FileQa, HedSummary; pure helpers (parseLinenoiseDb, buildHistogram, bucketAgesBySex, filePlotUrl)
- `src/components/QualityPanel.astro` — composes the 4 SVG charts + HED wordcloud
- `src/components/PipelineSuccessChart.astro`, `HistogramChart.astro` (×3 instances), `AgeGenderChart.astro` — hand-rolled SVG, no chart-lib dep
- `src/components/HedWordcloud.astro` — log-scaled font sizing, category-colored tags
- `src/components/FileVisModal.astro` — 4-stat strip + 5 SVG plots per `.set` file
- `src/components/FileViewModal.astro` — TSV preview (first 100 rows) with sticky header
- `src/components/BidsDirChildren.astro` — Vis/View `soon` tags replaced with real buttons emitting `data-open-vis` / `data-open-view`
- `?qa=fixture` toggle on `/dataset/[id].astro` for visual dev against captured hallu data (fixtures under `test/fixtures/qa-*.json`)

**Blocker:** [nemar-cli#511](https://github.com/nemarOrg/nemar-cli/issues/511) (hallu QA sync + `/qa/*` route). Phase 3 can ship today as-is — when #511 deploys, the fixture toggle becomes a no-op and live QA flows in. PR #11 should be safe to squash-merge to the epic before the backend lands; the empty-state on a dataset without QA is graceful.

## Open issues filed this session

### nemar-cli
- [#509](https://github.com/nemarOrg/nemar-cli/issues/509) Manifest drops small root files — **merged** as #510
- [#511](https://github.com/nemarOrg/nemar-cli/issues/511) QA sync + `/qa/*` Worker route (Phase 3 backend)
- [#512](https://github.com/nemarOrg/nemar-cli/issues/512) OpenNeuro import doesn't backfill modalities/tasks/subject_count
- [#513](https://github.com/nemarOrg/nemar-cli/issues/513) File downloads return SHA-named instead of BIDS-shaped (needs `response-content-disposition` in presigned URL)

### website
- [#10](https://github.com/nemarOrg/website/issues/10) **Researcher dashboard epic** (auth + upload + manage; sibling to redesign epic)
- [#12](https://github.com/nemarOrg/website/issues/12) Fuzzy/context search engine (Meilisearch/Typesense)

Existing comment thread on nemar-cli: [#448 comment](https://github.com/nemarOrg/nemar-cli/issues/448#issuecomment-4463685705) documenting the major-bump-per-OpenNeuro-pull versioning policy that `ProvenanceToggle` surfaces.

## Worktrees

```
/Users/yahya/Documents/git/nemar/
  website/                       main  — initial commit only; Cloudflare clones this for builds
  epic-website-redesign/         feature/issue-1-epic-nemar-redesign  — production-set branch for Pages
  website-phase3/                feature/issue-4-phase3-qa-hed  — PR #11
```

Build worktree for redeploys: **always** the epic worktree, not the Phase 3 one (until #11 merges).

## Resume commands

### Boot dev locally
```bash
cd /Users/yahya/Documents/git/nemar/epic-website-redesign
bun install     # only if hadn't installed before
bun run dev     # http://localhost:4321
```

For Phase 3 features (QualityPanel + Vis/View modals): use the Phase 3 worktree, hit `?qa=fixture`:
```bash
cd /Users/yahya/Documents/git/nemar/website-phase3
bun install
bun run dev
open "http://localhost:4321/dataset/nm000104?qa=fixture"
```

### Build + redeploy to Cloudflare Pages (SCCN)

```bash
cd /Users/yahya/Documents/git/nemar/epic-website-redesign
rm -rf dist && bun run build
CLOUDFLARE_ACCOUNT_ID=da8d7a2a8680dab01592bbbc6f67f12c \
  bunx cfman wrangler --account sccn pages deploy dist \
  --project-name nemar-website \
  --branch feature/issue-1-epic-nemar-redesign \
  --commit-dirty=true
```

The `CLOUDFLARE_ACCOUNT_ID` is required because the SCCN token doesn't have the `memberships` scope wrangler tries to call. Hard-coded value above is the SCCN account ID from `whoami`.

### Run the test suite
```bash
cd /Users/yahya/Documents/git/nemar/epic-website-redesign && bun run test  # 87/87 expected
cd /Users/yahya/Documents/git/nemar/epic-website-redesign && bun run typecheck  # 0 errors expected
```

### Open the most recent deploy
```
https://fa9dbfa0.nemar-website.pages.dev/
```
Each deploy produces a new hash-prefixed URL; the `nemar-website.pages.dev/` root always points at the most recent production deploy (epic branch right now).

## Pick-up checklist for next session

In rough priority order:

1. **Squash-merge PR #11** to the epic branch once you've eyeballed the deployed preview at the PR's Cloudflare URL. Phase 3 frontend is complete and renders cleanly empty when the backend isn't there yet.
2. **Decide next phase order.** Three reasonable options:
   - **Phase 4** (Citation Dashboard + Community + Docs) — purely website work, ships independently
   - **nemar-cli backend work** — pick one of #511, #512, #513 to unblock Phase 3 fully OR unblock all `on*` detail pages
   - **website#10 — researcher dashboard** — sibling epic; high impact (today's "Contribute your dataset" CTA 404s)
3. **Run `/design-review` against the production-branch preview** if you didn't this session. The compact ProvenanceToggle was a late-stage redesign; deserves a polish look.

## Gotchas to remember

- **Cloudflare Pages production branch is currently `feature/issue-1-epic-nemar-redesign`.** Stays that way until the entire epic merges to `main` (Phase 5 cutover step). Pages dashboard → Settings → Builds & deployments to flip.
- **`imageService: "passthrough"` on the @astrojs/cloudflare adapter is required.** `compile` still bundles sharp into the worker, which the Workers runtime can't run (`process.report.getReport is not implemented`). Don't revert.
- **`formatDate(null)` and `formatRelativeTime(null)` return ""** by design — catalog-only `ds*` rows ship with null timestamps. Don't add stricter types.
- **`getDataset()` unwraps `{dataset: ...}`** — the `/datasets/:id` endpoint returns wrapped, list endpoint returns array. Both shapes flow through the same Dataset type.
- **Discover pagination is server-side offset-based.** Multi-modality AND/OR filtering across selections >1 is a known tradeoff with this pagination model — the `total_count` reflects server total, not client-filtered count. Move AND/OR server-side when the backend supports it.
- **Provenance fallback is in place** but useless for `on005262` because the upstream catalog row also has nulls. Real fix is nemar-cli#512.
- **Download links route through `data.nemar.org/<id>/<v>/<path>`**, not the manifest's direct presigned URL. This puts the Worker in the chain so nemar-cli#513's `response-content-disposition` fix will start producing BIDS-shaped filenames as soon as it deploys, without any further frontend change.
- **Cloudflare token doesn't have memberships scope** — always pass `CLOUDFLARE_ACCOUNT_ID=da8d7a2a8680dab01592bbbc6f67f12c` explicitly with `bunx cfman wrangler --account sccn ...`.

## Files to know

```
src/
  layouts/Base.astro                   nav + footer + theme bootstrap
  pages/
    index.astro                        landing (brain hero + sparkles + stats + CTAs)
    discover.astro                     filter + search + cards + offset pagination
    dataset/[id].astro                 detail (header, prov toggle, switcher, README, BIDS tree, rail)
  components/
    ProvenanceToggle.astro             NEW today — chip + popover replaces the old ProvenanceCard
    SearchBar.astro                    NEW today — reusable; on Discover header + landing hero
    DatasetCard.astro                  card layout (footer band, modality badges, OpenNeuro xref)
    BidsTree.astro / BidsDirChildren   recursive tree, mounts FileVis/View modals (Phase 3)
    DetailRail.astro                   right rail; consumes enrichedMetadata
    ActionBar.astro                    Download/Compute/Issues/GitHub/OpenNeuro + compute dialog
    VersionSwitcher.astro              segmented tab strip + overflow
    Readme.astro                       expand/collapse + manifest/github/description sources
  lib/
    api.ts                             api.nemar.org client; getDataset unwraps {dataset:...}
    data-api.ts                        data.nemar.org client; getLanding/getMetadata/getManifest
    qa.ts                              (Phase 3) types + helpers for /qa/* endpoints
    filters.ts                         URL state ↔ FilterState; multi-modality AND/OR
    provenance.ts                      detectProvenance for on*; listMirrorVersions
    format.ts                          formatBytes, formatDate (null-safe), formatRelativeTime
    bids-tree.ts                       buildTree() folds a manifest into a nested tree
    neuroschema.ts                     types mirroring data.nemar.org/<id>/metadata.json
    markdown.ts                        zero-dep CommonMark subset renderer
public/
  hero-bg.jpg, hero-brain.png          legacy nemar.org hero assets
  nemar-logo.svg                       legacy text + brain + electrodes (themed via currentColor)
test/fixtures/
  qa-aggregates-ds002718.json          Phase 3 fixture for ?qa=fixture toggle
  qa-file-dataqual.json                Phase 3 per-file fixture
  qa-hed-summary.json                  Phase 3 HED wordcloud fixture
```

## Outstanding things I didn't get to test in this session's /browse sweep

- Version switcher tab clicks (only one version per dataset right now, so nothing to switch)
- File modals at full interaction (Phase 3, fixture mode only)
- Mobile viewport (375×812) responsive behavior end-to-end
- Theme toggle across detail + Discover (only tested on landing)
- Citation dashboard / community / docs stub pages (all redirect-or-404 today)
- Keyboard nav through filter sidebar
- Lighthouse / perf scores

Worth a 30-min sweep tomorrow before Phase 4 starts.
