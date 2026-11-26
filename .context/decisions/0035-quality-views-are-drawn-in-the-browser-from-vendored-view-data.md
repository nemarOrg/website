# ADR 0035: Quality views are drawn in the browser from vendored view data

**Status:** proposed
**Date:** 2026-11-25
**Owner:** Seyed Yahya Shirazi

## Context

nemar-cli ADR 0137 (epic nemarOrg/nemar-cli#2324) decided that NEMAR stores no figure image.
A quality view is declared data, small text tables and JavaScript Object Notation (JSON) files in a run's product, and the browser draws it.
That ADR names this site's renderer, in `src/lib/quality-views/`, as the home of the drawing, and leaves the choices about how the site draws to this one.
Four of them are expensive to undo once panels, exports and the signal viewer rest on them: where the site's copy of the view vocabulary comes from, what the site does with a view it does not know, what a number on screen may come from, and whether the signal viewer's live scalp map keeps its own algorithm.

- **The vocabulary.**
  neuroschema 0.6.0 owns the view vocabulary: the kinds, their roles and dimensions, the transforms, and the parity vectors that hold every implementation of an algorithm to one reference.
  nemar-cli vendors it once, in `shared/contract/neuroschema/views/`, with each file's size and Secure Hash Algorithm 256 (SHA-256) digest in `views/SHA256SUMS.json`.
- **The viewer's map.**
  `src/lib/eeg-viewer/topo.ts` draws the live scalp map with its own thin-plate spline and assumes a coordinate frame when a recording declares none or one it does not know.
  ADR 0137 decision 3 makes NEMAR's map one algorithm, `nemar.sensor-field.v1`, and forbids a silent position guess anywhere a scalp map is drawn.
- **The checkpoints.**
  The admin Pipelines tab (ADR 0030, addendum of 2026-11-23) keeps a hand copy of nemar-cli's standard checkpoints, one of the four copies ADR 0137 counts, and that copy still names `figures`.

## Decision

1. **The site draws every quality view itself, from the view's data, with no chart library, no new dependency and no change to the Content Security Policy (CSP).**
   The code lives in `src/lib/quality-views/`, the scalp map's numerical work in a Web Worker, and the panel in its own lazy chunk (at most 30 KB gzipped, the worker at most 12 KB gzipped (amended, see addendum), both checked after the build).
   ADR 0007 (hand-rolled charts) extends to these views, and ADR 0009's `'unsafe-eval'` stays on `/dataset/*` only:
   the administrator drill-down, whose pages have none, draws only views whose data are stored files and lists the computed ones as drawn on the dataset page once promoted.
2. **The site copies the vocabulary from nemar-cli by digest, one hop, and never edits it.**
   `scripts/copy-quality-views-vocabulary.mjs` copies files from nemar-cli's `views/`, byte for byte, after checking each against nemar-cli's `SHA256SUMS.json`, and writes `src/lib/quality-views/vocabulary/pin.json` with each copy's source path, size and digest and neuroschema's version and commit.
   The registry is shipped (`src/lib/quality-views/vocabulary/registry.json`); the parity vectors are test fixtures (`test/fixtures/quality-views/vectors/`) and are never shipped.
   `test/quality-views-vocabulary-drift.test.ts` holds every copy to its pin on every run, and the pin to nemar-cli `dev` in continuous integration (CI), where a vector nemar-cli adds and the site has not copied fails too.
   A later file the renderer needs (the montages that place sensors by name, for one) is copied the same way, by widening the script's copy rule, never by hand.
   The site reads the vocabulary from nemar-cli, not from neuroschema, so nemar-cli's vendored release is the one the backend, the pipeline and the site agree on.
3. **A view the site does not know is never an error.**
   A known kind at a known version draws its preset; otherwise a known base draws with the generic renderer of that base; otherwise the view's data show as a table with a download.
   The generic kinds each have one renderer and one parity suite against neuroschema's vectors.
4. **Every number on screen comes from a stored row, and every file is checked before it is read.**
   A hover snaps to a stored row and prints that cell's text, and a scalp map's readout is the sensor's stored value, never a grid cell.
   A view file's size is checked before it is fetched and its SHA-256 before it is parsed; a mismatch draws nothing and says so.
   The words for that check say the file "matches the digest NEMAR recorded" and never claim authenticity, since the backend serves both the files and their digests (ADR 0137 decision 6).
   Activations, the one view computed in the browser (`nemar.ic-activity.v1`), are labeled as computed and carry the captions ADR 0137 decision 9 fixes.
5. **The signal viewer's live scalp map moves onto the same code, and guesses no frame.**
   The viewer's map is drawn by `nemar.sensor-field.v1`, held to neuroschema's vectors, and its positions come from `nemar.sensor-layout.v1` for a known coordinate system or from `nemar.sensor-labels.v1` by electrode name otherwise;
   when neither places the sensors, no map is drawn and the reason is shown.
   The precedence and refusal words of ADR 0137's amendment of 2026-11-24 decide which source is used and what a refusal does: `frame_not_scalp` has no fallback to names, names replace refused positions only when every drawn row is typed electroencephalography (EEG), and `unused_positions` keeps the reason the positions were not used.
   The thin-plate spline and the viewer's assumed frame are removed, and the intracranial contact view's colors (ADR 0033) are unchanged.
6. **`figures` leaves the site's copy of the standard checkpoints.**
   `STANDARD_CHECKPOINTS` in `src/lib/compute-pipeline-contract.ts` is `import`, `preprocess`, `ica`, `iclabel`, `quality`, `stored`, as nemar-cli's is; an old run that reports `figures` shows the word raw, with no anchor.
7. **Colors, accessibility and exports are the site's.**
   Colors are design tokens, with a colorblind-safe diverging map, a sequential map and a turbo toggle whose lookup table carries its Apache-2.0 notice.
   Each view is a `figure` with a `figcaption`, an `aria-label` built from stored rows, a data-table toggle and a text row per component.
   Exports are made only on request, as Portable Network Graphics (PNG) with text chunks or Scalable Vector Graphics (SVG) with metadata, each naming the view's digest (`nemar.view-digest.v1`), its kind and version, and a permalink.

## Consequences

- The site owns a small renderer, a worker and their parity suites; a drawing bug is fixed here once and every view redraws.
- About 7 MB of parity vectors sit in `test/fixtures/quality-views/vectors/`, marked generated in `.gitattributes`; a re-copy is reviewed through `pin.json`.
- The vocabulary drift test is red in CI on the epic's pull requests until nemar-cli `dev` carries neuroschema 0.6.0, the accepted pattern of the Phase 4b drift test: nemar-cli `dev` merges first and website `staging` second.
- Some maps the viewer draws today, from an assumed frame or from a handful of matched labels, disappear, each with its reason.
- Public pages show quality only for derivatives an administrator has promoted (ADR 0137 decision 7).
- A view that misses the drawing budgets (one view at 128 channels within 100 milliseconds once its data arrive, and at 256 within 300) is fixed in the renderer; a binary data format needs a new nemar-cli ADR and a measurement.

## Alternatives considered

- **Show stored images:** ADR 0137 rejected them; they cannot follow the theme, be read aloud, or be checked against their numbers.
- **A chart or plotting library:** the same reasoning as ADR 0007, and every parity suite would test the library's drawing instead of NEMAR's algorithm.
- **Copy the vocabulary from neuroschema directly:** a second vendoring hop could pin another release than the backend and pipeline read.
- **Hand-write the site's view vocabulary:** a hand copy of the kinds and transforms drifts silently; a copy pinned by digest cannot.
- **Keep the viewer's thin-plate spline beside the new map:** two maps of one field would disagree on screen, and the spline's assumed frame is the silent guess ADR 0137 forbids.

## Receipts

- nemar-cli ADR 0137 and its amendment of 2026-11-24; ADR 0134, which it partly supersedes.
- neuroschema 0.6.0 (`docs/views.md`, `docs/views/`), vendored in nemar-cli at commit e09ed407 of neuroschema.
- The live-views phase plan for epic nemarOrg/nemar-cli#2324, website phases W1 to W9; website#588.
- Website ADRs 0007, 0009, 0030 and 0033.

## Addendum 2026-11-25: the per-recording panel (phase W6)

- **Where it lives.** The panel is the dataset page's Recording quality tab, shown only when the dataset's quality summary (metadata.json `extensions.dataQuality`) names a recipe, nemar-ica first. Its recording picker is the signal viewer's recording list, in the visitor's order, restricted to recordings a quality record can name.
- **What is checked before a view is drawn.** The record's bytes against the digest its answer names (the `ETag`, required from the data plane; see below) before its text is parsed; its envelope, its `dataQuality` record shape and `nemar.record-checks.v1`; each view's `nemar.view-digest.v1` against the one the route computed; each file's size and SHA-256 before it is parsed. A failure draws nothing of what it covers and says why.
- **The deep link** is `#quality/<recording path>/<view key>`, each segment percent-encoded; a view key holds no dot and a recording name always does, so the last segment tells them apart. It is the link an export's permalink carries (decision 7).
- **The floor's decisions in the viewer.** The Signal tab opens the page's signal viewer on the window a `nemar.signal-window` view names, the floor's bad channels marked and its bad segments shaded; the view's checks run against the store once it is open and before anything is drawn, and a refusal shows its sentence in place of the traces.
- **The idle preload and the size budget.** At page load, in idle time, the page preloads the default recording's record, its layout's geometry and the files of the Spectrum and Components tabs (the owner's ruling of 2026-11-25), capped at those files' bytes, never on a data-saving or 2G-class connection, never while the viewer is open, and forgotten when the visitor leaves. Its code is a chunk of its own that is parsed in idle time before the panel opens, so the panel's first-screen unions leave it out, with the island script and Vite's preload helper that load with the page; it is measured on its own. The gate is the real site build, as decision 1 says ("checked after the build"): each tab's first-screen union at 30 KB on the main thread (a panel opened by a deep link before the preload has run, with the record's reader, included) and the worker with its lazy chunks at 16 KB. The site's own Vite building the modules as an entry is printed and not gated: its unions carry the build's own entry chunk and a few dozen bytes of headroom, which W7's first commit would break.
- **The worker's budget is 16 KB** (amends decision 1 for phase W7). The worker, together with the lazy chunks a single tab loads, stays at or under 16 KB gzipped; the main thread's budget stays at 30 KB.
- **The record's digest is required.** From the data plane, a record whose answer carries no readable `ETag` digest is refused (`record_digest_missing`); the route exposes the header to the site's origins (`Access-Control-Expose-Headers: ETag`, nemarOrg/nemar-cli#2400, in the nemar-cli epic at 311c71fa). Only local development, a loopback data plane, reads a record without it. The website epic must not reach `dev` before the nemar-cli epic, which deploys that header.

## Addendum 2026-11-25: activations (phase W7)

- **Where the work runs.** The Activations tab is a lazy chunk of the panel (`extras/activity.ts`, with `activations.ts`). On the main thread it checks the view's kind and declaration, fetches its three files without reading them, reads the serving copy's level-0 samples, and draws. `nemar.ic-activity.v1` runs in the map worker as a lazy chunk of the worker (`transforms/ic-activity.ts`): checks 2 to 13 of neuroschema's `docs/views/ic-activity.md`, in their order, then the multiply and the display filter. The page reads the store's samples only after the worker's plan has passed every check, and the samples are transferred to the worker. The page runs the transform itself only when the worker cannot start.
- **The serving copy is read with the viewer's own reader.** The page gives the panel the store's address (`registerStoreUrl`); the store reader and zarrita are loaded with a dynamic import, as are the viewer's trace renderer and chrome, which draw the activations. The panel's first screen carries none of them.
- **Size.** The Activations tab's first screen is gated at 30 KB like every other tab, without the chunks the page already loads for its signal viewer (the store reader, zarrita and the trace renderer): those do not count against the tab's budget (the owner's ruling of 2026-11-26). The same union with them is printed, not gated, so their total stays visible.
- **The store digest.** No serving copy publishes a per-group content digest yet (nemarOrg/nemar-cli#2343), so every activation view is drawn as `not_checked`, with that sentence, per the owner's answer to open question 1.
