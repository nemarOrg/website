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
The notice is repeated at the head of the file that holds the table,
and it ships with the site, with the license's full text, in `public/licenses/quality-views/NOTICE.txt` (served at `/licenses/quality-views/NOTICE.txt`).

### ColorBrewer RdBu (quality views)

The diverging color map of a quality view's scalp maps is ColorBrewer's RdBu, reversed (`src/lib/quality-views/colormap.ts`, and the `--qv-diverging-*` tokens in `src/styles/tokens.css`).
Copyright (c) 2002 Cynthia Brewer, Mark Harrower, and The Pennsylvania State University.
Licensed under the Apache License, Version 2.0 (<https://www.apache.org/licenses/LICENSE-2.0>);
distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
This product includes color specifications and designs developed by Cynthia Brewer (<https://colorbrewer2.org/>).
The notice ships with the site in the same file as Turbo's, `public/licenses/quality-views/NOTICE.txt`.

### Electrode montages (quality views and the signal viewer's scalp map)

The montages that place sensors on a scalp map by name are neuroschema 0.6.0's `views/montages`,
copied by digest into `src/lib/quality-views/vocabulary/montages/` (website ADR 0035 decision 2) and shipped in the site's scripts.
Their `PROVENANCE.json`, copied with them, records each montage's source, the digest of its source file and its upstream.

- MNE-Python 1.13.2 writes every montage but the six older EGI nets, under its BSD-3-Clause license (Copyright 2011-2025 MNE-Python authors),
  whose second condition asks a binary redistribution to reproduce the notice, the conditions and the disclaimer.
- The six older EGI nets (`GSN64v2_0`, `GSN65v2_0`, `GSN128`, `GSN129`, `GSN256`, `GSN257`) come from EEGLAB's `sample_locs`;
  EEGLAB's BSD 2-Clause license (Copyright (c) 2024, Swartz Center for Computational Neuroscience) covers `eeglab.m` and its functions folder and states none for `sample_locs`,
  and it is reproduced as well.
- Upstream of those, as `PROVENANCE.json` records: FieldTrip's 10-05 positions (Oostenveld and Praamstra 2001) for `standard_1005`,
  Electrical Geodesics, Inc. (EGI) net layouts for the HydroCel and older nets, and BioSemi's cap layouts; none of them states a license.

Both license texts ship with the site, in `public/licenses/quality-views/NOTICE.txt` beside the color maps' notices,
and `test/quality-views-montages.test.ts` holds them to the texts `PROVENANCE.json` carries.

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
