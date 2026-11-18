# ADR 0033: iEEG contacts use the site's own renderer, template anatomy only where the frame allows, and a credit to RAVE

**Status:** accepted
**Date:** 2026-11-17
**Owner:** Seyed Yahya Shirazi

## Context

The dataset page is to show where the contacts of an intracranial electroencephalography (iEEG) recording sit, beside the signal scope (website epic #537, the intracranial track).
Four choices are expensive to undo once a viewer, an export and a guide rest on them: what draws the contacts, what anatomy goes behind them, what is drawn when a frame has none, and whom the figure credits.

- **The data.**
  The Brain Imaging Data Structure (BIDS) puts contact positions in `_electrodes.tsv` and their frame in `_coordsystem.json`, which the panel reads through the data plane (ADR 0005).
  The public catalog lists 167 iEEG datasets; 97 have usable coordinates, 39 of them under a standard template identifier and 58 only in a native, described, non-standard or undeclared frame (sampled census, 2026-11-17).
  nemar-cli's Zarr converter records electrode positions as declared only: `electrode_positions_source` is `subject` or `dataset`, never measured and never template.
  A template placement is therefore the site's own act, and has to say so.
- **RAVE.**
  The Reproducible Analysis and Visualization of iEEG (RAVE) project, at `rave.wiki`, draws contacts with threeBrain, an R package, and its JavaScript viewer `@rave-ieeg/three-brain`, both under the Mozilla Public License 2.0 (MPL-2.0: `DESCRIPTION` says `License: MPL-2.0`, `package.json` says `"license": "MPL-2.0"`).
  Shipping that code would require that "such Covered Software must also be made available in Source Code Form" and that recipients be told "how they can obtain a copy of such Source Code Form" (section 3.2(a)), and that "You may not remove or alter the substance of any license notices" (section 3.4).
  threeBrain's `inst/CITATION` adds a request, not a condition: "To cite the 3D viewer in publications use, please cite the RAVE paper from Beauchamp's lab" (Magnotti, Wang and Beauchamp, NeuroImage 223, 117341, 2020, doi:10.1016/j.neuroimage.2020.117341).
- **The template.**
  TemplateFlow's `tpl-MNI152NLin2009cAsym/LICENSE` is the Montreal Neurological Institute (MNI) notice, copyright Louis Collins, McConnell Brain Imaging Centre: "Permission to use, copy, modify, and distribute this software and its documentation for any purpose and without fee is hereby granted, provided that the above copyright notice appear in all copies."
- **Size.**
  The site's viewer chunk on production is 161,082 bytes, 56,512 gzipped (measured with `gzip -9`); the threeBrain bundle is 3.81 MB, 1.05 MB gzipped, plus a 0.43 MB, 129 KB gzipped, worker (measured for the plan); both 2026-11-17.

## Decision

1. **The site draws contacts with its own small Web Graphics Library version 2 (WebGL2) renderer and vendors no RAVE or threeBrain code.**
   The module is `src/lib/ieeg-spatial/brain-gl.ts`: no three.js, no Babylon, no new runtime dependency, at most 14 KB gzipped, loaded with the viewer's lazy chunk.
   It takes RAVE's visual vocabulary only (a translucent brain, contacts as spheres sized from the BIDS `size` column, an optional value overlay with a colorbar and a "no data" choice, view presets), and no RAVE code, asset or configuration format.
2. **Anatomy is one vendored MNI152NLin2009cAsym surface, drawn only for standard template frames, and labeled as a template.**
   It is built from TemplateFlow's probability maps by a pinned script and served same-origin from `public/vendor/brain-templates/`, with the MNI notice, a provenance file and checksums beside it (the pattern of ADR 0028), fetched only when a template frame is shown.
   The declared identifier alone decides:

   | Declared frame | Drawn | Labeled |
   |---|---|---|
   | `MNI152NLin2009cAsym` | on the surface, as declared | template brain, not this subject's anatomy |
   | other `MNI152*` identifiers, `IXI549Space` | on the surface, unchanged | template, and approximate |
   | `MNI305`, `fsaverage` | on the surface, through FreeSurfer's MNI305 to MNI152 affine | template, and approximate |
   | `Talairach` | on the surface, through Lancaster and colleagues' Talairach to International Consortium for Brain Mapping 152 affine | template, and approximate |

   No contact is ever snapped or projected onto the surface.
3. **Every other frame is drawn in its own frame, without anatomy, and nothing is guessed.**
   `ACPC`, `ScanRAS`, `Other`, `Pixels`, a non-standard label (`mni`, `MNI`, `MNI152`) and a missing frame draw contacts only, values as written, under "No template placement for this frame"; units of `n/a` add "units not declared".
   The viewer never reads a frame from free text or from numbers that look like MNI, and never fills in a missing one.
4. **Every spatial figure carries the RAVE credit, declared once.**
   The credit is "Electrode view inspired by RAVE", linking to `https://rave.wiki`, its title naming the RAVE paper's digital object identifier; `src/lib/ieeg-spatial/credit.ts` is the only place in the code that writes the words.
   It sits on every live panel, refusals and the embed route included (a plain link is not an action, so ADR 0023 holds), and is painted inside every Portable Network Graphics (PNG) and Scalable Vector Graphics (SVG) export.
   It is NEMAR's voluntary acknowledgment: decision 1 ships no RAVE code, so no license requires it, and its wording must never say RAVE rendered or powers the figure.

## Consequences

- NEMAR owns a small renderer and none of threeBrain's features (volume slices, many templates, subject anatomy); each needs its own decision.
- No dependency and no `'unsafe-eval'` are added: ADR 0009's grant stays where it is.
- 58 of 97 usable datasets show contacts with no anatomy behind them, which looks bare and is deliberate: a bare scatter is accurate, a guessed brain is not.
- No contact is snapped, so one can sit inside or outside the template surface, wherever its declared numbers put it.
- The MNI notice has one condition, "that the above copyright notice appear in all copies", so every copy of the surface travels with its `LICENSE.txt`.
- Only this decision keeps the credit in place, since no license does; removing it needs a superseding ADR.
- Left open by the owner, decided at checkpoint 2 and not here: precomputed activity summaries (Q6, a nemar-cli change), subject anatomy from FreeSurfer derivatives (Q9), a curated mapping for `Other` frames that name a template (Q10; until then they stay native), and an "Open in RAVE" table export (Q11).

## Alternatives considered

- **Vendor threeBrain's JavaScript.**
  Its two MPL-2.0 duties are meetable (notices kept, recipients told where the source is), so the license is not why it lost.
  It lost on size (about twenty times the site's viewer chunk, computed from the figures above); on an undocumented configuration format, generated by R or `threebrainpy`, in a viewer repository that lists one contributor on GitHub; on a world frame that is the subject's FreeSurfer tkrRAS (volume-centered right-anterior-superior); and on a configuration field, `custom_javascript`, that the viewer passes to `eval`.
  RAVE's own BIDS import reads `x`, `y`, `z` as scanner coordinates whatever `coordsystem.json` says (read in RAVE's source for the plan on 2026-11-17, not run).
- **Precomputed images rendered by RAVE in R.**
  It needs an R pipeline run per recording and a host to run it, and the images could not follow the scope's window, switch the overlay or link to the contact list.
- **webR, RAVE's own WebAssembly build (`rave-ieeg/rave-wasm`).**
  It moves RAVE's application, an R runtime included, into the page to draw what one WebGL2 panel draws (size not measured).
  The repository has no license file; only its Electron wrapper's `package.json` says `"license": "GPL-3.0"` (the GNU General Public License, version 3).
- **three.js or Babylon as a dependency.**
  A general scene graph and loaders for one translucent mesh and instanced spheres, the case in which ADR 0007 rejects a library.
- **Place every frame whose numbers look like MNI, or only the surface's own frame (Q4 C, Q4 B).**
  The first guesses a frame the sidecar did not declare; the second hides contacts that the standard identifiers say are placeable.

## Receipts

- Plan: `.context/plans/ieeg-spatial/plan.md` (sections 1 to 3, 6 and 7), held on the track's board branch; the owner's answers to Q1 to Q4 are recorded on its board, 2026-11-17.
- Census note: `.context/research-ieeg-geometry-census.md` (from card IS-A1, which replaces the sampled counts above with exact ones).
- Cards: IS-M1 (#546), IS-R1 (#547) and IS-C1 (#548) merged; IS-K1, IS-T1, IS-V1, IS-V2 and IS-V3 implement these decisions.
- Read 2026-11-17: threeBrain `DESCRIPTION` and `inst/CITATION`; three-brain-js `package.json` and `LICENSE`; TemplateFlow `tpl-MNI152NLin2009cAsym/LICENSE` and `template_description.json` (reference: Fonov and colleagues, doi:10.1016/j.neuroimage.2010.07.033); rave-wasm `package.json`; `src/lib/eeg-viewer/store.ts` (`parseElectrodeProvenance`, the site's reader of `electrode_positions_source`).
- Builds on ADR 0005 (reuse the backends), 0007 (no library for a few visuals), 0009 (route-scoped `'unsafe-eval'`, none added here), 0023 (the embed route's plain link) and 0028 (vendored asset with provenance and license beside it).
