# ADR 0028: The BIDS validator runs in the browser from a vendored bundle, in a worker

**Status:** accepted
**Date:** 2026-10-21
**Owner:** Seyed Yahya Shirazi

## Context

The upload page's check (`bids-precheck.ts`) is a hand-rolled scan of structure.
Brain Imaging Data Structure (BIDS) validation proper ran only after the upload, in the dataset repository's check (`run-bids-validation.yml` in `nemarDatasets/.github`: `deno run -A jsr:@bids/validator@<pin> . --json --ignoreWarnings`, where the pin is nemar-cli's `validator-version.json`).
A person learned of a spec violation after moving the whole dataset (#161).
Running the same validator release in the browser, before a byte moves, makes the page, the command-line interface (CLI) and the repository check say one thing.

Four facts decided how, and they are why this is a decision and not a dependency:

1. **The browser entry points exist from 3.x.**
   nemar-cli's pin moved to 3.0.2 (nemar-cli#1036), which exports `@bids/validator/files/browser` and `@bids/validator/validate`.
2. **The package is published on the JavaScript Registry (JSR).**
   Bun cannot install a `jsr:` specifier.
   JSR also serves an npm-compatible registry, `npm.jsr.io`, and Bun installs `@jsr/bids__validator` from it with an `[install.scopes]` entry in `bunfig.toml`; `bun build` of the two entry points gave a bundle that, run in Node on five datasets made from this repository's fixtures, reported the same findings as the Deno build, messages included (the 404 for that name is the default npm registry's, which does not carry the scope).
   That route puts 108 packages in `node_modules` for entry points that use a fraction of them and moves the bundling into the site's own build.
   It was measured as far as Bun and Node and was not built through Astro and Vite.
3. **The validator evaluates code.**
   It evaluates the schema's expressions with `new Function` (`schema/expressionLanguage.ts`) and compiles its JSON checks with Ajv, which does the same.
   The page's policy has no `'unsafe-eval'` (`'wasm-unsafe-eval'`, which it has, is not that).
   Measured in Chrome 155: the validator imported on the main thread of `/upload`, under the real policy, throws `EvalError`.
4. **A worker takes its Content-Security-Policy from its own response**, not from the page that starts it.
   Measured in the same browser, and again in Firefox 158: a module worker from the site's origin ran the validator with the page's policy untouched, and a policy sent with the worker script was enforced inside it (a same-origin `fetch`, another host, a WebSocket and `importScripts` were all refused).
   Safari was not run.

## Decision

1. **The validator is vendored: built with Deno from the pinned release and committed as a static file.**
   `scripts/vendor-bids-validator.ts` (run with `deno`; not a step of `bun run build`) bundles `scripts/bids-validator-worker.ts` with `deno bundle`, with `@bids/validator/` mapped to the release in `validator-version.json`, and writes `public/vendor/bids-validator/<version>/`: the bundle, `SHA256SUMS`, `provenance.json`, and `THIRD_PARTY_LICENSES.txt` (the license of each of the 37 packages it was built from, and of the Node.js shims the bundler adds).
   The build is reproducible: the same pin, sources, lock (`scripts/bids-validator-worker.lock`) and Deno give the same bytes from a cold cache in any directory.
   Code splitting is off because the chunk names it gives come from the Deno cache path.
   Continuous integration (CI) never rebuilds.
   `test/bids-validator-vendor.test.ts` checks the bytes against `SHA256SUMS`, that the first line names the pinned release, and that the two sources and the lock hash to what `provenance.json` recorded, so editing the worker without rebuilding fails.
2. **It runs in a module Web Worker, started when a folder is validated and never on page load.**
   The worker's policy is a header rule in `public/_headers`: `default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src https://raw.githubusercontent.com`, with `Referrer-Policy: no-referrer`.
   The page's policy is unchanged, and this rule is the only place the decision puts `'unsafe-eval'` (a test pins both).
   The one host is the one request the validator can make: a Hierarchical Event Descriptors (HED) schema version it does not ship is downloaded from there.
3. **The pin is nemar-cli's.**
   `validator-version.json` is a copy, and `test/validator-pin-drift.test.ts` compares it with nemar-cli `dev` in CI, as the account-copy tests compare theirs.
   When nemar-cli moves the pin (its bump workflow runs monthly), CI fails here until the file is copied and `deno run -A scripts/vendor-bids-validator.ts --relock` has been run.
4. **The page gates as the repository check gates, and is more lenient in one place.**
   The options are the check's (`maxRows` 1000), except that warnings are kept, because the page lists them.
   An error stops the upload button, a warning never does, and an error whose location is a git-annex pointer file is not counted: a file of fewer than 1024 bytes with a line that starts `/annex/objects/`.
   A browser is not told about symlinks, so the check's other half, symlinks, has no counterpart here.
   The one lenient rule is for a HED schema the browser could not download.
   That error is listed with the warnings and not counted, and the verdict says the HED annotations were not checked, never that no errors were found.
   It is exempt only when the request got no answer at all (offline, a failed lookup, a blocker), which is the browser's failure and not the dataset's.
   `SCHEMA_LOAD_FAILED` is one sub-code for seven conditions of the HED validator, and the others are facts about the dataset that the repository check fails too: no schema specification (HED columns and no `HEDVersion`), an invalid one, library schemas that cannot be merged, and a version GitHub answers 404 for.
   Two more conditions, a bundled copy that does not parse and a local path, cannot come from a browser drop, and stop the upload if they ever do.
   An answer from GitHub, of any status, is the answer the check would get, so it stops the upload like any other error.
   The gate tells the cases apart by the validator's own wording, anchored at the start of the message because the validator quotes a dataset's `HEDVersion` into some of the others.
   The browser's words for a request without an answer differ (`Failed to fetch` in Chrome, `fetch failed` in Node and Deno) and are not matched.
   A wording the gate does not recognise stops the upload, and the tests that run the real bundle fail when a release rewords one.
5. **A validator that cannot run does not stop the upload.**
   No worker, a failed download, a crash, or a run that has not answered in 15 minutes is its own state, worded as "could not run" and never as a pass, and the upload stays possible: the repository check is the authority and this is a convenience.
   The same holds if the panel's markup cannot be bound to its script, so a drift between the two cannot take the upload page down.
6. **The privacy sentence is a rule the browser enforces, where the header is served.**
   The page says the check runs in the browser, that nothing from the files is sent anywhere, and that one exception: a HED schema version that is not built in is downloaded from GitHub, in a request that names only the schema and its version and carries no Referer.
   That is what a run does (no request at all for a dataset whose schema ships; one GET for one whose does not, in a real browser), and what the policy in decision 2 allows and no more.
7. **`.bidsignore` travels with an upload.**
   The dropzone skipped every file whose name starts with a dot.
   `.bidsignore` is the one dotfile BIDS defines and the validator reads, so a dataset that lists its non-BIDS files there could pass neither this check nor the repository check from the browser, with no way to fix it.
   Other dotfiles are still skipped, and the validator prunes dotfiles and dot-directories itself.

## Consequences

- Errors are found before any byte moves, with the repository check's own verdict, and the page's policy gains nothing.
  The worker also keeps the page responsive: 1,204 files and 10,404 findings took 0.8 s from the click, worker start included, and 20,003 files with 135,003 findings took 24 s in the same browser.
- Every move of nemar-cli's pin, at most monthly, breaks this repository's CI until someone re-vendors.
  Each re-vendor replaces a 10 MB file, which is about 1.5 MB of history, and needs Deno on the maintainer's machine (not in CI).
- "The same validator" holds for a release and not for what it resolves.
  The repository check runs the release without a lock, so its dependencies (the schema package, the HED validator, `ignore`, the standard library) are whatever is current when it runs, and the bundle freezes them.
  A patch release of one can change a finding on one side until `--relock` brings the other along, which every pin bump does.
- The bundle is 10,267,556 bytes (1,456,230 with `gzip -9`, 872,874 with `brotli -q 9`), fetched when the first folder is validated and revalidated by ETag after.
  Most of it is the HED validator, in the same file because splitting it would make the bytes depend on whose cache built them.
  The page's own script, which holds the code that drives the worker, grows from 13,783 to 25,031 bytes (4,841 to 8,927 gzipped), and the site's one stylesheet by 4,077 bytes (891 gzipped); nothing else on `/upload` changes.
  The issue asked for an unchanged initial payload, and this is the part that is not: the validator is fetched when a folder is validated, and the page's script is fetched with the page.
- A re-vendor at the same version reuses the URL, `/vendor/bids-validator/<version>/bids-validator-worker.js`, because the version in the name is the validator's and not the file's.
  A browser that holds the earlier bytes is corrected by revalidation and not by the name: Pages answers a static file with an ETag and `cache-control: public, max-age=0, must-revalidate` (as this change's preview deployment did), so each load asks, a changed file is fetched again, and an unchanged one costs a 304.
  A longer lifetime on this path would break that, so the header rule for it carries none and must not gain one.
- A committed build cannot be read as source.
  What stands in for review is `provenance.json`, the lock with its integrity hashes, the reproducible build, and the tests above.
- Node has no `Worker`, so the tests run the committed bytes on real datasets through everything but the message loop (about thirty lines in `scripts/bids-validator-worker.ts`).
  The loop, the policy and the page were exercised in Chrome and Firefox with scripted runs that no CI job repeats; there is no end-to-end harness in this repository (website#435).
- The policy is enforced where the header is served.
  `wrangler pages dev` applies `_headers` as Pages does, and nothing here checks production.
  After a deploy, `curl -sI https://test.nemar.org/vendor/bids-validator/<version>/bids-validator-worker.js` must show the `content-security-policy` and `referrer-policy` of decision 2; without them the worker still runs, and "enforces" in decision 6 no longer holds.
- A HED schema that the validator does not ship needs `raw.githubusercontent.com`.
  If the host cannot be reached the finding is listed, not counted, and the verdict says the annotations were not checked (decision 4); the repository check, running on GitHub, loads the schema after the upload.
  If the host answers with an error, a 503 included, the upload stops until it answers.
  A page that cannot reach GitHub therefore lets through a HED dataset naming a version that does not exist, which only the repository check catches.
- The public upload guide (`docs.nemar.org/web/uploading`) describes BIDS validation as server-side only, with failures that block publication and not the upload. That is no longer the whole of it, so the guide changes with this behavior, in the documentation repository.
- A browser without module workers (before Chrome 80, Safari 15 and Firefox 114) gets the "could not run" state.
- Cancel returns to the folder as dropped.
  A dataset much larger than the 20,003 files measured may take longer, and the CLI remains the path for those.

## Alternatives considered

- **Import the validator from a CDN when the page runs.**
  A script from another origin needs a policy change, and the bytes are whatever the CDN serves that day.
- **Install it from `npm.jsr.io` and bundle it with the site.**
  Viable as far as `bun build`, not built through Astro, and it would add 108 packages to every install and the bundling to every deploy, with Cloudflare's build depending on `npm.jsr.io`; a hashed worker file name also leaves the header rule in decision 2 without a stable path.
  A later ADR can supersede this one with it (tracked in #474): the protocol, the gate, the panel and the tests carry over.
- **Run it on the page with `'unsafe-eval'` on `/upload` (ADR 0009's pattern).**
  One line, but it relaxes the page that holds the session and the attestation, and it freezes the page while the validator runs.
- **Validate on the server (a pre-flight endpoint in nemar-cli).**
  Not before bytes move, and a new backend.
  It stays the option for datasets a browser cannot hold.
- **Grow `bids-precheck.ts` into a validator.**
  That reimplements the schema, which ADR 0005 rules out.
- **Split the HED validator into its own chunk.**
  About 1.2 MB less gzipped for a dataset with no HED, but the chunk names are not reproducible (decision 1).
  Worth revisiting if the bundle ever comes from a bundler with stable names.
- **Count a HED schema download that got no answer as an error.**
  It is what the repository check does when its own download fails, but the browser's download can fail where GitHub's does not, and a person with no way past the error is locked out of the web upload by a failure of the convenience.
- **Exempt every `SCHEMA_LOAD_FAILED`.**
  The first version of the rule.
  Review found that it passes a dataset with HED columns and no `HEDVersion`, which makes no request and which the repository check fails, and that the verdict then said no errors were found.

## Receipts

- Issue #161 and its comments (the spike on 2.x; the move to 3.x in nemar-cli#1036).
- nemar-cli `validator-version.json` and `.github/workflows/bump-validator.yml`; `nemarDatasets/.github` `run-bids-validation.yml`, whose options and annex-pointer rule decision 4 follows.
- Chrome 155 runs (2026-10-21): `EvalError` on the page; the worker with and without the header; no request for a dataset whose HED schema ships, one request (without a Referer) for one whose does not; a HED schema that cannot be downloaded; the same results from the committed bytes under `wrangler pages dev`, which applies `_headers` as Pages does.
  Firefox 158 gave the same results for the policy probe and the validator under `wrangler pages dev`.
- The HED conditions of decision 4, run on the committed bytes (2026-10-21): no `HEDVersion`, an invalid one, two library schemas that cannot be merged, and a version GitHub answers 404 for, in Chrome 155 (the worker served by a Cloudflare Pages preview) and in Node 26; a request with no answer in Chrome (aborted) and in Node 26 and Deno 2.9.7 (`HTTPS_PROXY` at a closed port).
  The validator's words for each are copied into `src/lib/bids-validation/gate.test.ts`, and `test/bids-validator-integration.test.ts` produces the ones that need no network again, so a release that rewords one fails there.
- `src/lib/bids-validation/` (the protocol shared with the worker, the gate, the report, the panel), `scripts/vendor-bids-validator.ts`, `scripts/bids-validator-worker.ts`, `test/bids-validator-integration.test.ts`.
- Builds on ADR 0005 (reuse, never reimplement), ADR 0009 (route-scoped `unsafe-eval`, the pattern not followed here), ADR 0017 (the page's policy).
