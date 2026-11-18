import { describe, expect, it } from "vitest";
import { closedLocalOrigin, nodeFs, repoPath, serveStatus, sha256Hex } from "../../../test/node";
import {
  GEOMETRY_REASONS,
  type GeometryInput,
  type RecordingGeometry,
  STANDARD_TEMPLATES,
  type SpaceGeometry,
  classifyFrame,
  dataPlaneSource,
  joinChannels,
  resolveRecordingGeometry,
} from "./geometry";

/**
 * Every input here is a real public file or directory listing of the NEMAR data plane, committed
 * byte for byte under test/fixtures/ieeg-geometry (SOURCES.json names dataset, version, path and
 * SHA-256 of each). A "reader over the fixture tree" is `listDir` and `readText` answering from
 * those files; a directory the tree does not hold answers null, as the data plane's 404 does.
 *
 * Two inputs are known-answer values rather than files, and say so where they appear: the label
 * table for `classifyFrame` (no public coordsystem file declares a non-standard label) and the
 * names-only listing for the `ambiguous` branch (no public recording is matched by two equally
 * specific files).
 */

const fs = await nodeFs();
const FIXTURES = "test/fixtures/ieeg-geometry";

type Reader = Pick<GeometryInput, "listDir" | "readText">;

function treeReader(datasetId: string, version: string): Reader {
  const at = (rel: string) => repoPath(`${FIXTURES}/${datasetId}/${version}/${rel}`);
  return {
    listDir: async (path) => {
      const file = at(path === "" ? "__listing.json" : `${path}/__listing.json`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    },
    readText: async (path) => (fs.existsSync(at(path)) ? fs.readFileSync(at(path), "utf8") : null),
  };
}

async function resolve(
  datasetId: string,
  version: string,
  recording: string,
  reader: Reader = treeReader(datasetId, version),
): Promise<RecordingGeometry> {
  return resolveRecordingGeometry({ datasetId, version, recording, ...reader });
}

function fixtureText(datasetId: string, version: string, path: string): string {
  return fs.readFileSync(repoPath(`${FIXTURES}/${datasetId}/${version}/${path}`), "utf8");
}

/** An independent reading of a BIDS table: header row, then one record per line. */
function table(text: string): Record<string, string>[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  const head = lines[0].split("\t");
  return lines.slice(1).map((l) => Object.fromEntries(l.split("\t").map((v, i) => [head[i], v])));
}

function only(geometry: RecordingGeometry, space: string | null): SpaceGeometry {
  const found = geometry.spaces.filter((s) => s.space === space);
  expect(found, `space ${space}`).toHaveLength(1);
  return found[0];
}

function contact(space: SpaceGeometry, name: string) {
  const found = space.contacts.find((c) => c.name === name);
  expect(found, `contact ${name}`).toBeDefined();
  return found as NonNullable<typeof found>;
}

// Recordings, as the Zarr index names them (the three marked are named from the files beside them:
// those datasets hold no converted store).
const R1001P = "sub-R1001P/ses-0/ieeg/sub-R1001P_ses-0_task-YC1_acq-bipolar_ieeg.edf";
const R1009W = "sub-R1009W/ses-0/ieeg/sub-R1009W_ses-0_task-YC1_acq-bipolar_ieeg.edf";
const NM454 =
  "sub-PID02/ses-clinical01/ieeg/sub-PID02_ses-clinical01_task-ictal10046_run-04_ieeg.edf";
const HUP060 =
  "sub-HUP060/ses-presurgery/ieeg/sub-HUP060_ses-presurgery_task-ictal_acq-seeg_run-01_ieeg.edf";
const SUB72 = "sub-72/ieeg/sub-72_task-numbers_run-1_ieeg.edf";
const EC192 = "sub-EC192/ieeg/sub-EC192_task-heights_ieeg.vhdr";
const SUB369 = "sub-369/ieeg/sub-369_task-amygdalastim_run-100_ieeg.vhdr";
const NM405 = "sub-000/ses-right/ieeg/sub-000_ses-right_task-force_run-0_desc-1kHz_ieeg.vhdr";
const NM376 = "sub-P1/ieeg/sub-P1_task-memact_ieeg.vhdr";
const ON6136 = "sub-P1/ieeg/sub-P1_task-OWM_ieeg.edf";
const NM373 = "sub-01/ieeg/sub-01_task-categorySL_run-1_ieeg.edf";
const NM485 = "sub-P001/ieeg/sub-P001_task-wordsnonfont_run-1_ieeg.vhdr";
const ON4457 = "sub-2/ses-ieeg01/ieeg/sub-2_ses-ieeg01_task-ccep_run-01_ieeg.mefd";
const ON4473 = "sub-1/ieeg/sub-1_task-SlowFast_ieeg.edf";
// Named from the real channels file beside it (the dataset holds no converted store).
const ON6253 = "sub-01/ses-01/ieeg/sub-01_ses-01_task-MetaRDK_acq-01_run-01_ieeg.edf";
const NM406_LEFT = "sub-02/ieeg/sub-02_task-mer_acq-left_run-01_ieeg.vhdr";
const NM406_RIGHT = "sub-02/ieeg/sub-02_task-mer_acq-right_run-01_ieeg.vhdr";
const ON1785 = "sub-patient/ses-01/ieeg/sub-patient_ses-01_task-01_run-01_ieeg.TRC";
const ON4642 = "sub-01/ses-01/ieeg/sub-01_ses-01_task-lozHFO_run-01_ieeg.edf";
const ON4370 = "sub-PRIOS01/ses-1/ieeg/sub-PRIOS01_ses-1_task-SPESclin_run-021358_ieeg.vhdr";
const ON3844 =
  "sub-RESP0059/ses-SITUATION1A/ieeg/sub-RESP0059_ses-SITUATION1A_task-acute_ieeg.vhdr";

describe("spaces: inheritance, entities and pairing", () => {
  it("on005522: each subject's recording gets its own space, paired with its own coordsystem", async () => {
    const a = await resolve("on005522", "v1.0.0", R1001P);
    expect(a.spaces.map((s) => s.space)).toEqual(["MNI152NLin6ASym"]);
    expect(a.spaces[0].electrodesPath).toBe(
      "sub-R1001P/ses-0/ieeg/sub-R1001P_ses-0_task-YC1_space-MNI152NLin6ASym_electrodes.tsv",
    );
    expect(a.spaces[0].coordsystemPath).toBe(
      "sub-R1001P/ses-0/ieeg/sub-R1001P_ses-0_task-YC1_space-MNI152NLin6ASym_coordsystem.json",
    );
    expect(a.reason).toBeNull();

    const b = await resolve("on005522", "v1.0.0", R1009W);
    expect(b.spaces.map((s) => s.space)).toEqual(["Talairach"]);
    expect(b.spaces[0].coordsystemPath).toBe(
      "sub-R1009W/ses-0/ieeg/sub-R1009W_ses-0_task-YC1_space-Talairach_coordsystem.json",
    );
  });

  it("nm000485: both spaces of one recording are offered, each with its own coordsystem, none preferred", async () => {
    const g = await resolve("nm000485", "v1.0.2", NM485);
    expect(g.spaces.map((s) => s.space)).toEqual(["Other", "Talairach"]);
    for (const s of g.spaces) {
      expect(s.electrodesPath).toBe(`sub-P001/ieeg/sub-P001_space-${s.space}_electrodes.tsv`);
      expect(s.coordsystemPath).toBe(`sub-P001/ieeg/sub-P001_space-${s.space}_coordsystem.json`);
    }
    expect(only(g, "Other").frame?.kind).toBe("described");
    expect(only(g, "Talairach").frame?.kind).toBe("template");
    expect(g.reason).toBeNull();
  });

  it("on004473: ACPC and ScanRAS are both native frames and both are offered", async () => {
    const g = await resolve("on004473", "v1.0.0", ON4473);
    expect(g.spaces.map((s) => [s.space, s.frame?.kind])).toEqual([
      ["ACPC", "native"],
      ["ScanRAS", "native"],
    ]);
  });

  it("on004457: a spaceless pair and an ACPC pair coexist; a coordsystem pairs only with an equal space", async () => {
    const g = await resolve("on004457", "v1.0.0", ON4457);
    expect(g.spaces.map((s) => s.space)).toEqual([null, "ACPC"]);
    const plain = only(g, null);
    expect(plain.coordsystemPath).toBe("sub-2/ses-ieeg01/ieeg/sub-2_ses-ieeg01_coordsystem.json");
    expect(plain.frame).toMatchObject({ kind: "described" });
    const acpc = only(g, "ACPC");
    expect(acpc.coordsystemPath).toBe(
      "sub-2/ses-ieeg01/ieeg/sub-2_ses-ieeg01_space-ACPC_coordsystem.json",
    );
    expect(acpc.frame).toMatchObject({ kind: "native", declared: "ACPC" });
  });

  it("on006253: a subject-level file is inherited, and the session's fsaverage coordsystem does not pair with it", async () => {
    const g = await resolve("on006253", "v1.0.0", ON6253);
    expect(g.spaces.map((s) => s.space)).toEqual(["fsaverage", "mni"]);
    const fsaverage = only(g, "fsaverage");
    expect(fsaverage.electrodesPath).toBe(
      "sub-01/ses-01/ieeg/sub-01_ses-01_acq-01_space-fsaverage_electrodes.tsv",
    );
    expect(fsaverage.coordsystemPath).toBe(
      "sub-01/ses-01/ieeg/sub-01_ses-01_acq-01_space-fsaverage_coordsystem.json",
    );
    const mni = only(g, "mni");
    // One directory up from the recording's own, at the subject level.
    expect(mni.electrodesPath).toBe("sub-01/sub-01_space-mni_electrodes.tsv");
    expect(mni.coordsystemPath).toBeNull();
    expect(mni.frame).toMatchObject({ kind: "unknown", why: "no_coordsystem" });
    expect(mni.units.unitsDeclared).toBe(false);
  });

  it("nm000406: an entity the recording does not carry keeps a file from applying", async () => {
    const left = await resolve("nm000406", "v1.0.2", NM406_LEFT);
    expect(left.spaces.map((s) => s.electrodesPath)).toEqual([
      "sub-02/ieeg/sub-02_acq-left_space-Other_electrodes.tsv",
    ]);
    const right = await resolve("nm000406", "v1.0.2", NM406_RIGHT);
    expect(right.spaces.map((s) => s.electrodesPath)).toEqual([
      "sub-02/ieeg/sub-02_acq-right_space-Other_electrodes.tsv",
    ]);
  });

  it("on006136: a recording whose files carry no space entity pairs the spaceless coordsystem", async () => {
    const g = await resolve("on006136", "v1.0.0", ON6136);
    expect(g.spaces).toHaveLength(1);
    expect(g.spaces[0].space).toBeNull();
    expect(g.spaces[0].coordsystemPath).toBe("sub-P1/ieeg/sub-P1_coordsystem.json");
    expect(g.spaces[0].frame).toMatchObject({ kind: "template", identifier: "MNI152Lin" });
  });
});

/**
 * Known-answer inputs, names only. The precedence rules (deepest directory, then most entities,
 * then a tie) have no case in the public data: no recording there is matched by two files of one
 * space. So each listing here is the file NAMES of a directory and nothing else; a read answers
 * null, which leaves the chosen path visible on an `unreadable` space.
 */
describe("precedence of inherited files (names-only listings)", () => {
  const namesOnly = (listings: Record<string, string[]>): Reader => ({
    listDir: async (p) => ({
      children: (listings[p] ?? []).map((name) => ({ kind: "file" as const, name, size: 1 })),
    }),
    readText: async () => null,
  });
  const REC = "sub-01/ses-1/ieeg/sub-01_ses-1_task-A_ieeg.edf";
  const chosen = async (listings: Record<string, string[]>, recording = REC) =>
    (await resolve("none", "v0", recording, namesOnly(listings))).spaces.map(
      (s) => s.electrodesPath,
    );

  it("the deepest directory wins, even over a file with more entities", async () => {
    expect(
      await chosen({
        "": ["task-A_space-X_electrodes.tsv"],
        "sub-01": ["sub-01_task-A_space-X_electrodes.tsv"],
        "sub-01/ses-1/ieeg": ["sub-01_space-X_electrodes.tsv"],
      }),
    ).toEqual(["sub-01/ses-1/ieeg/sub-01_space-X_electrodes.tsv"]);
  });

  it("within one directory, the file with more entities wins", async () => {
    expect(
      await chosen({
        "sub-01/ses-1/ieeg": [
          "sub-01_space-X_electrodes.tsv",
          "sub-01_task-A_space-X_electrodes.tsv",
        ],
      }),
    ).toEqual(["sub-01/ses-1/ieeg/sub-01_task-A_space-X_electrodes.tsv"]);
  });

  it("the dataset root is walked, and a file there applies when its entities match", async () => {
    expect(await chosen({ "": ["task-A_space-X_electrodes.tsv"] })).toEqual([
      "task-A_space-X_electrodes.tsv",
    ]);
    expect(await chosen({ "": ["task-B_space-X_electrodes.tsv"] })).toEqual([]);
  });

  it("each space is chosen on its own: a deeper file of one space does not hide another's", async () => {
    expect(
      await chosen({
        "sub-01": ["sub-01_space-Y_electrodes.tsv"],
        "sub-01/ses-1/ieeg": ["sub-01_space-X_electrodes.tsv"],
      }),
    ).toEqual([
      "sub-01/ses-1/ieeg/sub-01_space-X_electrodes.tsv",
      "sub-01/sub-01_space-Y_electrodes.tsv",
    ]);
  });

  it("two files of the same specificity and space give ambiguous, never a pick", async () => {
    // A recording with task-A and acq-B, and one electrodes file for each entity.
    const reader = namesOnly({
      "sub-01/ieeg": [
        "sub-01_task-A_space-X_electrodes.tsv",
        "sub-01_acq-B_space-X_electrodes.tsv",
      ],
    });
    let reads = 0;
    const g = await resolve("none", "v0", "sub-01/ieeg/sub-01_task-A_acq-B_ieeg.edf", {
      listDir: reader.listDir,
      readText: async (p) => {
        reads += 1;
        return reader.readText(p);
      },
    });
    expect(g.reason).toBe("ambiguous");
    expect(g.spaces).toHaveLength(1);
    expect(g.spaces[0].space).toBe("X");
    expect(g.spaces[0].electrodesPath).toBeNull();
    expect(g.spaces[0].tiedPaths).toEqual([
      "sub-01/ieeg/sub-01_acq-B_space-X_electrodes.tsv",
      "sub-01/ieeg/sub-01_task-A_space-X_electrodes.tsv",
    ]);
    expect(g.spaces[0].contacts).toEqual([]);
    expect(reads).toBe(0);
  });

  it("a tie in one space leaves the other spaces offered", async () => {
    const g = await resolve(
      "none",
      "v0",
      "sub-01/ieeg/sub-01_task-A_acq-B_ieeg.edf",
      namesOnly({
        "sub-01/ieeg": [
          "sub-01_task-A_space-X_electrodes.tsv",
          "sub-01_acq-B_space-X_electrodes.tsv",
          "sub-01_space-Y_electrodes.tsv",
        ],
      }),
    );
    expect(g.spaces.map((s) => [s.space, s.reason])).toEqual([
      ["X", "ambiguous"],
      ["Y", "unreadable"],
    ]);
  });
});

describe("reasons: no coordinates, all zero, unreadable, no file", () => {
  it("nm000537: every x, y, z is n/a, so the reason is no_coordinates and no contact is placed", async () => {
    const g = await resolve("nm000537", "v1.0.2", SUB369);
    expect(g.reason).toBe("no_coordinates");
    const s = only(g, "Other");
    expect(s.reason).toBe("no_coordinates");
    expect(s.contacts).toEqual([]);
    // The file really has 256 named rows, all n/a: the refusal is not an empty read.
    const raw = table(
      fixtureText("nm000537", "v1.0.2", "sub-369/ieeg/sub-369_space-Other_electrodes.tsv"),
    );
    expect(s.rowCount).toBe(raw.length);
    expect(raw.every((r) => r.x === "n/a" && r.y === "n/a" && r.z === "n/a")).toBe(true);
  });

  it("nm000406: the same reason for a microelectrode release with n/a positions", async () => {
    const g = await resolve("nm000406", "v1.0.2", NM406_LEFT);
    expect(g.reason).toBe("no_coordinates");
  });

  it("on003844: every contact at the origin gives all_zero", async () => {
    const g = await resolve("on003844", "v1.0.0", ON3844);
    expect(g.reason).toBe("all_zero");
    expect(g.spaces[0].contacts).toEqual([]);
    expect(g.spaces[0].rowCount).toBe(32);
  });

  it("on004100: a file that places some contacts and leaves others n/a keeps all rows, with null positions", async () => {
    const g = await resolve("on004100", "v1.0.0", HUP060);
    expect(g.reason).toBeNull();
    const s = only(g, "fsaverage");
    const raw = table(
      fixtureText(
        "on004100",
        "v1.0.0",
        "sub-HUP060/ses-presurgery/ieeg/sub-HUP060_ses-presurgery_acq-seeg_space-fsaverage_electrodes.tsv",
      ),
    );
    expect(s.contacts).toHaveLength(raw.length);
    const placed = raw.filter((r) => r.x !== "n/a");
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.length).toBeLessThan(raw.length);
    expect(s.contacts.filter((c) => c.position !== null)).toHaveLength(placed.length);
    expect(contact(s, "C3").position).toBeNull();
  });

  it("on006253: rows without a name are skipped and counted, and NaN is not a position", async () => {
    const g = await resolve("on006253", "v1.0.0", ON6253);
    const mni = only(g, "mni");
    const raw = table(fixtureText("on006253", "v1.0.0", "sub-01/sub-01_space-mni_electrodes.tsv"));
    const unnamed = raw.filter((r) => r.name.trim() === "");
    expect(unnamed.length).toBeGreaterThan(0);
    expect(mni.skippedRows).toBe(unnamed.length);
    expect(mni.rowCount).toBe(raw.length - unnamed.length);
    expect(unnamed.every((r) => r.x === "NaN")).toBe(true);
  });

  it("on001785: a coordsystem that is not JSON is unreadable, not an unknown frame", async () => {
    const g = await resolve("on001785", "v1.0.0", ON1785);
    expect(g.reason).toBe("unreadable");
    expect(g.spaces[0].space).toBe("postimplant");
    expect(g.spaces[0].frame).toBeNull();
    expect(() =>
      JSON.parse(
        fixtureText(
          "on001785",
          "v1.0.0",
          "sub-patient/ses-01/ieeg/sub-patient_ses-01_space-postimplant_coordsystem.json",
        ),
      ),
    ).toThrow();
  });

  it("a file that cannot be read is unreadable, and the read is not retried as another space", async () => {
    const tree = treeReader("nm000454", "v1.0.2");
    const g = await resolve("nm000454", "v1.0.2", NM454, {
      listDir: tree.listDir,
      readText: async (p) => (p.endsWith("_electrodes.tsv") ? null : tree.readText(p)),
    });
    expect(g.reason).toBe("unreadable");
    expect(g.spaces).toHaveLength(1);
  });

  it("on004642: a real directory with channels but no electrodes file is no_electrodes_file", async () => {
    const g = await resolve("on004642", "v1.0.0", ON4642);
    expect(g.reason).toBe("no_electrodes_file");
    expect(g.spaces).toEqual([]);
  });
});

describe("units: declared, scaled, or left as written", () => {
  /** The first contact of a real electrodes file with a numeric position, read independently. */
  function firstPlaced(text: string) {
    const row = table(text).find((r) => r.x !== "n/a" && r.x !== "NaN" && r.x !== "");
    expect(row).toBeDefined();
    return row as Record<string, string>;
  }

  it("on004100 (fsaverage) and on005415 (ACPC): meters become millimeters, one contact against its file value times 1000", async () => {
    const cases: [string, string, string, string][] = [
      [
        "on004100",
        HUP060,
        "sub-HUP060/ses-presurgery/ieeg/sub-HUP060_ses-presurgery_acq-seeg_space-fsaverage_electrodes.tsv",
        "fsaverage",
      ],
      ["on005415", SUB72, "sub-72/ieeg/sub-72_space-ACPC_electrodes.tsv", "ACPC"],
    ];
    // The declared unit decides, never the magnitude: on004100's values are millimeter-sized
    // (17.7791 for a contact) under a declared `m`, and they still scale by 1000.
    for (const [id, recording, electrodes, space] of cases) {
      const s = only(await resolve(id, "v1.0.0", recording), space);
      expect(s.units).toEqual({ declared: "m", unit: "mm", scaleToMm: 1000, unitsDeclared: true });
      const row = firstPlaced(fixtureText(id, "v1.0.0", electrodes));
      const c = contact(s, row.name);
      expect(c.position).toEqual([
        Number(row.x) * 1000,
        Number(row.y) * 1000,
        Number(row.z) * 1000,
      ]);
    }
  });

  it("nm000454: millimeters stay as they are", async () => {
    const s = only(await resolve("nm000454", "v1.0.2", NM454), "MNI152NLin2009cAsym");
    expect(s.units).toEqual({ declared: "mm", unit: "mm", scaleToMm: 1, unitsDeclared: true });
    const row = firstPlaced(
      fixtureText(
        "nm000454",
        "v1.0.2",
        "sub-PID02/ses-clinical01/ieeg/sub-PID02_ses-clinical01_space-MNI152NLin2009cAsym_electrodes.tsv",
      ),
    );
    expect(contact(s, row.name).position).toEqual([Number(row.x), Number(row.y), Number(row.z)]);
  });

  it("nm000373: units n/a are not declared, and the values stay as written", async () => {
    const s = only(await resolve("nm000373", "v1.0.2", NM373), "MNI152NLin6Asym");
    expect(s.units).toEqual({ declared: "n/a", unit: null, scaleToMm: null, unitsDeclared: false });
    const row = firstPlaced(
      fixtureText("nm000373", "v1.0.2", "sub-01/ieeg/sub-01_space-MNI152NLin6Asym_electrodes.tsv"),
    );
    expect(contact(s, row.name).position).toEqual([Number(row.x), Number(row.y), Number(row.z)]);
  });

  it("on004370: with no coordsystem file there are no units, and nothing is inferred from magnitudes", async () => {
    const g = await resolve("on004370", "v1.0.0", ON4370);
    const s = only(g, null);
    expect(s.coordsystemPath).toBeNull();
    expect(s.units).toEqual({ declared: null, unit: null, scaleToMm: null, unitsDeclared: false });
    const row = firstPlaced(
      fixtureText("on004370", "v1.0.0", "sub-PRIOS01/ses-1/ieeg/sub-PRIOS01_ses-1_electrodes.tsv"),
    );
    expect(contact(s, row.name).position).toEqual([Number(row.x), Number(row.y), Number(row.z)]);
  });
});

describe("frames: classified, never promoted", () => {
  it("on005522: a declared MNI152NLin6ASym is the template, with no normalization", async () => {
    const s = only(await resolve("on005522", "v1.0.0", R1001P), "MNI152NLin6ASym");
    expect(s.frame).toEqual({
      kind: "template",
      declared: "MNI152NLin6ASym",
      identifier: "MNI152NLin6ASym",
      caseNormalized: false,
    });
  });

  it("nm000373: a declared MNI152NLin6Asym is the same template, flagged as normalized from letter case", async () => {
    const s = only(await resolve("nm000373", "v1.0.2", NM373), "MNI152NLin6Asym");
    expect(s.frame).toEqual({
      kind: "template",
      declared: "MNI152NLin6Asym",
      identifier: "MNI152NLin6ASym",
      caseNormalized: true,
    });
  });

  it("nm000405: space-mni against a declared Other is an unknown frame, whatever its description says", async () => {
    const s = only(await resolve("nm000405", "v1.0.3", NM405), "mni");
    expect(s.frame).toEqual({
      kind: "unknown",
      why: "space_mismatch",
      declared: "Other",
      spaceEntity: "mni",
    });
    // The description names MNI space; it is carried verbatim and promotes nothing.
    expect(s.description).toMatch(/MNI space/);
    expect(s.frame).not.toHaveProperty("identifier");
  });

  it("nm000377: Other is a described frame carrying its description verbatim, and no template", async () => {
    const s = only(await resolve("nm000377", "v1.0.2", EC192), "Other");
    const written = JSON.parse(
      fixtureText("nm000377", "v1.0.2", "sub-EC192/ieeg/sub-EC192_space-Other_coordsystem.json"),
    ).iEEGCoordinateSystemDescription;
    expect(s.frame).toEqual({ kind: "described", declared: "Other", description: written });
    expect(s.frame).not.toHaveProperty("identifier");
    expect(s.description).toBe(written);
  });

  it("on005415 and on004473: ACPC and ScanRAS are native", async () => {
    expect(only(await resolve("on005415", "v1.0.0", SUB72), "ACPC").frame).toEqual({
      kind: "native",
      declared: "ACPC",
    });
    expect(only(await resolve("on004473", "v1.0.0", ON4473), "ScanRAS").frame).toEqual({
      kind: "native",
      declared: "ScanRAS",
    });
  });

  it("known-answer labels: a label that equals no standard identifier is unknown, with no prefix or partial match", () => {
    // `mni`, `MNI` and `MNI152` are the non-standard labels the data census found as `space`
    // entities; no public coordsystem file declares them, so they are given here as labels.
    for (const label of [
      "mni",
      "MNI",
      "MNI152",
      "MNI152NLin6",
      "fsaverage5",
      "Talairach88",
      "acpc",
    ]) {
      expect(classifyFrame(label, null, null), label).toEqual({
        kind: "unknown",
        why: "unrecognized_label",
        declared: label,
        spaceEntity: null,
      });
    }
  });

  it("known-answer labels: case is ignored for template identifiers only", () => {
    expect(classifyFrame("mni152nlin6asym", null, null)).toMatchObject({
      kind: "template",
      identifier: "MNI152NLin6ASym",
      caseNormalized: true,
    });
    expect(classifyFrame("FSAVERAGE", "fsaverage", null)).toMatchObject({
      kind: "template",
      identifier: "fsaverage",
      caseNormalized: true,
    });
    expect(classifyFrame("Pixels", null, null)).toEqual({ kind: "pixels", declared: "Pixels" });
    expect(classifyFrame("Other", null, null)).toEqual({
      kind: "described",
      declared: "Other",
      description: null,
    });
    expect(classifyFrame(null, "ACPC", null)).toMatchObject({
      kind: "unknown",
      why: "not_declared",
    });
  });

  it("known-answer labels: a space entity that disagrees with a template label makes the frame unknown", () => {
    expect(classifyFrame("MNI152Lin", "Talairach", null)).toEqual({
      kind: "unknown",
      why: "space_mismatch",
      declared: "MNI152Lin",
      spaceEntity: "Talairach",
    });
  });

  it("the template table is the BIDS appendix's standard template table", () => {
    const md = fixtureText(
      "bids-specification",
      "074ae6ffcdcfa27f07e131f42a545574f20675c8",
      "src/appendices/coordinate-systems.md",
    );
    const start = md.indexOf("### Standard template identifiers");
    const end = md.indexOf("The following template identifiers are retained");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const names: string[] = [];
    for (const line of md.slice(start, end).split("\n")) {
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
    expect(names.length).toBeGreaterThan(15);
    expect([...STANDARD_TEMPLATES].sort()).toEqual([...names].sort());
  });
});

describe("joins: exact names, then bipolar pairs", () => {
  const names = (path: string) => table(path).map((r) => r.name);

  it("on005522: every bipolar channel joins its two contacts and sits at their midpoint", async () => {
    const g = await resolve("on005522", "v1.0.0", R1001P);
    const s = only(g, "MNI152NLin6ASym");
    const channels = names(
      fixtureText(
        "on005522",
        "v1.0.0",
        "sub-R1001P/ses-0/ieeg/sub-R1001P_ses-0_task-YC1_acq-bipolar_channels.tsv",
      ),
    );
    const joins = joinChannels(s, channels);
    expect(joins).toHaveLength(channels.length);
    expect(joins.every((j) => j.status === "bipolar" && j.cause === null)).toBe(true);

    const first = joins[0];
    expect(first.channel).toBe("LAF1-LAF2");
    expect(first.contacts).toEqual(["LAF1", "LAF2"]);
    const a = contact(s, "LAF1").position as readonly number[];
    const b = contact(s, "LAF2").position as readonly number[];
    expect(first.position).toEqual([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    // The midpoint is neither contact: joining by the first name only would put it on LAF1.
    expect(first.position).not.toEqual(a);
  });

  it("on005522: monopolar channels join by exact name", async () => {
    const s = only(await resolve("on005522", "v1.0.0", R1001P), "MNI152NLin6ASym");
    const channels = names(
      fixtureText(
        "on005522",
        "v1.0.0",
        "sub-R1001P/ses-0/ieeg/sub-R1001P_ses-0_task-YC1_acq-monopolar_channels.tsv",
      ),
    );
    const joins = joinChannels(s, channels);
    expect(joins.every((j) => j.status === "located" && j.contacts.length === 1)).toBe(true);
    expect(joins[0].position).toEqual(contact(s, channels[0]).position);
  });

  it("nm000376: a contact named for the pair is joined by its exact name, not split", async () => {
    const s = only(await resolve("nm000376", "v1.0.2", NM376), "IXI549Space");
    const channels = names(
      fixtureText("nm000376", "v1.0.2", "sub-P1/ieeg/sub-P1_task-memact_channels.tsv"),
    );
    expect(channels).toContain("A1-A2");
    const j = joinChannels(s, ["A1-A2"])[0];
    expect(j).toMatchObject({ status: "located", contacts: ["A1-A2"], cause: null });
    expect(j.position).toEqual(contact(s, "A1-A2").position);
  });

  it("on006136: a hyphen inside a contact name is not a pair, and two hyphenated contacts still pair", async () => {
    const s = only(await resolve("on006136", "v1.0.0", ON6136), null);
    expect(joinChannels(s, ["LMTG-23"])[0]).toMatchObject({
      status: "located",
      contacts: ["LMTG-23"],
    });
    const pair = joinChannels(s, ["LMTG-23-LMTG-24", "LMTG-23 - LMTG-24"]);
    for (const j of pair) {
      expect(j).toMatchObject({ status: "bipolar", contacts: ["LMTG-23", "LMTG-24"] });
    }
  });

  it("a channel that joins nothing is unlocated, and there is no case folding or prefix match", async () => {
    const s = only(await resolve("on005522", "v1.0.0", R1001P), "MNI152NLin6ASym");
    for (const name of ["laf1-laf2", "LAF", "LAF1-LAF", "LAF1-NOPE", "Fz", ""]) {
      expect(joinChannels(s, [name])[0], name).toMatchObject({
        status: "unlocated",
        cause: "no_contact",
        contacts: [],
        position: null,
      });
    }
  });

  it("on004100: a contact the file leaves n/a is unlocated with its own cause, never a fall-through", async () => {
    const s = only(await resolve("on004100", "v1.0.0", HUP060), "fsaverage");
    expect(joinChannels(s, ["C3"])[0]).toMatchObject({
      status: "unlocated",
      cause: "no_position",
      contacts: ["C3"],
      position: null,
    });
    const placed = s.contacts.find((c) => c.position !== null && !c.name.includes("-"));
    const other = s.contacts.find((c) => c.position !== null && c !== placed);
    expect(placed && other).toBeTruthy();
    expect(joinChannels(s, [`${placed?.name}-C3`])[0]).toMatchObject({
      status: "unlocated",
      cause: "no_position",
    });
  });

  // Known-answer inputs, like the classifyFrame label table: no public electrodes file repeats a
  // contact name or holds contacts whose names make two `-` splits. Each space below is the real
  // on005522 space from resolve(), with its contact rows replaced by rows built from real ones.
  describe("duplicate and ambiguous names (known-answer contacts)", () => {
    const real = async () => only(await resolve("on005522", "v1.0.0", R1001P), "MNI152NLin6ASym");

    it("a name carried by two rows is duplicate_contact, by exact name and inside an A-B pair", async () => {
      const s = await real();
      const first = contact(s, "LAF1");
      const repeated: SpaceGeometry = {
        ...s,
        contacts: [...s.contacts, { ...first, position: [1, 2, 3], row: s.contacts.length }],
      };
      expect(joinChannels(repeated, ["LAF1"])[0]).toEqual({
        channel: "LAF1",
        status: "unlocated",
        contacts: ["LAF1"],
        position: null,
        cause: "duplicate_contact",
      });
      expect(joinChannels(repeated, ["LAF1-LAF2"])[0]).toEqual({
        channel: "LAF1-LAF2",
        status: "unlocated",
        contacts: ["LAF1", "LAF2"],
        position: null,
        cause: "duplicate_contact",
      });
      // Every other join is unchanged by the repeat.
      expect(joinChannels(repeated, ["LAF2"])[0]).toMatchObject({ status: "located", cause: null });
      expect(joinChannels(repeated, ["LAF3-LAF4"])[0]).toMatchObject({
        status: "bipolar",
        contacts: ["LAF3", "LAF4"],
        cause: null,
      });
    });

    it("a channel that two `-` splits both read as two contacts is ambiguous_pair, never the first split", async () => {
      const s = await real();
      const [a, b, c, d] = ["LAF1", "LAF2", "LAF3", "LAF4"].map((n) => contact(s, n));
      // Contacts A, B-C, A-B and C: "A-B-C" is "A" + "B-C" and also "A-B" + "C".
      const named = (name: string, from: typeof a, row: number) => ({ ...from, name, row });
      const lookalike: SpaceGeometry = {
        ...s,
        contacts: [named("A", a, 0), named("B-C", b, 1), named("A-B", c, 2), named("C", d, 3)],
      };
      expect(joinChannels(lookalike, ["A-B-C"])[0]).toEqual({
        channel: "A-B-C",
        status: "unlocated",
        contacts: [],
        position: null,
        cause: "ambiguous_pair",
      });
      // Every other join is unchanged: exact names first, and a single split still pairs.
      expect(joinChannels(lookalike, ["A-B"])[0]).toMatchObject({
        status: "located",
        contacts: ["A-B"],
      });
      expect(joinChannels(lookalike, ["B-C"])[0]).toMatchObject({
        status: "located",
        contacts: ["B-C"],
      });
      expect(joinChannels(lookalike, ["A-C"])[0]).toMatchObject({
        status: "bipolar",
        contacts: ["A", "C"],
        position: [
          ((a.position as readonly number[])[0] + (d.position as readonly number[])[0]) / 2,
          ((a.position as readonly number[])[1] + (d.position as readonly number[])[1]) / 2,
          ((a.position as readonly number[])[2] + (d.position as readonly number[])[2]) / 2,
        ],
      });
    });
  });
});

describe("listing and reading failures", () => {
  it("a recording whose directory the data plane does not list is listing_failed, not no_electrodes_file", async () => {
    // A directory the tree does not hold answers null, as the data plane's 404 does.
    const g = await resolve("on005522", "v1.0.0", "sub-GONE/ses-0/ieeg/sub-GONE_task-YC1_ieeg.edf");
    expect(g.reason).toBe("listing_failed");
    expect(g.spaces).toEqual([]);
    expect(g.reason).not.toBe((await resolve("on004642", "v1.0.0", ON4642)).reason);
  });

  it("a failed listing of the dataset root alone fails the whole recording", async () => {
    const tree = treeReader("on005522", "v1.0.0");
    const g = await resolve("on005522", "v1.0.0", R1001P, {
      listDir: async (p) => (p === "" ? null : tree.listDir(p)),
      readText: tree.readText,
    });
    expect(g.reason).toBe("listing_failed");
  });

  it("a listing request that throws is a failed listing", async () => {
    const tree = treeReader("on005522", "v1.0.0");
    const g = await resolve("on005522", "v1.0.0", R1001P, {
      listDir: async () => {
        throw new Error("network down");
      },
      readText: tree.readText,
    });
    expect(g.reason).toBe("listing_failed");
  });
});

describe("dataPlaneSource, over real HTTP", () => {
  const rootListing = () =>
    fs.readFileSync(repoPath(`${FIXTURES}/on005522/v1.0.0/__listing.json`), "utf8");

  it("lists a directory through the real client and reads a file's text", async () => {
    const listing = await serveStatus(200, rootListing());
    const body = fixtureText(
      "nm000373",
      "v1.0.2",
      "sub-01/ieeg/sub-01_space-MNI152NLin6Asym_coordsystem.json",
    );
    const file = await serveStatus(200, body);
    try {
      const listed = await dataPlaneSource("on005522", "v1.0.0", {
        dataBase: listing.origin,
      }).listDir("");
      expect(listed?.children.map((c) => c.name)).toContain("dataset_description.json");
      const read = await dataPlaneSource("nm000373", "v1.0.2", { dataBase: file.origin }).readText(
        "sub-01/ieeg/sub-01_space-MNI152NLin6Asym_coordsystem.json",
      );
      expect(read).toBe(body);
    } finally {
      await listing.close();
      await file.close();
    }
  });

  it("a server that says no, or no server at all, is null, and the recording is listing_failed", async () => {
    const refusing = await serveStatus(500, "");
    const missing = await serveStatus(404, "");
    const dead = await closedLocalOrigin();
    try {
      for (const dataBase of [refusing.origin, missing.origin, dead]) {
        const source = dataPlaneSource("on005522", "v1.0.0", { dataBase });
        expect(await source.listDir("")).toBeNull();
        expect(await source.readText("README.md")).toBeNull();
        const g = await resolveRecordingGeometry({
          datasetId: "on005522",
          version: "v1.0.0",
          recording: R1001P,
          ...source,
        });
        expect(g.reason).toBe("listing_failed");
      }
    } finally {
      await refusing.close();
      await missing.close();
    }
  });
});

describe("the closed set of reasons", () => {
  it("every reason the fixtures produce is in the set", async () => {
    const seen = new Set<string>();
    const runs: [string, string, string][] = [
      ["nm000537", "v1.0.2", SUB369],
      ["on003844", "v1.0.0", ON3844],
      ["on001785", "v1.0.0", ON1785],
      ["on004642", "v1.0.0", ON4642],
    ];
    for (const [id, ver, rec] of runs) {
      const g = await resolve(id, ver, rec);
      if (g.reason) seen.add(g.reason);
      for (const s of g.spaces) if (s.reason) seen.add(s.reason);
    }
    expect([...seen].sort()).toEqual(
      ["all_zero", "no_coordinates", "no_electrodes_file", "unreadable"].sort(),
    );
    for (const reason of seen) expect(GEOMETRY_REASONS).toContain(reason);
    expect(new Set(GEOMETRY_REASONS).size).toBe(7);
  });
});

describe("fixture provenance", () => {
  interface Source {
    dataset: string;
    version: string;
    kind: "file" | "listing";
    path: string;
    stored_as: string;
    bytes: number;
    sha256: string;
  }
  const sources = JSON.parse(fs.readFileSync(repoPath(`${FIXTURES}/SOURCES.json`), "utf8")) as {
    files: Source[];
  };

  it("names dataset, version, path and SHA-256 for every file, and each hash recomputes", async () => {
    expect(sources.files.length).toBeGreaterThan(50);
    for (const s of sources.files) {
      expect(s.dataset && s.version && s.path !== undefined && s.sha256, s.stored_as).toBeTruthy();
      const bytes = fs.readFileSync(repoPath(`${FIXTURES}/${s.stored_as}`));
      expect(bytes.byteLength, s.stored_as).toBe(s.bytes);
      expect(await sha256Hex(bytes), s.stored_as).toBe(s.sha256);
    }
  });

  it("lists every file under the fixture directory", () => {
    const listed = new Set(sources.files.map((s) => s.stored_as));
    const walk = (dir: string): string[] =>
      fs.readdirSync(repoPath(`${FIXTURES}/${dir}`)).flatMap((entry) => {
        const rel = dir === "" ? entry : `${dir}/${entry}`;
        return fs.statSync(repoPath(`${FIXTURES}/${rel}`)).isDirectory() ? walk(rel) : [rel];
      });
    const onDisk = walk("").filter((p) => p !== "SOURCES.json");
    expect(onDisk.sort()).toEqual([...listed].sort());
  });

  it("holds at most 2 MB", () => {
    const total = sources.files.reduce((n, s) => n + s.bytes, 0);
    expect(total).toBeLessThan(2 * 1024 * 1024);
  });
});
