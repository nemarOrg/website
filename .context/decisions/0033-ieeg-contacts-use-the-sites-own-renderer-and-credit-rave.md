# ADR 0033: iEEG contacts use the site's own renderer, template anatomy only where the frame allows, and a credit to RAVE

**Status:** accepted
**Date:** 2026-11-17
**Owner:** Seyed Yahya Shirazi

## Context

The dataset page is to show where the contacts of an intracranial electroencephalography (iEEG) recording sit, beside the signal scope.
By the owner's decision this is the intracranial track of website epic #537, not a new epic.
Four choices are expensive to undo once a viewer and its exports rest on them: what draws the contacts, what anatomy goes behind them, what is drawn when a frame has none, and whom the figure credits.

- **The data.**
  The Brain Imaging Data Structure (BIDS) puts contact positions in `_electrodes.tsv` and their frame in `_coordsystem.json`, which the panel reads through the data plane (ADR 0005).
  The public catalog lists 167 iEEG datasets; 97 have usable coordinates, 39 of them under a standard template identifier and 58 only in a native, described, non-standard or undeclared frame (the track lead's sampled audit, 2026-11-17).
  nemar-cli's Zarr converter records electrode positions as declared only: `electrode_positions_source` is `subject` or `dataset`, never measured and never template.
  A template placement is therefore the site's own act, and has to say so.
- **RAVE.**
  The Reproducible Analysis and Visualization of iEEG (RAVE) project, at `rave.wiki`, draws contacts with threeBrain, an R package, and its JavaScript viewer `@rave-ieeg/three-brain`, both under the Mozilla Public License 2.0 (MPL-2.0, as `DESCRIPTION` and `package.json` declare).
  If the bundle counts as Executable Form, shipping it would require that "such Covered Software must also be made available in Source Code Form" and that recipients be told "how they can obtain a copy of such Source Code Form" (section 3.2(a), which applies "If You distribute Covered Software in Executable Form"), and that "You may not remove or alter the substance of any license notices" (section 3.4).
  threeBrain's `inst/CITATION` adds a request, not a condition: "To cite the 3D viewer in publications use, please cite the RAVE paper from Beauchamp's lab" (doi:10.1016/j.neuroimage.2020.117341).
- **The template.**
  TemplateFlow's `tpl-MNI152NLin2009cAsym/LICENSE` is the Montreal Neurological Institute (MNI) notice, copyright Louis Collins, McConnell Brain Imaging Centre: "Permission to use, copy, modify, and distribute this software and its documentation for any purpose and without fee is hereby granted, provided that the above copyright notice appear in all copies."
- **Size.**
  On 2026-11-17 the site's production viewer chunk measured 161 KB, 56.5 KB gzipped; the threeBrain bundle, 3.81 MB, 1.05 MB gzipped, plus a 0.43 MB, 129 KB gzipped, worker.

## Decision

1. **The site draws contacts with its own small Web Graphics Library version 2 (WebGL2) renderer and vendors no RAVE or threeBrain code.**
   The module is `src/lib/ieeg-spatial/brain-gl.ts`: no three.js, no Babylon, no new runtime dependency and no `'unsafe-eval'` (ADR 0009's grant stays where it is), at most 14 KB gzipped, in the panel's own lazy chunk, fetched only for an iEEG recording.
   It takes RAVE's visual vocabulary only (a translucent brain, contacts as spheres sized from the BIDS `size` column, a value overlay, view presets), and no RAVE code, asset or configuration format.
2. **Anatomy is one vendored MNI152NLin2009cAsym surface, drawn only for standard template frames, and labeled as a template.**
   It is built from TemplateFlow's probability maps by a pinned script and served same-origin from `public/vendor/brain-templates/` with the MNI notice and a provenance file beside it (the pattern of ADR 0028), fetched only when a template frame is shown.
   The declared identifier alone decides:

   | Declared frame | Drawn | Labeled |
   |---|---|---|
   | `MNI152NLin2009cAsym` | on the surface, as declared | template brain, not this subject's anatomy |
   | other `MNI152*` identifiers, `IXI549Space` | on the surface, unchanged | template, and approximate |
   | `MNI305`, `fsaverage` | on the surface, through FreeSurfer's MNI305 to MNI152 affine, only when the values are in millimeters; under the units banner (a converted unit with every contact over 300 mm from the origin) never placed, which holds for both committed `fsaverage` datasets (on004100, on006253: meters declared over millimeter-sized numbers) | template, and approximate |
   | `Talairach` | on the surface, through Lancaster and colleagues' Talairach to International Consortium for Brain Mapping 152 affine | template, and approximate |

   No contact is ever snapped or projected onto the surface.
3. **Every other frame is drawn in its own frame, without anatomy, and nothing is guessed.**
   `ACPC`, `ScanRAS`, `Other`, `Pixels`, a non-standard label (`mni`, `MNI`, `MNI152`) and a missing frame draw contacts only, values as written, under "No template placement for this frame"; units of `n/a` add "units not declared".
   The viewer never reads a frame from free text or from numbers that look like MNI, and never fills in a missing one.
4. **Every spatial figure carries the RAVE credit, declared once.**
   The credit is "Electrode view inspired by RAVE", linking to `https://rave.wiki`, its title naming the RAVE paper's digital object identifier; `src/lib/ieeg-spatial/credit.ts` is the only place that writes the words.
   It sits on every live panel, refusals and the embed route included (a plain link is not an action, so ADR 0023 holds), and is painted inside every Portable Network Graphics (PNG) and Scalable Vector Graphics (SVG) export.
   It is NEMAR's voluntary acknowledgment: decision 1 ships no RAVE code, so no license requires it, and its wording must never say RAVE rendered or powers the figure.

## Consequences

- NEMAR owns a small renderer and none of threeBrain's features (volume slices, many templates, subject anatomy); each needs its own decision.
- The activity overlay, a value per contact computed in the browser from the visible window, is off by default (the owner's decision); with it off the panel reads no signal samples.
- 58 of 97 usable datasets show contacts with no anatomy behind them, which looks bare and is deliberate: a bare scatter is accurate, a guessed brain is not.
- The MNI notice has one condition, "that the above copyright notice appear in all copies", so every copy of the surface travels with its `LICENSE.txt`.
- Only this decision keeps the credit in place, since no license does; removing it needs a superseding ADR.
- Left open by the owner, to be decided once the panel's real-data validation is done and not here: whether to precompute dataset-level activity summaries (a nemar-cli change), whether to draw subject anatomy from FreeSurfer derivatives, whether a curated, reviewed mapping may place `Other` frames that name a template (until then they stay native), and whether to offer an "Open in RAVE" table export of the contacts.

## Alternatives considered

- **Vendor threeBrain's JavaScript.**
  The duties that bite here (sections 3.2(a) and 3.4) are meetable, so the license is not why it lost.
  It lost on size (about twenty times the viewer chunk, computed from the figures above); on an undocumented configuration format, generated by R or `threebrainpy`, in a viewer repository with one contributor on GitHub; on a world frame that is the subject's FreeSurfer tkrRAS (volume-centered right-anterior-superior); and on a field, `custom_javascript`, that the viewer passes to `eval`.
  RAVE's own BIDS import (`R/class005-subject.R`, `get_bids_electrodes_table`, in `rave-ieeg/ravecore`) reads `x`, `y`, `z` as scanner coordinates (`coord_sys = "scannerRAS"`) whatever `coordsystem.json` says (read 2026-11-17, file unchanged since commit a4fc13a, not run).
- **Precomputed images rendered by RAVE in R.**
  It needs an R pipeline per recording and a host to run it, and the images could not follow the scope's window or link to the contact list.
- **webR, RAVE's own WebAssembly build (`rave-ieeg/rave-wasm`).**
  It moves RAVE's application, an R runtime included, into the page to draw what one panel draws (size not measured).
  The repository has no license file; only its Electron wrapper's `package.json` says `"license": "GPL-3.0"` (the GNU General Public License, version 3).
- **three.js or Babylon as a dependency.**
  A general scene graph for one translucent mesh and instanced spheres: the same reasoning as ADR 0007 gives against a chart library.
- **Place every frame whose numbers look like MNI, or only the surface's own frame.**
  The first guesses a frame the sidecar did not declare; the second hides contacts that the standard identifiers say are placeable.

## Receipts

- Census note: `.context/research-ieeg-geometry-census.md` arrives with card IS-A1 (not yet merged) and replaces the sampled counts above with exact ones.
- Merged cards: IS-M1 (#546), IS-R1 (#547) and IS-C1 (#548); IS-K1, IS-T1, IS-V1, IS-V2 and IS-V3 implement these decisions.
- Upstream files named above, read 2026-11-17; template reference: Fonov and colleagues, doi:10.1016/j.neuroimage.2010.07.033; the site reads `electrode_positions_source` in `src/lib/eeg-viewer/store.ts`.
- Builds on ADR 0005 (reuse the backends), 0007 (no library for a few visuals), 0009 (route-scoped `'unsafe-eval'`), 0023 (the embed route's plain link) and 0028 (vendored asset with provenance and license beside it).
