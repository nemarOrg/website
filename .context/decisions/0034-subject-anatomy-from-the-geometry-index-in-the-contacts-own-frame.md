# ADR 0034: Subject anatomy comes from NEMAR's geometry index, in the contacts' own frame, never mixed with the template

**Status:** accepted
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
   It is a second option beside the space in the Frame selector, worded "Subject anatomy" (prefixed with the space only when there are several); the template options are unchanged, and the selector is capped in width so the view controls stay on its row.
2. **The subject's surface is drawn in the contacts' own frame and is never mixed with the template.**
   While it is the anatomy, no template row applies: contacts are drawn as declared, the template surface is not loaded, and the 2D views' outline is computed in the browser from the subject's own mesh.
   The option exists only for positions in millimeters under no units banner, since the mesh is in millimeters.
   The surface is drawn as one front shell (back faces culled) at half the template's alpha: a folded pial drawn two-sided stacks to near opaque and hides depth contacts (measured in the browser: 332 amber pixels in light mode and 110 in dark with the template's style, 699 and 379 with the subject's).
3. **The label is honest and in the template-label slot:** "This subject's anatomy, from the dataset's own surfaces", plus "approximate alignment (depth contacts)" for a `plausible` fit and nothing more for `specific`.
   The notes cite the source surfaces from the entry, and a one-hemisphere subject says "Right hemisphere only: the dataset ships one hemisphere for this subject" (or Left).
   PNG, SVG and `views.json` exports carry the same words.
4. **Everything is validated in code, and a mismatch hides the option with one console warning, never a broken drawing.**
   The index is refused whole for another schema or version; an entry is dropped for an unknown hemisphere key, a mesh path that is not its SHA-256, a list of hemispheres that disagrees with its meshes, or a fit that did not pass; a fetched mesh must have the indexed byte count and SHA-256 before the decoder sees it, and the decoded counts must equal the index's.
5. **The index is fetched once per dataset, only while the panel is open, and the first surface waits for it.**
   It is read from the Zarr serving host the viewer already uses (`zarrBase()`, the stable `<host>/<dataset>/zarr/geometry/` path), so no host and no content security policy changes.
   While the index is idle or loading, nothing is loaded or drawn (the loading sentence shows), so a template never flashes before the subject's surface; a 404, 403, invalid index, failure or two seconds end the wait and the template loads, and a late answer still switches to the subject's surface.
   A 404 or 403 means "no subject anatomy" (the data plane answers 403 for a key that does not exist); any other failure that may pass (network, 5xx) is not cached and is retried when the panel reopens.
6. **Integrity failures are permanent, transport failures are retried.**
   A wrong byte count (declared or read), SHA-256, decode or count rejects that surface for the page's life.
   A rejected request or any non-200 answer on a mesh, 403 and 5xx included, shows the failed sentence and is retried on reopening, a frame change or a recording change, as the template's is.
7. **Reads are capped.**
   `index.json` is read to at most 1 MB and 2000 entries; a mesh is read to its indexed byte count, refused before reading when a declared length differs and cut off while streaming when none is declared.

## Consequences

- The viewer can show a subject's own cortex for every dataset the pipeline has written, and says plainly when the alignment is approximate.
- A surface that fails any check is hidden for the page's life; the template (where the frame allows) is the fallback.
- Every template draw waits for one small index request (a 404 for most datasets), at most two seconds.
- Meshes are up to 1.5 MB each (schema maximum), fetched only when chosen and never read past their indexed size.
- The silhouette outline is a rasterized approximation (0.75 mm cells, lightly smoothed), computed once per mesh.

## Alternatives considered

- **Read the subject's FreeSurfer derivatives in the browser.** It needs the volume geometry (`c_ras`), a surface reader and large files per subject, and cannot know whether the surface fits the contacts; the pipeline decides that once, offline.
- **Place the subject's surface on the template, or the contacts on the subject's surface.** Mixing frames is the guess ADR 0033 refuses; contacts are never snapped or projected.
- **Draw it only when the grade is `specific`.** Depth contacts cannot reach `specific`; the label says "approximate" instead.

## Receipts

- Resolves the open item of ADR 0033 on subject anatomy; builds on ADR 0033 (renderer, labels, credit).
- Index schema: `scripts/ieeg_geometry/schema/geometry-index.v1.json` in nemar-cli (frozen).
- Fixture: a real pipeline output for on004473 sub-1 (both hemispheres, ACPC, plausible), decimated to 12,000 vertices per hemisphere, under `test/fixtures/ieeg-subject-anatomy/`.
