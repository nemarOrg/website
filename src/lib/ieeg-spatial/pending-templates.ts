/**
 * The identifiers of the BIDS appendix's standard template table that have no placement row in
 * `transforms.ts` yet (card IS-V2), each with why and with the evidence that would place it.
 *
 * This is developer-facing data, kept in its own module so none of it ships in the panel's chunk:
 * only tests import it (`transforms.test.ts` pins that no runtime module does). The panel itself
 * only needs to know that a template frame has no row, which `isPendingTemplate` derives from the
 * registry, and `transforms.test.ts` fails when an identifier of the pinned appendix is neither a
 * row there nor an entry here. To place a family, follow "How to add a family" in `transforms.ts`
 * and delete its entry here in the same change.
 */

import type { StandardTemplate } from "./geometry";

/**
 * An identifier of the BIDS table with no row yet. `reason` says what was looked at and why it is
 * not enough; `needed` says what would place it (the source, the relation, the worked example).
 */
export interface PendingTemplate {
  identifier: StandardTemplate;
  reason: string;
  needed: string;
}

function pending(
  identifier: StandardTemplate,
  reason: string,
  needed: string,
): [StandardTemplate, PendingTemplate] {
  return [identifier, { identifier, reason, needed }];
}

const OASIS_REASON =
  "ANTs OASIS-30 template on its own grid (TemplateFlow's description file gives an origin and shape only); nothing found states how its space relates to MNI152.";
const OASIS_NEEDED =
  "A source stating this template's alignment to MNI152 (a matrix or a registration) with a worked point pair.";

/**
 * Researched once on 2026-11-18 in primary sources only (the pinned BIDS appendix, each family's
 * own atlas page, the TemplateFlow template descriptions, FreeSurfer's documentation); none gave
 * a relation to MNI152NLin2009cAsym with a worked example, so none is placed.
 */
export const PENDING_TEMPLATES: ReadonlyMap<StandardTemplate, PendingTemplate> = new Map([
  pending(
    "ICBM452AirSpace",
    "Average space of 452 young adult brains from a 12-parameter affine (BIDS appendix); the LONI atlas page describes it as an average of position, orientation, scale and shear and prints no relation to an MNI152 template.",
    "A primary source printing the 4 x 4 affine from ICBM452 air space to an ICBM152 variant, with a worked point pair.",
  ),
  pending(
    "ICBM452Warp5Space",
    "Defined by a 5th-order polynomial warp of 452 brains (BIDS appendix), so no affine can stand for it, and no source found prints its relation to an MNI152 template.",
    "The polynomial coefficients (or a published point table) to an ICBM152 variant, a new registry kind that applies a polynomial, and a worked point pair.",
  ),
  pending(
    "MNIColin27",
    "One person's average of 27 scans. TemplateFlow's README says it was linearly registered to MNI305 and the BIC page puts it in stereotaxic space, but neither prints the matrix.",
    "The published Colin27 to MNI305 (or MNI152) matrix with a worked point pair; chain it with MNI305_TO_MNI152 if the source stops at MNI305.",
  ),
  pending(
    "NIHPD",
    "One identifier for six age ranges in a symmetric and an asymmetric flavor. The BIC page says each was averaged in MNI stereotaxic space and prints no transform to MNI152, and the identifier does not say which template the positions use.",
    "A way to know the age range and flavor (the dataset's SpatialReference metadata), a published transform from each template to an MNI152 template, and a worked point pair per template.",
  ),
  pending("OASIS30AntsOASISAnts", OASIS_REASON, OASIS_NEEDED),
  pending("OASIS30Atropos", OASIS_REASON, OASIS_NEEDED),
  pending(
    "UNCInfant",
    "Three age cohorts (neonate, 1 year, 2 years) under one identifier, each on its own grid in TemplateFlow's description file; infant brains are smaller than the adult surface, and no source found relates their space to MNI152.",
    "The cohort of the positions (SpatialReference metadata), a published transform from that cohort's atlas to an adult MNI152 template, and a worked point pair; an infant surface may be needed instead.",
  ),
  pending(
    "fsaverageSym",
    "BIDS says its volumetric template is a FreeSurfer variant of MNI305, the sentence fsaverage's row rests on, but FreeSurfer's Xhemi documentation says nothing of fsaverage_sym coordinates in MNI305 space and no worked example is specific to it. Candidate: the fsaverage row.",
    'A FreeSurfer source stating that fsaverage_sym coordinates are the same MNI305 space as fsaverage (or printing its own matrix) with a worked point pair; then add row("fsaverageSym", "affine", MNI305_TO_MNI152, MNI305_APPROXIMATION, ...).',
  ),
  pending(
    "fsLR",
    "A surface template (BIDS lists 164k to 4k meshes) and TemplateFlow holds surfaces only. BIDS says its volumetric template is MNI152NLin6Asym, but a position labeled fsLR may be a surface vertex, and no HCP or TemplateFlow source found prints the relation with a worked example.",
    'An HCP or TemplateFlow source stating which volumetric space fsLR surface coordinates are in, with a worked vertex-to-volume pair; then add row("fsLR", "variant", IDENTITY, VARIANT_APPROXIMATION, ...).',
  ),
]);
