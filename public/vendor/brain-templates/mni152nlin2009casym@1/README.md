# Template brain surface, MNI152NLin2009cAsym, version 1

A light left and right hemisphere surface of the Montreal Neurological Institute (MNI) ICBM 2009c
nonlinear asymmetric template, for the intracranial electroencephalography (iEEG) spatial view.
The page fetches it from the same origin, only when a template frame is shown.

## Files

| File | What it is |
|---|---|
| `lh.mesh.bin`, `rh.mesh.bin` | Left and right hemisphere in `brain-mesh v1` (see `src/lib/ieeg-spatial/mesh-format.ts`), millimeters, right-anterior-superior (RAS), the template's own frame |
| `views.json` | Outline of the pair projected on the left, top and front planes, millimeters, for the 2D view |
| `LICENSE.txt` | The MNI copyright notice, verbatim, which must travel with every copy of the surface |
| `provenance.json` | Source files and their hashes, tool versions, parameters, and the hash of the script that built this folder |
| `SHA256SUMS` | `sha256sum -c` format, for every other file here |

## Source and reference

TemplateFlow, template `tpl-MNI152NLin2009cAsym`, the gray matter and white matter probability maps at 1 mm.
Reference: Fonov V, Evans AC, Botteron K, Almli CR, McKinstry RC, Collins DL, Brain Development Cooperative Group. Unbiased average age-appropriate atlases for pediatric studies. NeuroImage 54(1), 313-327 (2011). doi:10.1016/j.neuroimage.2010.07.033.
No FreeSurfer, RAVE, threeBrain or N27 asset is used.

## How it was made

The two probability maps are summed, the 0.5 isosurface is extracted at 1 mm, cut at x = 0 into
hemispheres, reduced to the largest connected piece of each, smoothed (Taubin, 10 iterations) and
decimated to at most 15000 vertices per hemisphere.
The hemispheres are open at the midline where the cut crosses tissue; nothing is capped.
The surface is a template brain, not any subject's anatomy.

## Rebuild

`uv run scripts/vendor-brain-template.py` downloads the sources, checks them against the hashes written in the script, and
rewrites this folder.
Continuous integration never rebuilds it: `test/brain-template-vendor.test.ts` checks the committed
bytes against `SHA256SUMS`.
