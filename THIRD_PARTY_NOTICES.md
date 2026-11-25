# Third-party notices

This file separates what a license requires the site to carry from what the site credits voluntarily.
The two are kept apart so nobody mistakes an acknowledgment for an obligation, or the reverse.

## Required

These notices travel with every copy of the surface they belong to.

### Brain template surface (iEEG spatial view)

The intracranial electroencephalography (iEEG) spatial view draws electrodes over the MNI152NLin2009cAsym template surface,
a Montreal Neurological Institute (MNI) average brain distributed through TemplateFlow (<https://templateflow.org>).
The template ships under the MNI notice, which must accompany every copy of the template files.

- Notice: `LICENSE.txt` in the vendored directory, `public/vendor/brain-templates/mni152nlin2009casym@1/`.
  The vendored files and their notice are added together, so the notice always travels with them.
  It names Louis Collins, McConnell Brain Imaging Centre, MNI, McGill University, as the copyright holder.
- Provenance of the vendored files (source, version, checksums): `provenance.json` in the same directory.
- Reference for the template, to be cited by anyone using it:
  Fonov V, Evans AC, Botteron K, Almli CR, McKinstry RC, Collins DL.
  Unbiased average age-appropriate atlases for pediatric studies.
  NeuroImage 54(1):313-327, 2011.
  doi:[10.1016/j.neuroimage.2010.07.033](https://doi.org/10.1016/j.neuroimage.2010.07.033).

### Brain Imaging Data Structure (BIDS) validator bundle

The in-browser validator is a vendored build of the BIDS validator and its dependencies.
Each bundled component's own license notice is reproduced in `public/vendor/bids-validator/3.0.2/THIRD_PARTY_LICENSES.txt`,
and the bundle's exact dependency versions are in `provenance.json` beside it.

### Turbo color map (quality views)

The scalp maps of a quality view offer Turbo as a third color map (`src/lib/quality-views/turbo-lut.ts`).
Copyright 2019 Google LLC; author Anton Mikhailov.
Licensed under the Apache License, Version 2.0 (<https://www.apache.org/licenses/LICENSE-2.0>);
distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
Modified: the published 256-entry table's channels are rounded to 8 bits.
The notice is repeated at the head of the file that holds the table.

### ColorBrewer RdBu (quality views)

The diverging color map of a quality view's scalp maps is ColorBrewer's RdBu, reversed (`src/lib/quality-views/colormap.ts`, and the `--qv-diverging-*` tokens in `src/styles/tokens.css`).
Copyright (c) 2002 Cynthia Brewer, Mark Harrower, and The Pennsylvania State University.
Licensed under the Apache License, Version 2.0 (<https://www.apache.org/licenses/LICENSE-2.0>);
distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
This product includes color specifications and designs developed by Cynthia Brewer (<https://colorbrewer2.org/>).

## Acknowledged

These credits are voluntary.
No license asks for them.

### RAVE

NEMAR's electrode view in the iEEG spatial view acknowledges RAVE,
the Reproducible Analysis and Visualization of iEEG project (<https://rave.wiki>).
NEMAR draws the view with its own renderer.
**No RAVE code and no RAVE data ships with this site**,
and the wording of the credit never says RAVE drew the figure.

The credit's exact wording and address are declared once, in `src/lib/ieeg-spatial/credit.ts`, in three forms:
a link for each spatial panel,
a painter for PNG exports,
and a fragment for SVG exports.
Every surface that draws the view uses these forms, so the credit is present on screen and inside each exported file.

RAVE asks that users of its 3D viewer cite:

Magnotti JF, Wang Z, Beauchamp MS.
RAVE: Comprehensive open-source software for reproducible analysis and visualization of intracranial EEG data.
NeuroImage 223:117341, 2020.
doi:[10.1016/j.neuroimage.2020.117341](https://doi.org/10.1016/j.neuroimage.2020.117341).
