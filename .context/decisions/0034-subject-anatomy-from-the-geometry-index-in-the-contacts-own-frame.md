# ADR 0034: Subject anatomy comes from NEMAR's geometry index, in the contacts' own frame, never mixed with the template

**Status:** proposed
**Date:** 2026-11-19
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0033 draws contacts over one vendored template brain, only for a standard template frame, and left open "whether to draw subject anatomy from FreeSurfer derivatives".
Many intracranial datasets ship the subject's own FreeSurfer surfaces, and their contacts are declared in that subject's frame, where a template cannot be placed without a guess.
NEMAR's geometry pipeline (nemar-cli, `scripts/ieeg_geometry`) now verifies those surfaces against the contacts and writes the ones that pass, decimated, as `brain-mesh v1` files beside the dataset's Zarr copy: `geometry/index.json` (schema `nemar-ieeg-geometry-index`, version 1) and content-addressed `geometry/meshes/<sha256>.mesh.bin`.
Each entry names the electrodes file it was verified against, the hemispheres present, the source surfaces, and a grade: `specific` (contacts on the cortex agree within 2.0 mm) or `plausible` (depth contacts, an approximate alignment).
Subject surfaces are display data, so a plausible fit is enough to draw them (pipeline plan, ruling 14).

## Decision

1. **The Brain panel offers "This subject's anatomy" for an electrodes file when the dataset's geometry index has an entry whose `electrodes` path equals the file the panel shows, and it is the default for that file.**
   It is a second option beside the space in the Frame selector; the template options are unchanged.
2. **The subject's surface is drawn in the contacts' own frame and is never mixed with the template.**
   While it is the anatomy, no template row applies: contacts are drawn as declared, the template surface is not loaded, and the 2D views' outline is computed in the browser from the subject's own mesh.
   The option exists only for positions in millimeters under no units banner, since the mesh is in millimeters.
3. **The label is honest and in the template-label slot:** "This subject's anatomy, from the dataset's own surfaces", plus "approximate alignment (depth contacts)" for a `plausible` fit and nothing more for `specific`.
   The notes cite the source surfaces from the entry, and a one-hemisphere subject says "Right hemisphere only: the dataset ships one hemisphere for this subject" (or Left).
   PNG, SVG and `views.json` exports carry the same words.
4. **Everything is validated in code, and a mismatch hides the option with one console warning, never a broken drawing.**
   The index is refused whole for another schema or version; an entry is dropped for an unknown hemisphere key, a mesh path that is not its SHA-256, a list of hemispheres that disagrees with its meshes, or a fit that did not pass; a fetched mesh must have the indexed byte count and SHA-256 before the decoder sees it, and the decoded counts must equal the index's.
5. **The index is fetched once per dataset, only while the panel is open.**
   It is read from the Zarr serving host the viewer already uses (`zarrBase()`, the stable `<host>/<dataset>/zarr/geometry/` path), so no host and no content security policy changes.
   A 404 means "no subject anatomy"; a failure that may pass is not cached.

## Consequences

- The viewer can show a subject's own cortex for every dataset the pipeline has written, and says plainly when the alignment is approximate.
- A surface that fails any check is hidden for the page's life; the template (where the frame allows) is the fallback.
- On a template frame the panel may fetch the template before the index answers, then switch to the subject's surface when there is one; the template is cached.
- Meshes are up to 1.5 MB each (schema maximum), fetched only when chosen.
- The silhouette outline is a rasterized approximation (0.75 mm cells, lightly smoothed), computed once per mesh.

## Alternatives considered

- **Read the subject's FreeSurfer derivatives in the browser.** It needs the volume geometry (`c_ras`), a surface reader and large files per subject, and cannot know whether the surface fits the contacts; the pipeline decides that once, offline.
- **Place the subject's surface on the template, or the contacts on the subject's surface.** Mixing frames is the guess ADR 0033 refuses; contacts are never snapped or projected.
- **Draw it only when the grade is `specific`.** Depth contacts cannot reach `specific`; the label says "approximate" instead.

## Receipts

- Resolves the open item of ADR 0033 on subject anatomy; builds on ADR 0033 (renderer, labels, credit).
- Index schema: `scripts/ieeg_geometry/schema/geometry-index.v1.json` in nemar-cli (frozen).
- Fixture: a real pipeline output for on004473 sub-1 (both hemispheres, ACPC, plausible), decimated to 12,000 vertices per hemisphere, under `test/fixtures/ieeg-subject-anatomy/`.
