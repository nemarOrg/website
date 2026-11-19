import { describe, expect, it } from "vitest";
import { nodeFs, repoPath } from "../../../test/node";
import { STANDARD_TEMPLATES, type StandardTemplate, type Vec3, classifyFrame } from "./geometry";
import { decodeBrainMesh, encodeBrainMesh, icosphere } from "./mesh-format";
import { PENDING_TEMPLATES } from "./pending-templates";
import {
  IDENTITY,
  MNI305_APPROXIMATION,
  MNI305_TO_MNI152,
  MNI_TO_TALAIRACH,
  MNI_VARIANTS,
  SURFACE_FRAME,
  TALAIRACH_APPROXIMATION,
  TALAIRACH_TO_MNI,
  TEMPLATE_DIRECTORY,
  TEMPLATE_HEMISPHERE_FILES,
  TEMPLATE_LABEL,
  TEMPLATE_PLACEMENTS,
  type TemplatePlacementRule,
  VARIANT_APPROXIMATION,
  applyAffine,
  fetchBytesSameOrigin,
  frameWord,
  invertAffine,
  isPendingTemplate,
  loadTemplateSurface,
  mergeMeshes,
  noPlacementSentence,
  noSurfaceReason,
  noSurfaceSentence,
  placeOnTemplate,
  placementRuleFor,
  templateLabel,
} from "./transforms";

/**
 * Where each matrix comes from, and what is pinned against the source:
 *
 * - MNI305 to MNI152: FreeSurfer's CoordinateSystems documentation prints the matrix AND a worked
 *   example, (10, -20, 35) to (10.695, -18.409, 36.137), and the inverse with its own example. The
 *   excerpt committed under test/fixtures/ieeg-transforms is read here, so the numbers compared are
 *   the source's, not retyped.
 * - Talairach to MNI: Lancaster et al. 2007 print the matrix (Eq. 3) but NO worked point pair to
 *   0.01 mm, and neither do BrainMap's m-files, NiMARE's tests (whose "true" values the
 *   implementation itself made, by its own TODO) or any other source found. The card's stop
 *   condition asks the lead for an accepted pair; until one arrives the matrix is pinned to the
 *   printed Eq. (3) digit for digit, the direction to its name and to the paper's own AC
 *   statement, and the inverse to an independent exact-fraction computation (Python's `fractions`,
 *   quoted below), which is a known-answer check of the arithmetic, not a pair from the source.
 *
 * The surface files are the committed ones under public/vendor/brain-templates, read through a
 * reader over those bytes; the one HTTP answer shaped by hand is a real `Response`, used for the
 * failure paths of `fetchBytesSameOrigin` only.
 */

const fs = await nodeFs();
const FIXTURES = "test/fixtures/ieeg-transforms";
const SURFACE_DIR = "public/vendor/brain-templates/mni152nlin2009casym@1";

function fixture(name: string): string {
  return fs.readFileSync(repoPath(`${FIXTURES}/${name}`), "utf8");
}

/** Every number in a string, in order. */
function numbers(text: string): number[] {
  return [...text.matchAll(/-?\d+\.\d+|-?\d+/g)].map((m) => Number(m[0]));
}

/** Lines that are one matrix row of four decimals, as FreeSurfer's page prints them. */
function matrixRows(text: string): number[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => /^\s*-?\d+\.\d{4}(\s+-?\d+\.\d{4}){3}\s*$/.test(l))
    .map(numbers);
}

function dist(a: Vec3, b: ArrayLike<number>): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function expectNear(actual: Vec3, expected: ArrayLike<number>, tolerance: number): void {
  for (let k = 0; k < 3; k++) {
    expect(Math.abs(actual[k] - expected[k])).toBeLessThanOrEqual(tolerance);
  }
}

/** The 3 x 4 rows of a matrix printed 3 or 4 rows high, flattened row-major. */
const flat3x4 = (rows: number[][]): number[] => rows.slice(0, 3).flat();

const FS = fixture("freesurfer-mni305-to-mni152.txt");
const FS_ROWS = matrixRows(FS);
const FS_ITEM_8 = FS.slice(FS.indexOf("\n8. "), FS.indexOf("\n8b."));
const FS_ITEM_8B = FS.slice(FS.indexOf("\n8b."));

/** The vector after "M*v = [" in one item of the page, without its trailing homogeneous 1. */
function exampleOf(item: string): number[] {
  const m = /M\*v = \[([^\]]+)\]/.exec(item);
  if (!m) throw new Error("no worked example in the excerpt");
  return numbers(m[1]).slice(0, 3);
}
/** The example's input point, "(10 -20 35)". */
function inputOf(item: string): Vec3 {
  const m = /RAS point is \(([^)]+)\)/.exec(item);
  if (!m) throw new Error("no input point in the excerpt");
  return numbers(m[1]).slice(0, 3) as unknown as Vec3;
}

const LANCASTER = fixture("lancaster-2007-pooled-mtt.txt");

const RULES = [...TEMPLATE_PLACEMENTS.values()];
const rule = (id: StandardTemplate): TemplatePlacementRule => {
  const r = TEMPLATE_PLACEMENTS.get(id);
  if (!r) throw new Error(`no row for ${id}`);
  return r;
};

describe("MNI305 to MNI152: FreeSurfer's published affine and its worked example", () => {
  it("the excerpt holds the page's two matrices and two examples", () => {
    expect(FS_ROWS).toHaveLength(6);
    expect(inputOf(FS_ITEM_8)).toEqual([10, -20, 35]);
    expect(exampleOf(FS_ITEM_8)).toEqual([10.695, -18.409, 36.137]);
    expect(exampleOf(FS_ITEM_8B)).toEqual([9.3131, -21.5849, 33.8345]);
  });

  it("the module's matrix is the one printed in item 8", () => {
    expect([...MNI305_TO_MNI152]).toEqual(flat3x4(FS_ROWS.slice(0, 3)));
  });

  it("reproduces the page's example, (10, -20, 35) to (10.695, -18.409, 36.137), to 0.01 mm", () => {
    expectNear(applyAffine(MNI305_TO_MNI152, inputOf(FS_ITEM_8)), exampleOf(FS_ITEM_8), 0.01);
  });

  it("the inverse (item 8b) reproduces its example to 0.01 mm and inverts item 8 to its printed digits", () => {
    const printed = flat3x4(FS_ROWS.slice(3, 6));
    const inverse = invertAffine(MNI305_TO_MNI152);
    inverse.forEach((v, k) => expect(Math.abs(v - printed[k])).toBeLessThanOrEqual(5e-4));
    const point = inputOf(FS_ITEM_8B);
    expectNear(applyAffine(inverse, point), exampleOf(FS_ITEM_8B), 0.01);
    expectNear(
      applyAffine(printed as unknown as typeof MNI305_TO_MNI152, point),
      exampleOf(FS_ITEM_8B),
      0.01,
    );
  });

  it("MNI305, fsaverage and fsaverageSym all reach the example through the registry", () => {
    for (const id of ["MNI305", "fsaverage", "fsaverageSym"] as const) {
      expectNear(placeOnTemplate(rule(id), inputOf(FS_ITEM_8)), exampleOf(FS_ITEM_8), 0.01);
    }
  });
});

describe("Talairach to MNI: Lancaster et al. 2007, Eq. (3) inverted", () => {
  it("the module's MNI-to-Talairach matrix is Eq. (3) as printed, and BrainMap's icbm_other", () => {
    const [eq3, mfile] = LANCASTER.split("icbm_other2tal.m, icbm_other:");
    const printed = [
      ...eq3
        .split("Eq. (3), MTT pooled (row-major, 4 x 4):")[1]
        .split("\n\n")[0]
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map(numbers),
    ];
    expect(printed).toHaveLength(4);
    expect(printed[3]).toEqual([0, 0, 0, 1]);
    expect([...MNI_TO_TALAIRACH]).toEqual(flat3x4(printed));
    const code = mfile.split("\n").slice(1, 5).join(" ");
    expect(numbers(code).slice(0, 12)).toEqual([...MNI_TO_TALAIRACH]);
  });

  it("the Talairach-to-MNI matrix is its inverse: applying Eq. (3) to the result returns the input", () => {
    const points: Vec3[] = [
      [0, 0, 0],
      [10, -20, 35],
      [-44, 31, 27],
      [28, -76, 28],
      [-60, 5, -40],
    ];
    for (const p of points) {
      expectNear(applyAffine(MNI_TO_TALAIRACH, applyAffine(TALAIRACH_TO_MNI, p)), p, 1e-9);
    }
    // and the registry uses it, in this direction
    const row = rule("Talairach");
    expect([...row.transform]).toEqual([...TALAIRACH_TO_MNI]);
  });

  // Known answers from exact rational arithmetic, not from a source: the inverse of Eq. (3) computed
  // with Python's fractions.Fraction (Gauss-Jordan on the four-decimal entries) and rounded to nine
  // decimals. (-44, 31, 27) is also the first row of NiMARE's own test, which agrees to its eight.
  it("matches an independent exact computation of the inverse to 1e-6 mm", () => {
    const cases: [Vec3, Vec3][] = [
      [
        [0, 0, 0],
        [1.078155539, 1.168243532, -4.178049421],
      ],
      [
        [10, -20, 35],
        [12.132431382, -16.917672442, 36.243721339],
      ],
      [
        [-44, 31, 27],
        [-45.839975677, 35.979045593, 23.55194326],
      ],
      [
        [20, -32, 14],
        [22.692489751, -31.341450159, 13.912840869],
      ],
      [
        [28, -76, 28],
        [31.531132263, -76.616857482, 33.221051656],
      ],
    ];
    for (const [tal, mni] of cases) {
      expectNear(placeOnTemplate(rule("Talairach"), tal), mni, 1e-6);
    }
  });

  // The paper's own statement, in words: the mean anterior commissure (AC) of FSL-fitted MNI brains
  // is (0.3, 1.4, -4.4), and the best-fit transforms leave about 1 mm there. The Talairach origin is
  // the AC by definition, so the transform from Talairach must put it within 1 mm of that mean. This
  // pins the direction and the order of magnitude; it is not a 0.01 mm example.
  it("puts the Talairach origin, the AC, within 1 mm of the paper's mean AC of FSL-fitted MNI brains", () => {
    const m = /FSL is \((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/.exec(LANCASTER);
    const ac = numbers(m?.slice(1).join(" ") ?? "");
    expect(ac).toEqual([0.3, 1.4, -4.4]);
    expect(dist(placeOnTemplate(rule("Talairach"), [0, 0, 0]), ac)).toBeLessThan(1);
    // the wrong direction misses by more: Eq. (3) itself sends the mean AC to the origin's side
    expect(dist(applyAffine(MNI_TO_TALAIRACH, [0, 0, 0]), ac)).toBeGreaterThan(3);
  });
});

describe("the registry", () => {
  const KIND: Record<string, "own" | "variant" | "affine" | undefined> = {
    MNI152NLin2009cAsym: "own",
    MNI152Lin: "variant",
    MNI152NLin2009aSym: "variant",
    MNI152NLin2009bSym: "variant",
    MNI152NLin2009cSym: "variant",
    MNI152NLin2009aAsym: "variant",
    MNI152NLin2009bAsym: "variant",
    MNI152NLin6Sym: "variant",
    MNI152NLin6ASym: "variant",
    IXI549Space: "variant",
    MNI305: "affine",
    fsaverage: "affine",
    fsaverageSym: "affine",
    Talairach: "affine",
  };

  it("holds exactly the card's rows, and no other identifier of the BIDS table is placed", () => {
    for (const id of STANDARD_TEMPLATES) {
      expect(TEMPLATE_PLACEMENTS.get(id)?.kind, id).toBe(KIND[id]);
    }
    expect(TEMPLATE_PLACEMENTS.size).toBe(Object.keys(KIND).length);
  });

  it("the variants are every other MNI152 identifier of the BIDS table, and IXI549Space", () => {
    const glob = STANDARD_TEMPLATES.filter((t) => t.startsWith("MNI152") && t !== SURFACE_FRAME);
    expect([...MNI_VARIANTS].sort()).toEqual([...glob, "IXI549Space"].sort());
  });

  it("every row names its source, and every transform is the identity unless the row is an affine", () => {
    for (const r of RULES) {
      expect(r.source.length, r.identifier).toBeGreaterThan(20);
      if (r.kind !== "affine") expect([...r.transform], r.identifier).toEqual([...IDENTITY]);
    }
    expect(rule("fsaverage").source).toMatch(/FreeSurfer/);
    // fsaverageSym rests on the BIDS sentence it shares with fsaverage, and says it is approximate
    expect(rule("fsaverageSym").source).toMatch(/same sentence as fsaverage/);
    expect(rule("fsaverageSym").source).toMatch(/FreeSurfer variant of MNI305/);
    expect(rule("fsaverageSym").source).toMatch(/symmetric variant of fsaverage, so approximate/);
    // and the sentence is in the pinned appendix, word for word the same for both
    const clause = "the volumetric template corresponds to a FreeSurfer variant of `MNI305` space";
    expect(APPENDIX.split(clause).length - 1).toBe(2);
    const line = (id: string) => APPENDIX.split("\n").find((l) => l.startsWith(`| ${id} `)) ?? "";
    expect(line("fsaverage")).toContain(clause);
    expect(line("fsaverageSym")).toContain(clause);
    expect(rule("Talairach").source).toMatch(/Lancaster et al\. 2007/);
    expect(rule("Talairach").source).toMatch(/10\.1002\/hbm\.20345/);
  });

  it("the Talairach row claims no more than Table V supports: per-package fits, the pooled matrix untabulated", () => {
    const source = rule("Talairach").source;
    expect(source).toMatch(/at best 0\.5 to 2\.7 mm/);
    expect(source).toMatch(/Table V, per-package fits/);
    expect(source).toMatch(/pooled Eq\. 3 is not tabulated/);
    expect(source).not.toMatch(/left after|disparities of 0\.5/);
    // The numbers are the MTT columns of Table V in the committed excerpt: 8 landmarks, two
    // packages, from 0.5 to 2.7 mm, and the table is for the per-package fits, not the pooled one.
    const table = LANCASTER.slice(LANCASTER.indexOf("Landmark | SPM2 MNI"))
      .split("\n")
      .slice(1)
      .filter((l) => l.includes("|"))
      .map((l) => l.split("|").map((c) => c.trim()));
    expect(table.map((r) => r[0])).toEqual([
      "Anterior",
      "Superior",
      "Inferior",
      "Posterior",
      "Right",
      "Left",
      "AC",
      "PC",
    ]);
    const mtt = table.flatMap((r) => [Number(r[3]), Number(r[6])]);
    expect(mtt).toHaveLength(16);
    expect(Math.min(...mtt)).toBe(0.5);
    expect(Math.max(...mtt)).toBe(2.7);
    expect(LANCASTER).toMatch(/the pooled Eq\. \(3\) is not\s+in this table/);
  });

  it("IXI549Space is the one placed row that says its relation to MNI152 is not stated, and the appendix bears that out", () => {
    const ixi = rule("IXI549Space");
    expect(ixi.kind).toBe("variant");
    expect(ixi.approximation).toBe(VARIANT_APPROXIMATION);
    expect(ixi.source).toMatch(/ICBM MNI 452/);
    expect(ixi.source).toMatch(/not to an MNI152 template/);
    expect(ixi.source).toMatch(/documented exception/);
    for (const r of RULES) {
      if (r.identifier !== "IXI549Space") expect(r.source, r.identifier).not.toMatch(/exception/);
    }
    // the appendix's own words: IXI549 is linearly transformed to ICBM MNI 452, no MNI152 mentioned
    const line = APPENDIX.split("\n").find((l) => l.startsWith("| IXI549Space ")) ?? "";
    expect(line).toContain("linearly transformed to ICBM MNI 452");
    expect(line).not.toMatch(/MNI152/);
    // ICBM452 itself is pending, which is why the relation does not reach the surface frame
    expect(PENDING_TEMPLATES.has("ICBM452AirSpace")).toBe(true);
  });

  it("a template frame is placed by its canonical identifier, whatever the spelling of the file", () => {
    for (const declared of ["MNI152NLin6Asym", "mni152nlin6asym", "MNI152NLin6ASym"]) {
      const frame = classifyFrame(declared, null, null);
      expect(placementRuleFor(frame, { unit: "mm" })?.identifier, declared).toBe("MNI152NLin6ASym");
    }
  });

  it("only a template frame in millimeters is placed; native, described, pixel and unknown frames never are", () => {
    const mm = { unit: "mm" } as const;
    expect(placementRuleFor(classifyFrame("ACPC", null, null), mm)).toBeNull();
    expect(placementRuleFor(classifyFrame("ScanRAS", null, null), mm)).toBeNull();
    expect(
      placementRuleFor(classifyFrame("Other", null, "MNI space, said the authors"), mm),
    ).toBeNull();
    expect(placementRuleFor(classifyFrame("Pixels", null, null), mm)).toBeNull();
    for (const label of ["mni", "MNI", "MNI152", "fsaverage5", "nonsense"]) {
      expect(placementRuleFor(classifyFrame(label, null, null), mm), label).toBeNull();
    }
    expect(placementRuleFor(classifyFrame(null, null, null), mm)).toBeNull();
    expect(placementRuleFor(null, mm)).toBeNull();
    // a space entity that disagrees with the declared label makes the frame unknown
    expect(placementRuleFor(classifyFrame("MNI152NLin6ASym", "ACPC", null), mm)).toBeNull();
    // units the file did not declare, or in pixels, cannot be moved onto a brain
    const template = classifyFrame("MNI152NLin2009cAsym", null, null);
    expect(placementRuleFor(template, mm)?.kind).toBe("own");
    expect(placementRuleFor(template, { unit: null })).toBeNull();
    expect(placementRuleFor(template, { unit: "pixels" })).toBeNull();
    // identifiers of the BIDS table without a cited transform are not placed
    for (const id of ["MNIColin27", "ICBM452AirSpace", "fsLR", "NIHPD"]) {
      expect(placementRuleFor(classifyFrame(id, null, null), mm), id).toBeNull();
    }
  });

  it("a contact is moved only by an affine row; the surface's own frame and the variants leave it alone", () => {
    const p: Vec3 = [12.5, -33.25, 41];
    for (const r of RULES) {
      const moved = placeOnTemplate(r, p);
      if (r.kind === "affine") expect(moved, r.identifier).not.toEqual(p);
      else expect(moved, r.identifier).toEqual(p);
    }
  });
});

describe("the label", () => {
  it("the surface's own frame carries the template label and nothing about approximation", () => {
    expect(templateLabel(rule(SURFACE_FRAME))).toBe(TEMPLATE_LABEL);
    expect(TEMPLATE_LABEL).toBe("Template brain (MNI152NLin2009cAsym), not this subject's anatomy");
    expect(templateLabel(rule(SURFACE_FRAME))).not.toMatch(/approximate/i);
  });

  it("every other row carries the template label and 'approximate' with its reason, the identity rows too", () => {
    for (const r of RULES) {
      const label = templateLabel(r);
      expect(label.startsWith(TEMPLATE_LABEL), r.identifier).toBe(true);
      if (r.kind === "own") continue;
      expect(label, r.identifier).toContain("approximate: ");
    }
    expect(templateLabel(rule("MNI152NLin6ASym"))).toBe(
      `${TEMPLATE_LABEL}; approximate: MNI template variants differ by a few millimeters`,
    );
    expect(templateLabel(rule("IXI549Space"))).toContain(VARIANT_APPROXIMATION);
    expect(templateLabel(rule("fsaverage"))).toBe(
      `${TEMPLATE_LABEL}; approximate: MNI305 to MNI152 affine`,
    );
    expect(templateLabel(rule("MNI305"))).toContain(MNI305_APPROXIMATION);
    expect(templateLabel(rule("fsaverageSym"))).toBe(
      `${TEMPLATE_LABEL}; approximate: MNI305 to MNI152 affine`,
    );
    expect(templateLabel(rule("Talairach"))).toBe(
      `${TEMPLATE_LABEL}; approximate: Talairach to MNI affine`,
    );
    expect(TALAIRACH_APPROXIMATION).toBe("Talairach to MNI affine");
  });
});

describe("the sentence for a frame with no template placement", () => {
  it("names the declared identifier, or says the frame is undeclared", () => {
    const sentence = (label: string | null, entity: string | null = null) =>
      noPlacementSentence(classifyFrame(label, entity, null));
    expect(sentence("ACPC")).toBe(
      "No brain surface: this recording's coordinate frame (ACPC) has no cited transform to the template, so contacts are drawn in their own space.",
    );
    expect(sentence("ScanRAS")).toContain("frame (ScanRAS)");
    expect(sentence("Other")).toContain("frame (Other)");
    expect(sentence("Pixels")).toContain("frame (Pixels)");
    expect(sentence("mni")).toContain("frame (mni)");
    expect(sentence("fsLR")).toContain("frame (fsLR)");
    expect(sentence(null)).toBe(
      "No brain surface: this recording declares no coordinate frame, so there is no transform to the template and contacts are drawn in their own space.",
    );
    expect(noPlacementSentence(null)).not.toContain("(an undeclared frame)");
    expect(frameWord(classifyFrame("MNI152NLin6Asym", null, null))).toBe("MNI152NLin6ASym");
  });
});

describe("the surface as files", () => {
  const read = (rel: string): ArrayBuffer => {
    const bytes = fs.readFileSync(repoPath(`${SURFACE_DIR}/${rel}`));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  };
  /** A reader over the committed files; records what it was asked for. */
  function reader() {
    const asked: string[] = [];
    return {
      asked,
      read: async (url: string) => {
        asked.push(url);
        if (!url.startsWith(TEMPLATE_DIRECTORY)) throw new Error(`unexpected ${url}`);
        return read(url.slice(TEMPLATE_DIRECTORY.length));
      },
    };
  }
  const provenance = JSON.parse(
    fs.readFileSync(repoPath(`${SURFACE_DIR}/provenance.json`), "utf8"),
  );

  it("asks for the two hemisphere files of the vendored folder, same origin, and for nothing else", async () => {
    const r = reader();
    await loadTemplateSurface(r.read);
    expect([...r.asked].sort()).toEqual(
      TEMPLATE_HEMISPHERE_FILES.map((f) => `${TEMPLATE_DIRECTORY}${f}`).sort(),
    );
    for (const url of r.asked) {
      expect(url).toMatch(
        /^\/vendor\/brain-templates\/mni152nlin2009casym@1\/[a-z]{2}\.mesh\.bin$/,
      );
      expect(url).not.toContain("://");
    }
  });

  it("merges the real hemispheres: counts add, the second index list is offset, 16 bits suffice", async () => {
    const merged = await loadTemplateSurface(reader().read);
    const lh = decodeBrainMesh(read("lh.mesh.bin"));
    const rh = decodeBrainMesh(read("rh.mesh.bin"));
    const nl = lh.positions.length / 3;
    expect(nl).toBe(provenance.outputs["lh.mesh.bin"].vertices);
    expect(rh.positions.length / 3).toBe(provenance.outputs["rh.mesh.bin"].vertices);
    expect(merged.positions.length / 3).toBe(
      provenance.outputs["lh.mesh.bin"].vertices + provenance.outputs["rh.mesh.bin"].vertices,
    );
    expect(merged.indices).toBeInstanceOf(Uint16Array);
    expect(merged.indices.length).toBe(lh.indices.length + rh.indices.length);
    // the left half is untouched; the right half's first triangle points at the right half's vertices
    expect(Array.from(merged.indices.slice(0, 30))).toEqual(Array.from(lh.indices.slice(0, 30)));
    expect(merged.indices[lh.indices.length]).toBe(rh.indices[0] + nl);
    expect(Array.from(merged.positions.slice(3 * nl, 3 * nl + 3))).toEqual(
      Array.from(rh.positions.slice(0, 3)),
    );
    let max = 0;
    for (const i of merged.indices) max = Math.max(max, i);
    expect(max).toBe(merged.positions.length / 3 - 1);
    // left is x < 0 and right is x > 0, in the surface's own frame
    for (let i = 0; i < nl; i++) expect(merged.positions[3 * i]).toBeLessThanOrEqual(0.01);
  });

  it("uses 32-bit indices once 16 bits no longer reach every vertex", () => {
    const a = icosphere(6, 40);
    const b = icosphere(6, 40);
    expect(a.positions.length / 3 + b.positions.length / 3).toBeGreaterThan(65536);
    const merged = mergeMeshes(a, b);
    expect(merged.indices).toBeInstanceOf(Uint32Array);
    expect(merged.indices[a.indices.length]).toBe(b.indices[0] + a.positions.length / 3);
  });

  it("a failed read, or a file that is not a brain mesh, rejects instead of drawing", async () => {
    await expect(
      loadTemplateSurface(async () => {
        throw new Error("network down");
      }),
    ).rejects.toThrow("network down");
    await expect(
      loadTemplateSurface(async () => new TextEncoder().encode("<html>not a mesh</html>").buffer),
    ).rejects.toThrow(/brain-mesh/);
    const truncated = encodeBrainMesh(icosphere(1, 10)).slice(0, 60);
    await expect(loadTemplateSurface(async () => truncated)).rejects.toThrow(/brain-mesh/);
  });

  describe("fetchBytesSameOrigin", () => {
    const original = globalThis.fetch;
    const restore = () => {
      globalThis.fetch = original;
    };

    it("returns the bytes of a 200 answer and asks for them as the same origin", async () => {
      const bytes = read("lh.mesh.bin");
      let init: RequestInit | undefined;
      globalThis.fetch = (async (_url: string, i?: RequestInit) => {
        init = i;
        return new Response(bytes, { status: 200 });
      }) as typeof fetch;
      try {
        const got = await fetchBytesSameOrigin(`${TEMPLATE_DIRECTORY}lh.mesh.bin`);
        expect(got.byteLength).toBe(bytes.byteLength);
        expect(init?.credentials).toBe("same-origin");
      } finally {
        restore();
      }
    });

    it("an answer that is not 200 is an error naming the status, not an empty mesh", async () => {
      globalThis.fetch = (async () => new Response("gone", { status: 404 })) as typeof fetch;
      try {
        await expect(fetchBytesSameOrigin(`${TEMPLATE_DIRECTORY}lh.mesh.bin`)).rejects.toThrow(
          /answered 404/,
        );
      } finally {
        restore();
      }
    });
  });
});

/**
 * The pinned BIDS appendix (coordinate-systems.md at the commit IS-C1 pinned): the standard
 * template table, parsed the way `geometry.test.ts` parses it, and the deprecated table's patterns.
 */
const APPENDIX = fs.readFileSync(
  repoPath(
    "test/fixtures/ieeg-geometry/bids-specification/074ae6ffcdcfa27f07e131f42a545574f20675c8/src/appendices/coordinate-systems.md",
  ),
  "utf8",
);

function appendixIdentifiers(): string[] {
  const start = APPENDIX.indexOf("### Standard template identifiers");
  const end = APPENDIX.indexOf("The following template identifiers are retained");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const names: string[] = [];
  for (const line of APPENDIX.slice(start, end).split("\n")) {
    if (!line.startsWith("|")) continue;
    const first = line.replace(/\\\|/g, "\u0000").split("|")[1].trim();
    if (first === "**Coordinate System**" || /^-+$/.test(first)) continue;
    if (first.startsWith("MNI152NLin2009")) {
      for (const flavor of ["a", "b", "c"]) {
        for (const sym of ["Sym", "Asym"]) names.push(`MNI152NLin2009${flavor}${sym}`);
      }
    } else {
      names.push(first.replace(/\\/g, ""));
    }
  }
  return names;
}

describe("every identifier of the BIDS appendix is placed or pending", () => {
  const PENDING = [
    "ICBM452AirSpace",
    "ICBM452Warp5Space",
    "MNIColin27",
    "NIHPD",
    "OASIS30AntsOASISAnts",
    "OASIS30Atropos",
    "UNCInfant",
    "fsLR",
  ];

  it("the registry and the pending table together are exactly the appendix's table, and no identifier is in both", () => {
    const names = appendixIdentifiers();
    expect(names.length).toBeGreaterThan(15);
    for (const name of names) {
      const placed = TEMPLATE_PLACEMENTS.has(name as StandardTemplate);
      const waiting = PENDING_TEMPLATES.has(name as StandardTemplate);
      expect(placed || waiting, `${name} is neither placed nor pending: decide it`).toBe(true);
      expect(placed && waiting, `${name} is both placed and pending`).toBe(false);
    }
    const registered = [...TEMPLATE_PLACEMENTS.keys(), ...PENDING_TEMPLATES.keys()].sort();
    expect(registered).toEqual([...names].sort());
    expect([...PENDING_TEMPLATES.keys()].sort()).toEqual([...PENDING].sort());
  });

  it("every pending entry names its identifier, a reason and the evidence still needed, down to the worked example", () => {
    for (const [id, entry] of PENDING_TEMPLATES) {
      expect(entry.identifier, id).toBe(id);
      expect(entry.reason.trim().length, `${id} reason`).toBeGreaterThan(60);
      expect(entry.needed.trim().length, `${id} needed`).toBeGreaterThan(40);
      expect(entry.needed, `${id} needed`).toMatch(/worked/);
    }
  });

  it("a pending identifier is never placed, whatever its units, and a placed one is never pending", () => {
    const mm = { unit: "mm" } as const;
    for (const id of PENDING_TEMPLATES.keys()) {
      const frame = classifyFrame(id, null, null);
      expect(frame, id).toMatchObject({ kind: "template", identifier: id });
      expect(placementRuleFor(frame, mm), id).toBeNull();
      expect(isPendingTemplate(frame), id).toBe(true);
    }
    for (const id of TEMPLATE_PLACEMENTS.keys()) {
      expect(isPendingTemplate(classifyFrame(id, null, null)), id).toBe(false);
    }
    // frames that are not template frames are never pending
    for (const label of ["ACPC", "ScanRAS", "Other", "Pixels", "mni", null]) {
      expect(isPendingTemplate(classifyFrame(label, null, null)), String(label)).toBe(false);
    }
    expect(isPendingTemplate(null)).toBe(false);
  });

  it("no runtime module imports the pending table, so none of its text reaches the panel's chunk", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const path = `${dir}/${name}`;
        if (fs.statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|astro)$/.test(name) && !name.endsWith(".test.ts")) {
          if (/from\s+["'][^"']*pending-templates["']/.test(fs.readFileSync(path, "utf8"))) {
            importers.push(path);
          }
        }
      }
    };
    walk(repoPath("src"));
    expect(importers).toEqual([]);
  });

  it("the deprecated spellings stay unknown frames: neither placed nor pending, and no 'yet'", () => {
    expect(APPENDIX).toContain("fsaverage\\[3\\|4\\|5\\|6\\|sym\\]");
    expect(APPENDIX).toContain("UNCInfant\\[0\\|1\\|2\\]V\\[21\\|22\\|23\\]");
    const deprecated = [
      ...["3", "4", "5", "6"].map((n) => `fsaverage${n}`),
      ...["0", "1", "2"].flatMap((a) => ["21", "22", "23"].map((b) => `UNCInfant${a}V${b}`)),
    ];
    for (const label of deprecated) {
      const frame = classifyFrame(label, null, null);
      expect(frame, label).toMatchObject({ kind: "unknown", why: "unrecognized_label" });
      expect(placementRuleFor(frame, { unit: "mm" }), label).toBeNull();
      expect(isPendingTemplate(frame), label).toBe(false);
      expect(noPlacementSentence(frame), label).not.toContain("surface yet");
    }
    // the one that equals a current identifier in letter case is that identifier (fsaverageSym, placed)
    const sym = classifyFrame("fsaveragesym", null, null);
    expect(sym).toMatchObject({ kind: "template", identifier: "fsaverageSym" });
    expect(isPendingTemplate(sym)).toBe(false);
    expect(placementRuleFor(sym, { unit: "mm" })?.identifier).toBe("fsaverageSym");
  });

  it("a pending family reads 'No brain surface yet' and every other unplaced frame reads 'No brain surface'", () => {
    const sentence = (label: string | null, entity: string | null = null) =>
      noPlacementSentence(classifyFrame(label, entity, null));
    for (const id of PENDING_TEMPLATES.keys()) {
      expect(sentence(id), id).toBe(
        `No brain surface yet: this recording's coordinate frame (${id}) is a template family whose transform this site does not have yet, so contacts are drawn in their own space.`,
      );
    }
    for (const label of ["ACPC", "ScanRAS", "Other", "Pixels", "mni", "MNI152", "fsaverage5"]) {
      expect(sentence(label), label).toBe(
        `No brain surface: this recording's coordinate frame (${label}) has no cited transform to the template, so contacts are drawn in their own space.`,
      );
    }
    expect(sentence(null)).toBe(noSurfaceSentence("undeclared_frame", null));
    // the two wordings differ for a pending family and for a native frame
    expect(sentence("MNIColin27")).not.toBe(sentence("ACPC"));
  });
});

describe("why no brain surface is drawn", () => {
  const registered = classifyFrame("MNI152NLin2009cAsym", null, null);

  it("maps each reason to one sentence that says what is drawn instead", () => {
    const acpc = classifyFrame("ACPC", null, null);
    const pending = classifyFrame("fsLR", null, null);
    expect(noSurfaceSentence("no_transform", acpc)).toBe(
      "No brain surface: this recording's coordinate frame (ACPC) has no cited transform to the template, so contacts are drawn in their own space.",
    );
    expect(noSurfaceSentence("pending_transform", pending)).toMatch(
      /^No brain surface yet: .*\(fsLR\)/,
    );
    expect(noSurfaceSentence("undeclared_frame", null)).toContain("declares no coordinate frame");
    expect(noSurfaceSentence("units_not_mm", registered)).toContain("no length unit");
    expect(noSurfaceSentence("units_banner", registered)).toContain("does not match");
    for (const reason of [
      "no_transform",
      "pending_transform",
      "undeclared_frame",
      "units_not_mm",
      "units_banner",
    ] as const) {
      const sentence = noSurfaceSentence(reason, acpc);
      expect(sentence, reason).toMatch(/^No brain surface/);
      expect(sentence.match(/\./g)?.length, reason).toBe(1);
    }
  });

  it("derives the reason from the frame first, then the units, then the banner", () => {
    const mm = { unit: "mm" } as const;
    expect(noSurfaceReason(registered, mm, false)).toBeNull();
    expect(noSurfaceReason(classifyFrame("ACPC", null, null), mm, false)).toBe("no_transform");
    expect(noSurfaceReason(classifyFrame("fsLR", null, null), mm, false)).toBe("pending_transform");
    expect(noSurfaceReason(null, mm, false)).toBe("undeclared_frame");
    expect(noSurfaceReason(registered, { unit: null }, false)).toBe("units_not_mm");
    expect(noSurfaceReason(registered, { unit: "pixels" }, false)).toBe("units_not_mm");
    expect(noSurfaceReason(registered, mm, true)).toBe("units_banner");
    // a frame with no row says so even under the banner: the frame is the root cause
    expect(noSurfaceReason(classifyFrame("ACPC", null, null), mm, true)).toBe("no_transform");
  });
});
