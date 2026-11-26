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
  layouts/Embed.astro                 chrome-free shell for the embed route (?theme= bootstrap, noindex; ADR 0023)
  middleware.ts                       two-host routing, session (/auth/me proxy), edge cache, security headers, embed call count (ADR 0024)
  pages/
    index.astro                       landing (hero + search + stat tiles)
    discover.astro                    filter sidebar + offset-paginated dataset list
    dataset/[id].astro                detail (SSR fetch fan-out, prov toggle, README, BIDS tree, rail)
    dataset/[id]/collaborators.astro  per-dataset collaborator management (app host)
    dataset/[id]/embed.astro          embeddable signal viewer, the only frameable route (ADR 0023)
    login.astro login/*.astro signup.astro welcome.astro    sign-in (ORCID + email code) + onboarding
    auth/orcid/{start.ts,callback.ts,complete.astro}        ORCID OAuth proxy flow
    cli/authorize.astro               device-auth grant confirm/deny page (epic #1272 phase 2; app host)
    oauth/authorize.astro             sign-in page of NEMAR's OpenID Connect provider: forwards the request and the cookie to the API, then redirects, asks consent or explains a refusal (app host, never cached, not framable; ADR 0031 exempts its POST from the cross-site check)
    api/auth/**                       session-backed proxies: code, email change, profile, unlink, logout, keys
    api/v1/[...path].ts               generic authenticated API proxy
    dashboard.astro                   my-datasets list + publish status (app host)
    upload.astro upload/success.astro upload flow (dropzone + BIDS pre-check + full BIDS validation in a worker + direct-to-storage PUTs)
    settings.astro                    account: name/email/ORCID/GitHub/profile self-service; CLI keys card; compute access card
    compute/index.astro               compute dashboard (app host, ADR 0030): access, balances, usage chart per pool, jobs with Load more, queue waits; each read and panel fails alone
    compute/jobs/[id].astro           one compute job (app host, ADR 0030 E3): timeline, resources and charge, failure sentence, log and result links on request (bearer links minted only by a click), cancel; private no-store, one 404 for absent, foreign or malformed ids; the page the results-ready mail links to
    admin/publication-requests.astro  admin-only (role=admin; 404s for others)
    admin/mail.astro admin/mail/{[id],queues,away}.astro   admin Mail tab: tickets, queues, away windows (ADR 0029); email is escaped text only
    admin/pipelines/{index,[recipe]}.astro admin/pipelines/runs/[stamp].astro   admin Pipelines tab (website#586, nemar-cli ADR 0134 phase 4b, ADR 0030 addendum): coverage cards per recipe, the grid of datasets by checkpoints with filters and paging, one run's checkpoints and failures; read only, never a sync
    admin/pipelines/runs/[stamp]/quality.astro admin/pipelines/runs/[stamp]/quality/[...rest].ts   the run drill-down (website#588 W9, nemar-cli ADR 0137 decision 7): where the run's derivative stands (a sentence per run-quality word, not public, expiry, deferral), its succeeded recordings, and one recording's STORED views drawn by the panel's renderers (`quality-views/admin-drill.ts`), computed views listed only; the same-origin proxy of the admin mount (`quality-views/admin-proxy.ts`, every obligation of nemar-cli's docblock, test/quality-admin-proxy.test.ts); a public link only for a `current` derivative of a dataset public now
    admin/compute.astro               admin Compute tab (website#497, ADR 0030): Requests (grant, deny, suspend, revoke by id, each through ComputeDecisionDialog) and read-only Pools, Usage, Flagged jobs, Reconciliation; a section the backend does not serve says so and links its nemar-cli issue; nothing owner-only or cost-bearing is offered
    about.astro support.astro community.astro
    og/** robots.txt.ts 404.astro
  components/                         all .astro components; scoped <style> per file
    EegViewerNav.astro                subject/task/prev/next markup shared by the viewer dialog and the embed
    quality/DatasetQualitySummary.astro   the dataset quality summary in DatasetTabs' Data quality tab (W5), drawn on the server from metadata.json's `extensions.dataQuality` by `quality-views/dataset-summary.ts` (checked whole, or one sentence saying why not; stored text only); the tab exists only when there is something to show, and the embed route never reaches it (test/quality-summary-pages.test.ts)
  lib/                                 typed helpers + clients
    api.ts / api-base.ts              api.nemar.org client (unwraps {dataset:...}); env-aware base
    api-fetch.ts request-context.ts   server calls to the API over a service binding naming the visitor (ADR 0026); the per-request context (waitUntil, binding, visitor, stale flag) the middleware opens
    api-cache.ts                      catalog reads cached for minutes to hours, stale copies kept three days (ADR 0025)
    data-api.ts / data-base.ts        data.nemar.org client (landing/metadata/manifest/README fetch)
    auth.ts auth-dev.ts auth-proxy.ts orcid-proxy.ts   session types/helpers, dev mock session, backend proxies
    dashboard-api.ts admin-api.ts collaborators-api.ts upload-client.ts   authenticated API clients
    mail-admin-api.ts                 admin Mail client (browser-safe): tickets, queues, away window, reply failure classes, badge count, staff directory
    mail-admin-contract.ts            hand copy of nemar-cli shared/contract/mail-admin.ts (drift-tested, test/mail-admin-contract-drift.test.ts)
    compute-api.ts compute-contract.ts   browser-safe client for GET /compute/me, /me/usage, /me/jobs (guards copy out only the keys read; a rejected body is a `shape` error, never zeros) and the hand copy of the vocabulary it needs, the one place the job-state and front-door words live here (drift-tested, test/compute-user-contract-drift.test.ts; extractors in test/compute-contract-drift.ts)
    compute-instructions.ts           the dataset page Compute dialog as data (website#498, ADR 0030 E5 addendum): a pure builder from id, version, anonymous, unpublished and the release gate into `closed`, `not_available` or `ready` steps of copyable `nemar compute` commands; no URL, limit or machine in it; pinned to the captured CLI help by test/compute-instructions-cli-parity.test.ts
    compute-view.ts compute-labels.ts compute-badges.ts   pure view models (panelsFor, access, balances, queue, jobRowView, usage), the page's short labels (sentences live in account-copy.ts), job-state badges
    compute-format.ts compute-chart.ts   integer milli-SU formatting (`suFixed`: the CLI's three-decimal digits; `formatSu`: the shortest exact decimal, the same rule as nemar-cli's `formatSu`) and the usage chart geometry (nice ceiling from the stacked total, hand-rolled SVG, ADR 0007)
    compute-jobs-dom.ts               builds appended job rows with createElement/textContent only
    compute-job-view.ts compute-logs.ts compute-failure.ts compute-copy.ts   the job page's pure modules (E3): timeline, canCancel, retention window, results rows, cancel outcome words and the polling schedule (`nextPoll`, no clock); `prepareLog` (ANSI stripped, hostile characters written out, long lines capped); one sentence per failure code; the website-owned sentences
    compute-job-dom.ts compute-job-page.ts compute-job-live.ts   the job page's browser side: nodes from the same view models (createElement and textContent only), the controller (poll, log, results, cancel), and the ONE job module that reads a clock or holds a timer
    compute-admin-api.ts              admin Compute client (browser-safe): access list and decisions by id, pools, jobs by flag, unmatched accounting rows, access report, status, the badge count; { error, code } reader, decision failure classes, no POST retry
    compute-admin-contract.ts         hand copy of the closed lists the Compute tab branches on, and of the decision notice rule `computeAccessNoticeProblem` (drift-tested, the rule text for text, test/compute-admin-contract-drift.test.ts, strict via NEMAR_CLI_COMPUTE_ADMIN_CONTRACT)
    compute-admin-view.ts             pure view models for the Compute tab: request row, allowed buttons, decision and failure sentences, pool and job rows, parameters, pager
    compute-decide-flow.ts            one decision in flight page-wide; one re-read after an outcome that cannot be told
    compute-pipeline-api.ts compute-pipeline-contract.ts   admin Pipelines client (the three read routes, open guards, no sync) and the hand copy of the grid words, bounds and patterns (drift-tested, test/compute-pipeline-contract-drift.test.ts)
    compute-pipeline-view.ts compute-pipeline-labels.ts   the tab's pure view models (status pills, cell codes, filters, pager, coverage cards) and its website-owned words, pinned to the captured CLI help by test/compute-pipeline-cli-parity.test.ts
    mail-display.ts                   escape set for ticket text, thread order, reply draft state machine and its sessionStorage form
    device-auth-api.ts                device-authorization grant client: lookup/confirm/deny, list keys
    device-authorize.ts               pure view model for /cli/authorize (no mirrored refusal vocabulary)
    device-authorize-dev.ts           astro-dev stand-in for the device-auth + keys backend (epic #1272 phase 2)
    oidc-authorize.ts                 pure view model and decision logic for /oauth/authorize (request parsing, outcomes, redirect and panel status, wording keys)
    oidc-authorize-api.ts             server client for the API's POST /auth/oidc/authorize and /auth/oidc/consent; its answers are read only by the page's server code
    origin-check.ts                   `crossSiteFormRefusal`: the site's own cross-site form check, run first by middleware.ts (Astro's `checkOrigin` is off; ADR 0031)
    bids-precheck.ts                  hand-rolled client-side BIDS structural pre-check (upload); the instant check that runs before the validator
    bids-validation/                  full BIDS validation on /upload (#161, ADR 0028): worker client, gate (the repository check's rule), report, panel, wording; protocol.ts is shared with the worker bundle and imports nothing
    flags.ts                          feature flags (ORCID_SIGNIN_ENABLED, WEB_SIGNIN_ENABLED, ...)
    host.ts                           two-host route classification + noindex/production host logic
    embed.ts                          embed route matcher, ?theme= parser, embed/dataset URLs, iframe snippet
    embed-analytics.ts                pure Analytics Engine data point for an embed call (dataset, embedding host, kind) and whether a response counts; written by middleware.ts (ADR 0024)
    age-buckets.ts                    `bucketAgesBySex` and `pickAgeBuckets` for the Demographics chart (render-age-gender.ts)
    filters.ts                        FilterState ↔ URL params; modality AND/OR; license tier
    tags.ts                           modality/license/keyword classification + /discover hrefs
    provenance.ts                     detectProvenance for on*; listMirrorVersions
    format.ts                         null-safe bytes/date/relative-time/modality split
    bids-tree.ts                      manifest paths → nested TreeNode
    neuroschema.ts                    types mirroring data.nemar.org/<id>/metadata.json
    markdown.ts                       zero-dep CommonMark subset
    eeg-viewer/                       WebGL EEG viewer (traces, topo, montages, recording nav, background preload, HED/SCORE annotation authoring)
    eeg-viewer/viewer-session.ts      live instance + recording nav + ?view= + share controls, shared by dialog and embed
    eeg-viewer/scalp-map.ts           the live topomap on `nemar.sensor-field.v1` (ADR 0035 decision 5): own positions through `nemar.sensor-layout.v1`, else template positions by channel name with `nemar.sensor-labels.v1` (placed the first time the map is shown; the store carries no cap model yet, so EGI nets show `cap_model_unknown`, nemarOrg/nemar-cli#2407), drawn in the quality views' worker; every refusal leaves the map undrawn with its sentence
    quality-views/                    quality views drawn in the browser (nemar-cli ADR 0137, ADR 0035); vocabulary/ holds registry.json and pin.json, copied by digest from nemar-cli's vendored neuroschema by `bun scripts/copy-quality-views-vocabulary.mjs`, never hand-edited (test/quality-views-vocabulary-drift.test.ts); vocabulary/montages/ holds neuroschema's montages and their PROVENANCE.json the same way (licenses in public/licenses/quality-views/NOTICE.txt)
    quality-views/montages.ts montage-loader.ts   reads one `nemar.montage.v1` file strictly; fetches one montage per lazy chunk (`loadMontage`), whose center `sensorLayout` takes as `montageCenter`
    quality-views/sensor-field.ts sensor-layout.ts sensor-names.ts linalg.ts   `nemar.sensor-field.v1` (EEGLAB's v4 scalp map) and `nemar.sensor-layout.v1` (3D positions to layout), held to neuroschema's vectors by the test/quality-views-*-parity tests; sensor-names.ts is the part of `nemar.sensor-labels.v1` the layout reads
    quality-views/sensor-labels.ts sensor-labels-copy.ts   `nemar.sensor-labels.v1`, sensor positions inferred from channel names (pure, worker-safe; the caller loads the fourteen montages names reach, `loadNameMontages`; `countCandidates` refuses too few channels with no montage), held to every case of sensor-labels.v1.json by test/quality-views-sensor-labels.test.ts; sensor-labels-copy.ts is the one copy of its refusal sentences and `montage_unavailable`'s, read by render/words.ts and the viewer
    quality-views/worker.ts worker-protocol.ts worker-client.ts   the module worker that draws a view's maps (geometry cached by layout SHA-256, maps on screen first, the algorithm's Float64 grids transferred, contours for maps on screen); the client imports no interpolation; a page shares one client (`sharedSensorFieldClient`), warms it on a synthetic layout when a panel mounts (`warm()`, 16 maps in batches of 8) and prepares the real geometry when the layout arrives (`prepare`), the cold first view of website#592; budgets gated in CI by `bun run test:quality-views-perf` (alone on the runner) and `scripts/check-quality-views-size.mjs` (after `astro build`, from each lazily imported chunk that reaches the client; `quality-views-size-lib.mjs`), and timed in a browser by e2e/quality-views-perf.spec.ts
    quality-views/contours.ts colormap.ts turbo-lut.ts   marching-squares contour lines; the diverging, sequential and Turbo maps (`--qv-*` tokens; their Apache-2.0 notices ship in public/licenses/quality-views/NOTICE.txt)
    quality-views/read.ts guards.ts checks.ts   the TSV and I-JSON readers with the generic kinds' words; hand-written guards for the view envelope, every registered kind, the transforms and the contents (no JSON Schema engine on the page), held to neuroschema's verdict corpus by test/quality-views-guards.test.ts; the guards and kinds.ts run in the map worker (`SensorFieldClient.checks()`); the computed presets' schemas are guards-computed.ts, checked on the page (local-checks.ts, a lazy chunk) as is everything when the worker cannot answer; checks.ts holds the types the page uses
    quality-views/kinds.ts model.ts   the renderer rule (C2: kind, else base by its role contract, else tables; never throws) and `buildModel`, the port of neuroschema's `build_model` (builders keyed by `kind@version`; files checked by size and SHA-256 before parsing; a scalp map's layout fetched beside its values and handed to `onLayout` as `warmInput` for `prepare`), held to kinds-models.v1 by test/quality-views-models.test.ts; a map without a layout role is placed by name with `nemar.sensor-labels.v1`, which it imports lazily with the montages names reach, and a montage or chunk that cannot load leaves only the maps undrawn (`montage_unavailable`)
    quality-views/verify.ts tsv.ts    the page's SHA-256 (`subtleSha256`), a file against its recorded size and digest (`verifyBytes`), `nemar.view-digest.v1` (RFC 8785, `viewDigest`), held to neuroschema's view-digest vectors; a TSV role's declared columns under C3 (`readDeclaredTsv`), on read.ts's grammar
    quality-views/dataset-guards.ts dataset-summary.ts   the dataset summary's guards (`dataQuality` at level dataset, the data paper, the document's head) and the writer's rules, held to Ajv's verdicts captured from nemar-cli (`NEMAR_CLI_DIR=<epic #2324 checkout> bun scripts/capture-quality-summary-fixtures.mjs`, test/fixtures/quality-summary/) and to the corpus's data-paper and root cases; `readQualitySummary` and `summaryTree`
    quality-views/tree.ts render/     pure renderers from a model to an element tree (`toHtml` on the server, `toDom` on the page), each its own lazy chunk loaded by `render/index.ts` for its model type: table, lines, heatmap, histogram (one SVG tree for both), scalp maps on the worker and the fallback, each a figure with caption, text alternative, readout of stored text, a data table built on first open, and downloads; W7's activations and W8's exports must be lazy chunks too (the size check enforces it); styles in styles/quality-views.css
    quality-views/panel.ts panel-model.ts panel-bridge.ts panel-words.ts extras/   the dataset page's per-recording quality panel (W6; components/quality/QualityPanel.astro in DatasetTabs' Recording quality tab): picker from the viewer's recording list (`publishRecordings`, the viewer's order), Spectrum / Components / Signal / Other tabs, the deep link `#quality/<recording>/<view key>`, a Turbo toggle; each view's `nemar.view-digest.v1` (verify.ts) compared before it is drawn; each kind's extras a lazy chunk (`extras/`), sentences lazy (`panel-words.ts`); the Signal tab opens the page's viewer with the floor's bad channels and segments marked (`openSignal`, `ViewerOptions.qualityMarks`), checked first by signal-window.ts
    quality-views/route-contract.ts quality-api.ts quality-files.ts record.ts   the public quality route's hand copy (test/quality-route-contract-drift.test.ts, NEMAR_CLI_QUALITY_ROUTE) and its client: a record's ETag digest checked before its text is parsed, its dataQuality record shape and `nemar.record-checks.v1`, three states (none, not on this server yet, failed with a word); fixtures captured by `NEMAR_CLI_DIR=<epic checkout> bun scripts/capture-quality-fixtures.mjs` into test/fixtures/quality-views/route/; `scripts/local-backend.mjs --seed-quality` serves the real route locally
    quality-views/admin-route-contract.ts   the admin mount's hand copy (paths, words, grammar, `qualityAdminForwardPath`, the proxy's obligations), held to nemar-cli by the same drift test; kept apart from route-contract.ts so a dataset page carries none of it
    pipeline-quality-api.ts pipeline-quality-view.ts pipeline-quality-labels.ts   the run-quality client, view model and words (W9); fixtures captured from the real routes by `scripts/capture-run-quality-fixtures.mjs` into test/fixtures/compute/admin-run-quality/ while `scripts/local-backend.mjs --seed-pipeline --seed-quality` runs (it also seeds the drill-down's runs, ids in `.local-backend/quality.json`); browser check e2e/admin-quality.spec.ts with `E2E_LOCAL_BACKEND=1`
    quality-views/preload.ts preloaded.ts prepare-ahead.ts   the idle preload at page load (owner's ruling): after the load event, the viewer's list and an idle callback, unless saveData/2G or a viewer is open, the default recording's record, layout geometry and the Spectrum and Components tabs' files, capped at their bytes, cancelled and forgotten on pagehide; its own chunk, outside the panel's first-screen unions; gated as "panel opened after page load" by test/quality-views-perf.test.ts
    quality-views/presets.ts preset-*.ts signal-window.ts   the presets beyond their bases (spectrum maps, component rows, class counts, signal-window checks), held to preset-checks.v1 and kinds-models.v1's spectrum maps by test/quality-views-presets.test.ts
  styles/
    tokens.css                        CSS variables; light + dark themes
    reset.css global.css
    eeg-viewer.css                    global signal-viewer styles (runtime-built DOM), imported by BidsTree and the embed
    quality-views.css                 the quality views' figures (render/), imported by the panel that draws them and by the dataset summary
vitest.config.ts vitest.astro.config.ts vitest.workspace.ts   two Vitest projects run by `bun run test`: the unit tests, and `test/*.astro.test.ts`, which render `.astro` components through Astro's container, compiled by Astro's compiler in the project's own plugin (Astro 6's Vite config does not load under Vitest 2)
test/
  fixtures/compute/                   captured from the real nemar-cli routes, never hand-written: `NEMAR_CLI_DIR=<Epic D checkout> bun scripts/capture-compute-fixtures.mjs` (access, E1), `bun scripts/capture-compute-read-fixtures.mjs` (me, usage, jobs, errors; E2) and `bun scripts/capture-compute-job-fixtures.mjs` (job, log, results, cancel, refusals; E3, on the backend's lifecycle fixture and Tapis stand-in); `fixtures/compute/cli-help/` is the real `nemar ... --help-all` text the dialog's commands are checked against: `NEMAR_CLI_DIR=<Epic D checkout> bun scripts/capture-compute-cli-help.mjs` (E5)
  fixtures/quality-views/vectors/     neuroschema's parity vectors, copied with the vocabulary above and pinned in its pin.json; tests only, never shipped
  fixtures/quality-summary/           metadata.json from nemar-cli's real route, one dataset per gate (shown, canary only, concealed, withdrawn, tombstoned, never published, private), and dataset-level `dataQuality` documents with Ajv's verdict and the backend's writer rule; captured by scripts/capture-quality-summary-fixtures.mjs, never hand-written
public/                               static logos + brain hero assets (og/ cards are generated, gitignored)
public/brand/                         GENERATED press logo kit (SVG, PDF, transparent PNG; color, reverse, black, white); rebuild with `bun scripts/generate-brand-kit.mjs`, never hand-edit
public/vendor/bids-validator/<ver>/   GENERATED worker bundle of the BIDS validator + SHA256SUMS + provenance + licenses (ADR 0028); never hand-edited
validator-version.json                copy of nemar-cli's validator pin; CI fails when the two differ
scripts/vendor-bids-validator.ts      Deno script that rebuilds public/vendor/ from the pin (not part of `bun run build`)
scripts/bids-validator-worker.ts      the module it bundles (a Deno program, excluded from tsconfig)
```

---

## Backend dependency map

Open dependencies blocking work in this repo:

| Issue | Blocks | Status |
|---|---|---|
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
# Deno, only when the validator pin or its worker sources change (ADR 0028):
deno run -A scripts/vendor-bids-validator.ts            # rebuild public/vendor/ from the committed lock
deno run -A scripts/vendor-bids-validator.ts --relock   # the pin moved: resolve its dependencies afresh
```

## Quick Commands

```bash
bun run dev                   # http://localhost:4321
bun run build && bun run preview
# A built site under `wrangler pages dev dist` meets the API binding's local stub, which answers
# 503: pass `--service API=<worker>`, or use a copy of wrangler.toml without `[[services]]`.
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
   **Gate for the API service binding (ADR 0026):** a release whose `wrangler.toml` carries
   `[[services]]` must not be promoted until the production API (`nemar-api`) runs nemar-cli#1710.
   Bound first, every server call lands in the API's shared unattributed bucket, which is worse than
   before. Rolling back is removing the `[[services]]` block or a Pages rollback.
9. **Verify production**, especially for anything staging structurally could not cover.
   `curl -s https://nemar.org/version.json` should report the clean version just tagged.
   After the release that ships embed counting, load `https://nemar.org/dataset/<id>/embed` once with
   `Sec-Fetch-Dest: iframe` and `Referer: https://smoke.invalid/`, then query `nemar_website_embeds`
   for `blob2 = 'smoke.invalid'` (ADR 0024).

**GitHub sometimes drops pushes to this repository (website#374).** The branch moves, but
nothing runs: no deploy, no bump, no Release, no Cloudflare build, and once a merged PR stayed
open. After merging to `staging` or `main`, check that runs started:
`gh api "repos/nemarOrg/website/actions/runs?head_sha=<sha>" -q .total_count`.
`push-watchdog.yml` replays a dropped push within about twenty minutes and comments on
#374; it cannot start Cloudflare's production build, which you retry from the dashboard.

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
- Use the manifest's stable `url` field for downloads; it points through `data.nemar.org/<id>/<v>/<bids-path>`.
- Preserve that route through the CDN so the Worker can set `Content-Disposition` (filename preservation, tracked at nemar-cli#513). Do not replace it with a storage URL.

### Backend reuse: don't reimplement filters
- `api.nemar.org/datasets` supports `limit`, `offset`, `search`, `modality` (single), `sort`. Use those.
- Filters the API doesn't support (multi-modality AND/OR, ranges) apply *client-side per page only* — a known tradeoff with offset pagination, documented in `.context/handoff.md`.

## [NEVER DO THIS]

- Never use `npm`, `pnpm`, or `npx`; always `bun` / `bunx`
- Never change `imageService: "passthrough"` to anything else (sharp breaks Workers)
- Never use mocks, stubs, or fake data in tests
- Never commit `.env` or credentials. The `CLOUDFLARE_API_TOKEN` is read from the environment by `cfman`, never write it to a file in this repo.
- Never replace the manifest's stable `url` with a direct storage URL or redirected origin — preserve its `data.nemar.org/<id>/<v>/<path>` route.
- Never use emojis in commits, PRs, or code
- Never rely on Astro's built-in origin check for a form.
  `security.checkOrigin` is off, and `crossSiteFormRefusal` in `src/middleware.ts` is now the only cross-site request forgery defense for every cookie-authenticated form;
  a new form must keep it working (`test/origin-check-middleware.test.ts` pins it, [ADR 0031](.context/decisions/0031-cross-site-form-check-is-the-sites-own-with-one-exemption.md))
- Never carry forward review findings as "deferred"; file an issue and link it

## Project-Specific Guidelines

- **Astro scoped `<style>` doesn't cross component boundaries.** If two components share styling (e.g., `SiteNotices.astro` and `src/pages/admin/notices.astro`'s matched notice-tone rules), duplicate the CSS in both files with a sync comment. Don't try to "DRY" with a global stylesheet — the components are intentionally self-contained.
- **The BIDS validator is vendored and pinned with nemar-cli (ADR 0028).**
  `validator-version.json` is a copy of nemar-cli's pin, and `test/validator-pin-drift.test.ts` fails CI when nemar-cli `dev` moves it (its bump workflow runs monthly) until you copy the file and run `deno run -A scripts/vendor-bids-validator.ts --relock`, then commit the new `public/vendor/bids-validator/<version>/` and `scripts/bids-validator-worker.lock`.
  `test/bids-validator-vendor.test.ts` fails if `public/vendor/` was edited by hand, or if `scripts/bids-validator-worker.ts` or `src/lib/bids-validation/protocol.ts` changed without a rebuild.
  `protocol.ts` must import nothing at runtime (Deno bundles it), and any relative import it gains needs its `.ts` extension.
  The validator runs in a Web Worker whose Content-Security-Policy is its own header rule in `public/_headers`, which is where its `'unsafe-eval'` lives. Do not put `'unsafe-eval'` in the page policy (`src/middleware.ts`) for it; the page never needs it (`/dataset/*` has its own, ADR 0009).
- **Multi-modality filtering is a known tradeoff.** Server-side offset pagination + client-side AND/OR multi-modality means the `total_count` in the count display reflects server total, not client-filtered count when 2+ modalities are selected. Move AND/OR to the API only when the backend supports it.
- **Logo SVG (`public/nemar-logo.svg`) uses `currentColor`** — themes via parent color inheritance. Don't hardcode fill.
- **The brain hero has a separate image per theme** (`--hero-brain-image` in `src/pages/index.astro`). Dark mode: `public/hero-brain.png` with a `screen` blend. Light mode: `public/hero-brain-light.png` (blue ink on transparent, made from the dark image by `scripts/make-hero-brain-light.py`) with normal blending. The dark image keeps its line work in brightness under a constant 18% alpha, so inverting and multiplying it leaves almost no ink; do not go back to that. Don't refactor without verifying both themes.
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
