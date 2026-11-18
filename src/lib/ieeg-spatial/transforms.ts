/**
 * Template anatomy for the iEEG spatial view (card IS-V2, ADR 0033): which declared frames may be
 * drawn on the vendored brain surface, through which cited affine, and what the panel must say
 * while it does.
 *
 * The surface is one MNI152NLin2009cAsym brain (card IS-T1, `public/vendor/brain-templates/`).
 * The declared identifier alone decides what happens to a space (`placementRuleFor`):
 *
 * | Declared frame (BIDS canonical spelling)      | Transform onto the surface                  | Label adds                                                |
 * | --------------------------------------------- | ------------------------------------------- | --------------------------------------------------------- |
 * | `MNI152NLin2009cAsym`                         | none, the surface's own frame               | nothing                                                   |
 * | every other `MNI152*`, `IXI549Space`          | identity                                    | `approximate: MNI template variants differ by a few mm`   |
 * | `MNI305`, `fsaverage`                         | FreeSurfer's published MNI305 to MNI152     | `approximate: MNI305 to MNI152 affine`                    |
 * | `Talairach`                                   | inverse of Lancaster et al.'s pooled MTT    | `approximate: Talairach to MNI affine`                    |
 *
 * Every other identifier of the BIDS table is PENDING (`PENDING_TEMPLATES`): `MNIColin27`,
 * `ICBM452AirSpace`, `ICBM452Warp5Space`, `fsaverageSym`, `fsLR`, `NIHPD`, `OASIS30AntsOASISAnts`,
 * `OASIS30Atropos` and `UNCInfant`. Each says why it has no row yet and what evidence would place
 * it, and the panel says "No template placement yet for X". A test fails when an identifier of the
 * pinned BIDS appendix is neither placed nor pending, so a new standard identifier forces a
 * decision. The appendix's deprecated spellings (`fsaverage3` to `fsaverage6`, `UNCInfant0V21` and
 * kin) stay unknown frames in `geometry.ts` and never reach this registry.
 * `ACPC`, `ScanRAS`, `Other`, `Pixels`, a non-standard label and a missing frame are not
 * template frames at all (`geometry.ts` never promotes them) and read "No template placement for
 * X", and a template frame whose units are not millimeters is not placed either: a scale nobody
 * declared cannot be moved onto a brain.
 *
 * Nothing is snapped or projected: a contact is drawn where its transform puts it, inside the
 * brain or outside it. These are linear approximations between template spaces, not subject
 * anatomy, which is why every state that draws the surface carries the words in `templateLabel`.
 *
 * Sources, each with its worked example pinned by `transforms.test.ts` against the excerpts in
 * `test/fixtures/ieeg-transforms/`:
 *
 * - MNI305 to MNI152: FreeSurfer's CoordinateSystems documentation, item 8, "I have an RAS from a
 *   voxel in MNI305 space (fsaverage space) which I want to convert to MNI152 space". The page
 *   prints the 3 x 4 matrix, the example (10, -20, 35) to (10.695, -18.409, 36.137), the inverse
 *   (item 8b) and its example to (9.3131, -21.5849, 33.8345). It says the MNI152 there is the one of
 *   FSL's standard 2 mm MNI152 template, so the surface (a 2009c brain) is a further
 *   few millimeters away, and the label says "approximate" for that reason too. BIDS names MNI305
 *   as the volume of `fsaverage` (coordinate-systems appendix), hence the same row.
 * - Talairach to MNI: Lancaster JL, Tordesillas-Gutierrez D, Martinez M, Salinas F, Evans A,
 *   Zilles K, Mazziotta JC, Fox PT. Bias between MNI and Talairach coordinates analyzed using the
 *   ICBM-152 brain template. Human Brain Mapping 28(11):1194-1205 (2007), doi 10.1002/hbm.20345.
 *   The paper's Eq. (3), "best-fit MTT transform pooling SPM2 and FSL data", maps MNI to Talairach;
 *   BrainMap's `icbm_other2tal.m` multiplies by it and `tal2icbm_other.m` multiplies by its inverse,
 *   the "other" form being the one for templates other than the SPM and FSL copies, as the 2009c
 *   one is. The paper prints no worked point pair to 0.01 mm; see `transforms.test.ts`.
 *   This is approximate by construction: Eq. (3) is a group-level bias model, fitted on SPM2 and
 *   FSL normalizations of 100 brains, and the landmark disparities left after it are 0.5 to 2.7 mm
 *   (the paper's Table V, MTT columns, 10 brains). A dataset's own Talairach frame may also come
 *   from another pipeline, such as FreeSurfer's `talairach.xfm`, which this row does not model.
 * - MNI variants and IXI549Space: identity, because the BIDS appendix lists them as MNI-space
 *   templates and nothing cited gives a better map. The label says so.
 */

import type { Frame, StandardTemplate, Units, Vec3 } from "./geometry";
import { type BrainMesh, decodeBrainMesh } from "./mesh-format";

// ---------------------------------------------------------------------------
// Affine maps
// ---------------------------------------------------------------------------

/** A 3 x 4 affine map, row-major: `[r00 r01 r02 t0, r10 r11 r12 t1, r20 r21 r22 t2]`. */
export type Affine = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** `m` applied to the point `p`: rotation, scale and skew first, then the translation. */
export function applyAffine(m: Affine, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

/** The inverse map. Throws when the linear part is singular. */
export function invertAffine(m: Affine): Affine {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new RangeError("transforms: the affine map is singular");
  }
  const r00 = (e * i - f * h) / det;
  const r01 = (c * h - b * i) / det;
  const r02 = (b * f - c * e) / det;
  const r10 = (f * g - d * i) / det;
  const r11 = (a * i - c * g) / det;
  const r12 = (c * d - a * f) / det;
  const r20 = (d * h - e * g) / det;
  const r21 = (b * g - a * h) / det;
  const r22 = (a * e - b * d) / det;
  return [
    r00,
    r01,
    r02,
    -(r00 * tx + r01 * ty + r02 * tz),
    r10,
    r11,
    r12,
    -(r10 * tx + r11 * ty + r12 * tz),
    r20,
    r21,
    r22,
    -(r20 * tx + r21 * ty + r22 * tz),
  ];
}

/**
 * FreeSurfer, MNI305 (fsaverage space) to MNI152: item 8 of its CoordinateSystems documentation,
 * the matrix as printed (four decimals).
 */
export const MNI305_TO_MNI152: Affine = [
  0.9975, -0.0073, 0.0176, -0.0429, 0.0146, 1.0009, -0.0024, 1.5496, -0.013, -0.0093, 0.9971, 1.184,
];

/**
 * Lancaster et al. (2007) Eq. (3), the pooled best-fit MNI to Talairach (MTT) transform, as the
 * paper prints it and as BrainMap's `icbm_other2tal.m` applies it. It goes from MNI to Talairach.
 */
export const MNI_TO_TALAIRACH: Affine = [
  0.9357, 0.0029, -0.0072, -1.0423, -0.0065, 0.9396, -0.0726, -1.394, 0.0103, 0.0752, 0.8967,
  3.6475,
];

/** Talairach to MNI: the inverse of Eq. (3), as BrainMap's `tal2icbm_other.m` computes it. */
export const TALAIRACH_TO_MNI: Affine = invertAffine(MNI_TO_TALAIRACH);

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/*
 * How to add a family (every identifier of `STANDARD_TEMPLATES` is either a row below or a
 * pending entry; never both, never neither):
 *
 * 1. Source. A primary source (the template's own documentation, the paper that defines it, or
 *    the software's manual) that states the relation of the family's frame to the surface frame,
 *    MNI152NLin2009cAsym: an identity relation in words, or a numeric matrix. Do not infer a
 *    relation from names, brain size or "looks like MNI".
 * 2. Worked example. The source must print an input point and its output (a matrix with no pair
 *    does not qualify; an identity relation's pair is the point itself). No pair, no row: leave
 *    the entry pending and say in `needed` which pair would settle it.
 * 3. Fixture. Commit the excerpt (the matrix rows and the sentences around the pair, verbatim)
 *    under `test/fixtures/ieeg-transforms/`, with its source, retrieval date and SHA-256 in
 *    `SOURCES.json`; tests read the numbers from it, never from a retyped copy.
 * 4. Row. Add the matrix as a constant above, exactly as printed, and one `row(...)` below:
 *    `own`, `variant` (identity) or `affine`, with a `source` naming document, section and
 *    version, and `approximation` words for the label ("approximate: ..."), always set unless
 *    the frame is the surface's own. Then delete the family's pending entry.
 * 5. Tests (`transforms.test.ts`). The worked example to 0.01 mm read from the fixture, the
 *    row in the `KIND` table, the label wording, and a mutation (a transposed matrix) that fails
 *    the example. Add a real recording to `PLACED` in `panel.test.ts` when a public dataset
 *    declares the identifier.
 * 6. Label. `templateLabel` builds it from the row; nothing in the panel changes.
 */

/** The frame of the vendored surface: the one frame in which a contact is drawn untouched. */
export const SURFACE_FRAME: StandardTemplate = "MNI152NLin2009cAsym";

/** `own`: the surface's frame. `variant`: another MNI template, identity. `affine`: a cited matrix. */
export type PlacementKind = "own" | "variant" | "affine";

export interface TemplatePlacementRule {
  /** The BIDS canonical identifier this row is for. */
  identifier: StandardTemplate;
  kind: PlacementKind;
  /** Declared frame to surface frame (identity for `own` and `variant`). */
  transform: Affine;
  /** The words after "approximate: " in the label; null for the surface's own frame. */
  approximation: string | null;
  /** Where the row comes from, in words. */
  source: string;
}

export const VARIANT_APPROXIMATION = "MNI template variants differ by a few millimeters";
export const MNI305_APPROXIMATION = "MNI305 to MNI152 affine";
export const TALAIRACH_APPROXIMATION = "Talairach to MNI affine";

/**
 * The other MNI152 identifiers of the BIDS appendix and IXI549Space (SPM's template space, listed
 * there beside them): identity onto the surface. `transforms.test.ts` pins this list to every
 * `MNI152*` identifier of `STANDARD_TEMPLATES`, so a new one cannot slip in unplaced.
 */
export const MNI_VARIANTS = [
  "MNI152Lin",
  "MNI152NLin2009aSym",
  "MNI152NLin2009bSym",
  "MNI152NLin2009cSym",
  "MNI152NLin2009aAsym",
  "MNI152NLin2009bAsym",
  "MNI152NLin6Sym",
  "MNI152NLin6ASym",
  "IXI549Space",
] as const satisfies readonly StandardTemplate[];

const VARIANT_SOURCE =
  "BIDS coordinate-systems appendix, standard template identifiers: an MNI-space template, taken as the surface's frame unchanged";
const MNI305_SOURCE =
  "FreeSurfer CoordinateSystems documentation, item 8 (MNI305 to MNI152), matrix and worked example";
// A group-level bias model fitted on SPM2 and FSL data, with landmark disparities of 0.5 to 2.7 mm
// left over (Table V, MTT columns), applied to a dataset whose Talairach frame may come from
// another pipeline (for example FreeSurfer's talairach.xfm): approximate by construction.
const TALAIRACH_SOURCE =
  "Lancaster et al. 2007, Human Brain Mapping 28:1194, doi 10.1002/hbm.20345, Eq. (3) inverted (BrainMap tal2icbm_other); a group-level model with landmark disparities of 0.5 to 2.7 mm, not the pipeline of every dataset's Talairach frame";

function row(
  identifier: StandardTemplate,
  kind: PlacementKind,
  transform: Affine,
  approximation: string | null,
  source: string,
): [StandardTemplate, TemplatePlacementRule] {
  return [identifier, { identifier, kind, transform, approximation, source }];
}

export const TEMPLATE_PLACEMENTS: ReadonlyMap<StandardTemplate, TemplatePlacementRule> = new Map([
  row(
    SURFACE_FRAME,
    "own",
    IDENTITY,
    null,
    "The vendored surface's own frame (public/vendor/brain-templates provenance.json)",
  ),
  ...MNI_VARIANTS.map((id) => row(id, "variant", IDENTITY, VARIANT_APPROXIMATION, VARIANT_SOURCE)),
  row("MNI305", "affine", MNI305_TO_MNI152, MNI305_APPROXIMATION, MNI305_SOURCE),
  row("fsaverage", "affine", MNI305_TO_MNI152, MNI305_APPROXIMATION, MNI305_SOURCE),
  row("Talairach", "affine", TALAIRACH_TO_MNI, TALAIRACH_APPROXIMATION, TALAIRACH_SOURCE),
]);

/**
 * An identifier of the BIDS table with no row yet. `reason` says what was looked at and why it is
 * not enough; `needed` says what would place it (the source, the relation, the worked example).
 * Both are for the next card's author and for the tests; the panel only reads that the entry exists.
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

/** The pending entry for a template frame, or null (placed identifiers, and every non-template frame). */
export function pendingTemplateFor(frame: Frame | null): PendingTemplate | null {
  return frame?.kind === "template" ? (PENDING_TEMPLATES.get(frame.identifier) ?? null) : null;
}

/**
 * The row that places a space on the surface, or null. Only a `template` frame with a row and
 * units that were scaled to millimeters qualifies; the identifier is the canonical spelling
 * `geometry.ts` resolved, so `MNI152NLin6Asym` and `MNI152NLin6ASym` are one row.
 */
export function placementRuleFor(
  frame: Frame | null,
  units: Pick<Units, "unit">,
): TemplatePlacementRule | null {
  if (frame?.kind !== "template" || units.unit !== "mm") return null;
  return TEMPLATE_PLACEMENTS.get(frame.identifier) ?? null;
}

/** Where a contact at `declared` is drawn: through the row's affine (the identity for `own` and `variant`), nothing else. */
export function placeOnTemplate(rule: TemplatePlacementRule, declared: Vec3): Vec3 {
  return applyAffine(rule.transform, declared);
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** What the panel says beside every drawing of the surface. */
export const TEMPLATE_LABEL = `Template brain (${SURFACE_FRAME}), not this subject's anatomy`;

/** `TEMPLATE_LABEL`, plus "approximate: ..." whenever a transform or another MNI variant is involved. */
export function templateLabel(rule: TemplatePlacementRule): string {
  return rule.approximation === null
    ? TEMPLATE_LABEL
    : `${TEMPLATE_LABEL}; approximate: ${rule.approximation}`;
}

export const TEMPLATE_LOADING_SENTENCE = "Loading the template brain...";
export const TEMPLATE_FAILED_SENTENCE =
  "The template brain could not be loaded, so the contacts are shown in the dataset's own frame. Close and reopen this panel to try again.";

/** The word the "no template placement" sentence names: the identifier the file wrote, or its class. */
export function frameWord(frame: Frame | null): string {
  if (frame === null) return "an undeclared frame";
  if (frame.kind === "template") return frame.identifier;
  if (frame.kind === "unknown") return frame.declared ?? "an undeclared frame";
  return frame.declared;
}

/**
 * Said for every shown space that is not placed on the surface. A pending family reads "yet": it
 * is a known template whose transform this site has not got, not a frame with no template at all.
 */
export function noPlacementSentence(frame: Frame | null): string {
  const yet = pendingTemplateFor(frame) ? " yet" : "";
  return `No template placement${yet} for ${frameWord(frame)}: positions are shown in the dataset's own frame`;
}

// ---------------------------------------------------------------------------
// The surface, as files
// ---------------------------------------------------------------------------

/** The vendored folder, same origin, absolute path (Cloudflare Pages serves `public/` at the root). */
export const TEMPLATE_DIRECTORY = "/vendor/brain-templates/mni152nlin2009casym@1/";
export const TEMPLATE_HEMISPHERE_FILES = ["lh.mesh.bin", "rh.mesh.bin"] as const;
/** The MNI notice, which the notice itself requires to appear in all copies. */
export const TEMPLATE_LICENSE_HREF = `${TEMPLATE_DIRECTORY}LICENSE.txt`;
/** Fonov and colleagues, the template's reference. */
export const TEMPLATE_REFERENCE = {
  text: "Fonov et al., NeuroImage 2011",
  doi: "10.1016/j.neuroimage.2010.07.033",
  href: "https://doi.org/10.1016/j.neuroimage.2010.07.033",
} as const;

/**
 * The two hemispheres as one mesh: positions concatenated, the second index list offset by the
 * first's vertex count. The result keeps 16-bit indices while they reach every vertex.
 */
export function mergeMeshes(a: BrainMesh, b: BrainMesh): BrainMesh {
  const na = a.positions.length / 3;
  const nb = b.positions.length / 3;
  const total = na + nb;
  const positions = new Float32Array(a.positions.length + b.positions.length);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.positions.length);
  const indices =
    total <= 65536
      ? new Uint16Array(a.indices.length + b.indices.length)
      : new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices, 0);
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i] + na;
  return { positions, indices };
}

/** Fetch both halves of the surface, decode and merge them. Rejects on a failed read or a corrupt file. */
export async function loadTemplateSurface(
  fetchBytes: (url: string) => Promise<ArrayBuffer>,
): Promise<BrainMesh> {
  const halves = await Promise.all(
    TEMPLATE_HEMISPHERE_FILES.map(async (file) =>
      decodeBrainMesh(await fetchBytes(`${TEMPLATE_DIRECTORY}${file}`)),
    ),
  );
  return mergeMeshes(halves[0], halves[1]);
}

/** `fetch`, as `loadTemplateSurface` wants it: same origin, a non-200 answer is an error. */
export async function fetchBytesSameOrigin(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`transforms: ${url} answered ${res.status}`);
  return res.arrayBuffer();
}
