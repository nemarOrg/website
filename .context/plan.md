# nemar-website Development Plan

## Project Overview

**Goal:** Redesign nemar.org as an Astro frontend on Cloudflare Pages, reusing the existing `api.nemar.org` (D1 catalog) and `data.nemar.org` (BIDS HTTPS) backends. Replace the legacy Joomla site.

**Epic issue:** [`nemarOrg/website#1`](https://github.com/nemarOrg/website/issues/1)

**Stack:** Astro 6, Bun, Cloudflare Pages (SCCN account), Biome, Vitest, vanilla CSS with tokens.

## Phase status

<!-- Status markers: [ ] pending, [~] in progress, [x] complete, [PR] in review -->

### Phase 1: Foundation + Discover — [x] merged
PR #7. Astro scaffold, design tokens, nav, footer, landing with brain hero + stat tiles, Discover with filter sidebar + cards + offset pagination.

### Phase 2: Dataset detail — [x] merged
PR #8 (main) + #9 (polish). Detail route with header, action bar, README (manifest → GitHub raw → metadata fallback), version switcher, BIDS file tree, right rail with all metadata fields. ProvenanceToggle (compact chip) for `on*` datasets.

### Phase 3: Data quality + HED visualization (website side) — [PR] PR #11
- [x] `src/lib/qa.ts` + 18 unit tests (parseLinenoiseDb, buildHistogram, bucketAgesBySex, filePlotUrl)
- [x] `QualityPanel.astro` composing 4 SVG charts + HED wordcloud
- [x] `PipelineSuccessChart`, `HistogramChart` (×3), `AgeGenderChart`, `HedWordcloud`
- [x] `FileVisModal.astro` (5 SVGs + 4-stat strip) + `FileViewModal.astro` (TSV table)
- [x] BidsDirChildren wires the modals; `Vis · soon` / `View · soon` tags replaced with real buttons
- [x] `?qa=fixture` dev toggle for visual work
- [ ] **Blocked on `nemarOrg/nemar-cli#511`** for the live `/qa/*` route. Frontend can ship behind the fixture toggle today; empty state on missing QA is graceful.

### Phase 4: Citation Dashboard + Community + Docs — [ ] not started
Issue: nemarOrg/website#5.

### Phase 5: Live-features architecture + cutover — [ ] not started
Issue: nemarOrg/website#6.

## Cross-repo dependencies

Backend issues that block parts of this repo (frontend has fallbacks for all three):

- [`nemar-cli#511`](https://github.com/nemarOrg/nemar-cli/issues/511) — QA sync + `/qa/*` Worker route (Phase 3 live data)
- [`nemar-cli#512`](https://github.com/nemarOrg/nemar-cli/issues/512) — OpenNeuro import doesn't backfill modalities/tasks (sparse `on*` rail)
- [`nemar-cli#513`](https://github.com/nemarOrg/nemar-cli/issues/513) — File downloads return SHA-named instead of BIDS-shaped

## Sibling epics

- [`website#10`](https://github.com/nemarOrg/website/issues/10) — Researcher dashboard (signup, upload, manage). Not started; today's "Contribute your dataset" CTA on the landing 404s.
- [`website#12`](https://github.com/nemarOrg/website/issues/12) — Fuzzy/context search engine (Meilisearch / Typesense). Not started; SearchBar component already in place and will transparently switch.

## Active worktrees

```
/Users/yahya/Documents/git/nemar/website                  main
/Users/yahya/Documents/git/nemar/epic-website-redesign    feature/issue-1-epic-nemar-redesign
/Users/yahya/Documents/git/nemar/website-phase3           feature/issue-4-phase3-qa-hed (PR #11)
```

## Next session pick-up checklist

1. Read `.context/handoff.md` (the most recent session state).
2. Squash-merge PR #11 if eyeballed clean.
3. Choose next direction:
   - Phase 4 (website-only, ships fast)
   - Backend issue from the dependency list above
   - Researcher dashboard epic (website#10) — biggest user-facing impact

## Notes

- Production branch on Cloudflare Pages is currently `feature/issue-1-epic-nemar-redesign`. Stays that way until Phase 5 cutover, then swaps to `main`.
- `imageService: "passthrough"` on the Cloudflare adapter is mandatory — sharp doesn't run in Workers. Don't change.
