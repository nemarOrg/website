# nemar-website Scratch History

Failed attempts, gotchas hit, and lessons that don't fit cleanly into rules yet.

## Astro scoped styles don't cross component boundaries

**Hit:** Mid-Phase 2 PR #9. `BidsTree.astro` defined `.tree__row { display: flex; ... }` and rendered top-level rows fine, but the recursive `BidsDirChildren.astro` rows broke into multiple lines because Astro scopes `<style>` per file.

**Lesson:** When two components share row markup, **duplicate the CSS** in both files with a sync comment. Don't try to lift to a global stylesheet — the per-file scoping is the feature.

**Code reference:** `src/components/BidsDirChildren.astro` (the row CSS block has a comment pointing at the sibling).

## `formatDate(null)` threw and silently dropped cards mid-render

**Hit:** Mid-Phase QA sweep. Discover page 3+ rendered fewer cards than the count said it should.

**Root cause:** `ds*` catalog rows ship with `updated_at: null`. `formatDate(null)` invoked `null.getTime()` and threw. Astro's renderer recovers from per-component throws by SKIPPING the offending component and continuing — so we got 7 cards instead of 10 with no visible error.

**Lesson:** Every helper consumed in the render path must accept nullish gracefully. **Astro silently absorbs render-time exceptions**; the page renders partial output without surfacing the error to the user OR the dev. Always guard date helpers + log warnings instead of throwing.

**Files touched:** `src/lib/format.ts:60-92`

## Cloudflare Pages dashboard build went against `main` (initial commit only)

**Hit:** First deploy attempt. Pages cloned `main` (which had only screenshots), ran `bun run build`, found no `build` script → fail.

**Root cause:** Production branch in dashboard defaulted to `main`, but all the actual code is on `feature/issue-1-epic-nemar-redesign`. The epic-dev workflow keeps phase work off `main` until the whole epic ships.

**Lesson:** When using the epic-dev pattern, set Pages **production branch** to the epic branch until cutover. Swap to `main` only when the full epic merges.

## `imageService: "compile"` still ships sharp to the worker

**Hit:** First successful deploy. Worker bundle failed with `process.report.getReport is not implemented yet`.

**Root cause:** `@astrojs/cloudflare`'s `imageService: "compile"` is documented as "build-time only", but in practice it still imports sharp into the SSR bundle. The Workers runtime doesn't implement `process.report` so sharp imports fail at load.

**Fix:** `imageService: "passthrough"`. We don't use `<Image>` / `astro:assets` anyway.

**Lesson:** Treat the Cloudflare adapter's image config as an Astro escape hatch, not a feature. If you don't use `astro:assets`, set `passthrough` from day one.

## Cloudflare API token without `memberships` scope

**Hit:** `bunx wrangler pages deploy` with the SCCN token → `Authentication error [code: 10000]` on `/memberships`.

**Root cause:** The SCCN token is scoped to specific resources but not the org-level memberships endpoint that `wrangler` queries when enumerating accounts.

**Fix:** Pass `CLOUDFLARE_ACCOUNT_ID=<sccn-account-id>` as env var. Wrangler skips the memberships lookup when account ID is supplied.

**Account ID:** `da8d7a2a8680dab01592bbbc6f67f12c` (SCCN). Now baked into `.context/handoff.md`.

## Browse skill expected Playwright Chromium 1208, system had 1217

**Hit:** First `/browse` call against the dev server.

**Fix:** Install Chromium with `npx playwright install chromium`, then symlink the older version path to the newer one if needed.

**Lesson:** When a skill fails on first run, run its setup. Don't fight the version mismatch in code.

## Mock module bleed across test files (Bun)

**Hit:** Adding regression test for `nemarOrg/nemar-cli#509`. `mock.module("../src/services/github", () => ({...}))` replaced the WHOLE github module export, which broke other test files that needed `ensureMainBranch`, `getCommit`, etc. from the same module.

**Fix:** Always spread the real module first: `mock.module("...", () => ({...realModule, getX: stubX}))`. Confirms Bun's `mock.module` is process-scoped, not file-scoped.

**Lesson:** Module mocking in Bun is global. Always start with `const real = await import(...)` and spread it.

## ProvenanceCard was too prominent

**Hit:** Two iterations after Phase 2. User feedback: "too much emphasis on that".

**Lesson:** When you find yourself building a billboard for a state ("this is a copy of X"), step back and ask if it should be a chip instead. The replacement (`ProvenanceToggle`) is ~10x smaller and reads better.

## Manifest's direct `url` skipped the Worker

**Hit:** User noticed downloaded files had SHA names, not BIDS names.

**Root cause:** The manifest returns presigned S3 URLs directly. Using them as `<a href>` sends users straight to S3, skipping the Worker that could set `response-content-disposition`.

**Fix (partial):** Route file links through `data.nemar.org/<id>/<v>/<bids-path>`. Costs one extra HTTP redirect; gains the ability to fix filenames upstream without a frontend change.

**Filed:** `nemar-cli#513`.

## Deep-page pagination

**Hit:** Discover page 65 returned 0 cards visually, despite "Showing 5 of 645".

**Diagnosis chain:**
1. Initial assumption: empty result. Wrong.
2. Then thought: `applyClientFilters` dropping rows. Also wrong.
3. Actually: `formatDate(null)` throw → silent card drop. See above.

**Lesson:** When Astro renders fewer items than expected, check dev logs for render-time errors **first**, before re-checking server data.
