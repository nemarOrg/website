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
   The code lives in `src/lib/quality-views/`, the scalp map's numerical work in a Web Worker, and the panel in its own lazy chunk (at most 30 KB gzipped, the worker at most 12 KB gzipped, both checked after the build).
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
