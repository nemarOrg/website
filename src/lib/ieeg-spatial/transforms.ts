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
 * | `MNI305`, `fsaverage`, `fsaverageSym`         | FreeSurfer's published MNI305 to MNI152     | `approximate: MNI305 to MNI152 affine`                    |
 * | `Talairach`                                   | inverse of Lancaster et al.'s pooled MTT    | `approximate: Talairach to MNI affine`                    |
 *
 * Every other identifier of the BIDS table is PENDING (`pending-templates.ts`): `MNIColin27`,
 * `ICBM452AirSpace`, `ICBM452Warp5Space`, `fsLR`, `NIHPD`, `OASIS30AntsOASISAnts`,
 * `OASIS30Atropos` and `UNCInfant`. Each says why it has no row yet and what evidence would place
 * it, and the panel says "No brain surface yet: ... (X) ...". A test fails when an identifier of the
 * pinned BIDS appendix is neither placed nor pending, so a new standard identifier forces a
 * decision. The appendix's deprecated spellings (`fsaverage3` to `fsaverage6`, `UNCInfant0V21` and
 * kin) stay unknown frames in `geometry.ts` and never reach this registry.
 * `ACPC`, `ScanRAS`, `Other`, `Pixels`, a non-standard label and a missing frame are not
 * template frames at all (`geometry.ts` never promotes them) and read "No brain surface: ... (X) has no
 * cited transform ...", and a template frame whose units are not millimeters is not placed either: a scale nobody
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
 *   as the volume of `fsaverage` (coordinate-systems appendix), hence the same row, and says the
 *   same of `fsaverageSym` in the same words (see the registry, where that row's caveat is).
 * - Talairach to MNI: Lancaster JL, Tordesillas-Gutierrez D, Martinez M, Salinas F, Evans A,
 *   Zilles K, Mazziotta JC, Fox PT. Bias between MNI and Talairach coordinates analyzed using the
 *   ICBM-152 brain template. Human Brain Mapping 28(11):1194-1205 (2007), doi 10.1002/hbm.20345.
 *   The paper's Eq. (3), "best-fit MTT transform pooling SPM2 and FSL data", maps MNI to Talairach;
 *   BrainMap's `icbm_other2tal.m` multiplies by it and `tal2icbm_other.m` multiplies by its inverse,
 *   the "other" form being the one for templates other than the SPM and FSL copies, as the 2009c
 *   one is. The paper prints no worked point pair to 0.01 mm; see `transforms.test.ts`.
 *   This is approximate by construction: Eq. (3) is a group-level bias model, fitted on SPM2 and
 *   FSL normalizations of 100 brains. The paper's Table V gives landmark disparities of at best
 *   0.5 to 2.7 mm (8 landmarks, 10 brains), but for the per-package best-fit transforms (Eqs. 1
 *   and 2); the pooled Eq. (3) is not tabulated, so its residuals are likely somewhat larger. A
 *   dataset's own Talairach frame may also come from another pipeline, such as FreeSurfer's
 *   `talairach.xfm`, which this row does not model.
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
 * pending entry in `pending-templates.ts`; never both, never neither):
 *
 * 1. Source. A primary source (the template's own documentation, the paper that defines it, or
 *    the software's manual) that states the relation of the family's frame to an MNI152 template
 *    or to the surface frame, MNI152NLin2009cAsym: an identity relation in words, or a numeric
 *    matrix. Do not infer a relation from names, brain size or "looks like MNI". The one
 *    documented exception to this policy is IXI549Space (see `IXI_SOURCE`).
 * 2. Worked example. The source must print an input point and its output (a matrix with no pair
 *    does not qualify; an identity relation's pair is the point itself). No pair, no row: leave
 *    the entry pending and say in `needed` which pair would settle it.
 * 3. Fixture. Commit the excerpt (the matrix rows and the sentences around the pair, verbatim)
 *    under `test/fixtures/ieeg-transforms/`, with its source, retrieval date and SHA-256 in
 *    `SOURCES.json`; tests read the numbers from it, never from a retyped copy.
 * 4. Row. Add the matrix as a constant above, exactly as printed, and one `row(...)` below:
 *    `own`, `variant` (identity) or `affine`, with a `source` naming document, section and
 *    version, and `approximation` words for the label ("approximate: ..."), always set unless
 *    the frame is the surface's own. Then delete the family's entry in `pending-templates.ts`.
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
// IXI549Space is the one documented exception to the policy that a placed row needs a stated
// relation to the MNI152 frame. The BIDS appendix says it is the average of 549 IXI subjects
// "linearly transformed to ICBM MNI 452": a relation to ICBM452 (itself pending, with no stated
// relation to MNI152), not to an MNI152 template. The row stays identity, labeled approximate,
// because the card (ADR 0033, Q4 A) placed it. A primary source stating IXI549Space's relation to
// an MNI152 template, with a worked point pair, would settle it; absent that it is a candidate to
// move to `pending-templates.ts`.
const IXI_SOURCE =
  "BIDS coordinate-systems appendix: IXI549Space is linearly transformed to ICBM MNI 452, a relation to ICBM452 (pending), not to an MNI152 template; kept as identity by the card's decision, a documented exception";
const MNI305_SOURCE =
  "FreeSurfer CoordinateSystems documentation, item 8 (MNI305 to MNI152), matrix and worked example";
// A group-level bias model fitted on SPM2 and FSL data. Table V's landmark disparities, at best 0.5
// to 2.7 mm, are for the per-package fits (Eqs. 1 and 2); the pooled Eq. (3) is not tabulated, so
// its residuals are likely somewhat larger. It is applied to a dataset whose Talairach frame may
// come from another pipeline (for example FreeSurfer's talairach.xfm): approximate by construction.
const TALAIRACH_SOURCE =
  "Lancaster et al. 2007, Human Brain Mapping 28:1194, doi 10.1002/hbm.20345, Eq. (3) inverted (BrainMap tal2icbm_other); a group-level model, at best 0.5 to 2.7 mm at landmarks (Table V, per-package fits; the pooled Eq. 3 is not tabulated), not the pipeline of every dataset's Talairach frame";

// fsaverageSym: the BIDS appendix says of it, word for word as of fsaverage, "the volumetric
// template corresponds to a FreeSurfer variant of MNI305 space", and fsaverage is placed on exactly
// that sentence plus FreeSurfer's MNI305 to MNI152 matrix and worked example, so fsaverageSym takes
// the same matrix and the same label. FreeSurfer's documentation says nothing more of fsaverage_sym
// coordinates, and the surface is a symmetric variant of fsaverage: the relation is approximate.
const FSAVERAGESYM_SOURCE =
  "BIDS coordinate-systems appendix, fsaverageSym: the same sentence as fsaverage (a FreeSurfer variant of MNI305), so FreeSurfer's MNI305 to MNI152 matrix and worked example; a symmetric variant of fsaverage, so approximate";

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
  ...MNI_VARIANTS.map((id) =>
    row(
      id,
      "variant",
      IDENTITY,
      VARIANT_APPROXIMATION,
      id === "IXI549Space" ? IXI_SOURCE : VARIANT_SOURCE,
    ),
  ),
  row("MNI305", "affine", MNI305_TO_MNI152, MNI305_APPROXIMATION, MNI305_SOURCE),
  row("fsaverage", "affine", MNI305_TO_MNI152, MNI305_APPROXIMATION, MNI305_SOURCE),
  row("fsaverageSym", "affine", MNI305_TO_MNI152, MNI305_APPROXIMATION, FSAVERAGESYM_SOURCE),
  row("Talairach", "affine", TALAIRACH_TO_MNI, TALAIRACH_APPROXIMATION, TALAIRACH_SOURCE),
]);

/**
 * True for a `template` frame whose identifier is a standard one this registry has no row for yet.
 * `pending-templates.ts` says why for each and what evidence would place it; it is kept out of the
 * bundle (only tests import it), and `transforms.test.ts` fails when an identifier of the pinned
 * BIDS appendix is neither a row here nor an entry there, so "has no row" and "pending" are the
 * same set. The panel words it "No brain surface yet: ...".
 */
export function isPendingTemplate(frame: Frame | null): boolean {
  return frame?.kind === "template" && !TEMPLATE_PLACEMENTS.has(frame.identifier);
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
 * Why a shown space is drawn without the brain surface. One code per reason; `noSurfaceSentence`
 * is the only place that words them.
 *
 * - `undeclared_frame`: the electrodes file's frame names nothing.
 * - `pending_transform`: a template family whose transform this site does not have yet.
 * - `no_transform`: any other frame with no cited transform to the template.
 * - `units_not_mm`: a registered frame, but the positions could not be scaled to millimeters.
 * - `units_banner`: a registered frame, but the declared unit disagrees with the numbers.
 */
export type NoSurfaceReason =
  | "undeclared_frame"
  | "pending_transform"
  | "no_transform"
  | "units_not_mm"
  | "units_banner";

/** The reason the frame alone gives for having no placement; null for a registered frame. */
export function noSurfaceFrameReason(frame: Frame | null): NoSurfaceReason | null {
  if (frame?.kind === "template" && TEMPLATE_PLACEMENTS.has(frame.identifier)) return null;
  if (isPendingTemplate(frame)) return "pending_transform";
  if (frameWord(frame) === "an undeclared frame") return "undeclared_frame";
  return "no_transform";
}

/**
 * Why no surface is drawn for this space, or null when one is placed. The frame decides first,
 * then the units; `bannerShown` says the units banner applies to the drawn positions.
 */
export function noSurfaceReason(
  frame: Frame | null,
  units: Pick<Units, "unit">,
  bannerShown: boolean,
): NoSurfaceReason | null {
  const byFrame = noSurfaceFrameReason(frame);
  if (byFrame !== null) return byFrame;
  if (units.unit !== "mm") return "units_not_mm";
  return bannerShown ? "units_banner" : null;
}

/** One sentence per reason, each saying what is drawn instead. */
export function noSurfaceSentence(reason: NoSurfaceReason, frame: Frame | null): string {
  const word = frameWord(frame);
  switch (reason) {
    case "undeclared_frame":
      return "No brain surface: this recording declares no coordinate frame, so there is no transform to the template and contacts are drawn in their own space.";
    case "pending_transform":
      return `No brain surface yet: this recording's coordinate frame (${word}) is a template family whose transform this site does not have yet, so contacts are drawn in their own space.`;
    case "no_transform":
      return `No brain surface: this recording's coordinate frame (${word}) has no cited transform to the template, so contacts are drawn in their own space.`;
    case "units_not_mm":
      return `No brain surface: the positions in frame ${word} have no length unit this view converts to millimeters, so contacts are drawn as written and not placed on the template.`;
    case "units_banner":
      return "No brain surface: the declared unit does not match the size of the numbers (see the warning above the drawing), so contacts are drawn as declared and not placed on the template.";
  }
}

/**
 * Said for every shown space whose frame is not placed on the surface. A pending family reads
 * "yet": it is a known template whose transform this site has not got.
 */
export function noPlacementSentence(frame: Frame | null): string {
  return noSurfaceSentence(noSurfaceFrameReason(frame) ?? "no_transform", frame);
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
