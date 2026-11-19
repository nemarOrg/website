import { describe, expect, it } from "vitest";
import type { DirListingEntry } from "../src/lib/dir-listing";
import {
  type ListDir,
  type ReadText,
  resolveRecordingGeometry,
} from "../src/lib/ieeg-spatial/geometry";
import { closedLocalOrigin, nodeFs, repoPath, serveStatus } from "../test/node";
import {
  type Classified,
  Net,
  classifyGeometry,
  frameLabel,
  parseArgs,
  recordingNames,
} from "./ieeg-geometry-census";

/**
 * Every input is a real public file or directory listing of the NEMAR data plane, committed byte
 * for byte under test/fixtures/ieeg-geometry (SOURCES.json names dataset, version, path and
 * SHA-256 of each). The readers answer from those files; a directory the tree does not hold
 * answers null, as the data plane's 404 does. Two inputs are known-answer values and say so: the
 * dotfile name appended to a real listing, and the argument vectors of `parseArgs`.
 */

const fs = await nodeFs();
const FIXTURES = "test/fixtures/ieeg-geometry";

type Child = DirListingEntry;
type Reader = { listDir: ListDir; readText: ReadText };

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

/** The version directory committed for a fixture dataset. */
function fixtureVersion(datasetId: string): string {
  const versions = fs.readdirSync(repoPath(`${FIXTURES}/${datasetId}`));
  expect(versions).toHaveLength(1);
  return versions[0];
}

/** Recordings found the way the census finds them: each subject's (and session's) `ieeg` listing. */
async function recordingsOf(reader: Reader): Promise<string[]> {
  const kids = async (path: string) => ((await reader.listDir(path))?.children ?? []) as Child[];
  const found: string[] = [];
  for (const sub of (await kids("")).filter((c) => c.kind === "dir" && c.name.startsWith("sub-"))) {
    const subKids = await kids(sub.name);
    const dirs = [
      sub.name,
      ...subKids.filter((c) => c.name.startsWith("ses-")).map((c) => `${sub.name}/${c.name}`),
    ];
    for (const dir of dirs) {
      if (!(await kids(dir)).some((c) => c.kind === "dir" && c.name === "ieeg")) continue;
      for (const name of recordingNames(await kids(`${dir}/ieeg`)))
        found.push(`${dir}/ieeg/${name}`);
    }
  }
  return found;
}

async function classifyAll(datasetId: string): Promise<Classified[]> {
  const version = fixtureVersion(datasetId);
  const reader = treeReader(datasetId, version);
  const out: Classified[] = [];
  for (const recording of await recordingsOf(reader)) {
    out.push(
      classifyGeometry(
        await resolveRecordingGeometry({ datasetId, version, recording, ...reader }),
      ),
    );
  }
  return out;
}

interface Expected {
  id: string;
  recordings: number;
  cls: "template" | "native" | "refused";
  reason?: string;
  nativeWhy?: string;
}

const EXPECTED: Expected[] = [
  { id: "on005522", recordings: 4, cls: "template" },
  { id: "nm000454", recordings: 127, cls: "template" },
  { id: "on004100", recordings: 5, cls: "template" },
  { id: "nm000376", recordings: 1, cls: "template" },
  { id: "on006136", recordings: 1, cls: "template" },
  { id: "nm000485", recordings: 3, cls: "template" },
  { id: "on005415", recordings: 1, cls: "native", nativeWhy: "native_or_described" },
  { id: "nm000377", recordings: 3, cls: "native", nativeWhy: "native_or_described" },
  { id: "nm000405", recordings: 4, cls: "native", nativeWhy: "unlabeled" },
  { id: "on004370", recordings: 2, cls: "native", nativeWhy: "unlabeled" },
  { id: "on004457", recordings: 1, cls: "native", nativeWhy: "native_or_described" },
  { id: "on004473", recordings: 1, cls: "native", nativeWhy: "native_or_described" },
  { id: "nm000373", recordings: 3, cls: "native", nativeWhy: "template_units_undeclared" },
  { id: "nm000537", recordings: 3, cls: "refused", reason: "no_coordinates" },
  { id: "nm000406", recordings: 66, cls: "refused", reason: "no_coordinates" },
  { id: "on001785", recordings: 4, cls: "refused", reason: "unreadable" },
  { id: "on003844", recordings: 1, cls: "refused", reason: "all_zero" },
  { id: "on004642", recordings: 1, cls: "refused", reason: "no_electrodes_file" },
];

describe("classification of the committed fixture recordings", () => {
  for (const e of EXPECTED) {
    it(`${e.id}: ${e.recordings} recording(s), all ${e.cls}${e.reason ? ` (${e.reason})` : ""}${e.nativeWhy ? ` (${e.nativeWhy})` : ""}`, async () => {
      const classes = await classifyAll(e.id);
      expect(classes).toHaveLength(e.recordings);
      for (const c of classes) {
        expect(c.class).toBe(e.cls);
        expect(c.reason).toBe(e.reason ?? null);
        expect(c.nativeWhy).toBe(e.nativeWhy ?? null);
      }
    });
  }

  it("the 18 datasets hold 231 recordings in all", () => {
    expect(EXPECTED.reduce((a, e) => a + e.recordings, 0)).toBe(231);
  });

  it("on006253 holds electrodes and channels files but no _ieeg data entry, so no recording", async () => {
    expect(await classifyAll("on006253")).toHaveLength(0);
  });
});

describe("recordingNames", () => {
  const listing = async (id: string, path: string): Promise<Child[]> =>
    ((await treeReader(id, fixtureVersion(id)).listDir(path))?.children ?? []) as Child[];

  it("counts a BrainVision set (.vhdr, .eeg, .vmrk beside a .json sidecar) once per stem", async () => {
    const names = recordingNames(await listing("nm000377", "sub-EC192/ieeg"));
    expect(names).toEqual([
      "sub-EC192_task-heights_ieeg.eeg",
      "sub-EC192_task-noheights_ieeg.eeg",
      "sub-EC192_task-sharks_ieeg.eeg",
    ]);
  });

  it("counts a .mefd recording directory once, ahead of its .json sidecar", async () => {
    expect(recordingNames(await listing("on004457", "sub-2/ses-ieeg01/ieeg"))).toEqual([
      "sub-2_ses-ieeg01_task-ccep_run-01_ieeg.mefd",
    ]);
  });

  it("does not count a sidecar whose data entry is absent", async () => {
    const sidecarsOnly = (await listing("nm000377", "sub-EC192/ieeg")).filter(
      (c) => !c.name.includes("_ieeg.") || c.name.endsWith("_ieeg.json"),
    );
    expect(sidecarsOnly.some((c) => c.name.endsWith("_ieeg.json"))).toBe(true);
    expect(recordingNames(sidecarsOnly)).toEqual([]);
  });

  it("skips a dotfile (known-answer name added to a real listing)", async () => {
    const real = await listing("on004473", "sub-1/ieeg");
    const withDotfile = [
      ...real,
      { kind: "file" as const, name: "._sub-1_task-SlowFast_ieeg.edf", size: 0 },
    ];
    expect(recordingNames(withDotfile)).toEqual(["sub-1_task-SlowFast_ieeg.edf"]);
  });
});

describe("recordings that offer two spaces", () => {
  async function onlyRecording(id: string) {
    const version = fixtureVersion(id);
    const reader = treeReader(id, version);
    const [recording] = await recordingsOf(reader);
    return resolveRecordingGeometry({ datasetId: id, version, recording, ...reader });
  }

  it("on004473 offers ACPC and ScanRAS and is native", async () => {
    const geometry = await onlyRecording("on004473");
    const c = classifyGeometry(geometry);
    expect(geometry.spaces).toHaveLength(2);
    expect(c.spaces).toEqual(["ACPC", "ScanRAS"]);
    expect(c.frames).toEqual(["ACPC", "ScanRAS"]);
    expect(geometry.spaces.map((s) => (s.frame ? frameLabel(s.frame) : null))).toEqual(c.frames);
    expect(c.class).toBe("native");
  });

  it("nm000485 offers Other and Talairach and is template through Talairach", async () => {
    const geometry = await onlyRecording("nm000485");
    const c = classifyGeometry(geometry);
    expect(geometry.spaces).toHaveLength(2);
    expect(c.spaces).toEqual(["Other", "Talairach"]);
    expect(c.frames).toEqual(["Other", "Talairach"]);
    expect(c.class).toBe("template");
  });
});

describe("parseArgs", () => {
  it("takes the documented options", () => {
    expect(parseArgs(["--out", "o", "--resume", "--only", "a,b", "--rounds", "3"])).toEqual({
      out: "o",
      resume: true,
      only: ["a", "b"],
      rounds: 3,
      help: false,
    });
  });
  it("answers --help without --out", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });
  it("requires --out", () => {
    expect(() => parseArgs([])).toThrow(/--out is required/);
  });
  it("rejects a rounds value that is not a positive integer", () => {
    for (const bad of ["0", "-1", "2.5", "x", ""]) {
      expect(() => parseArgs(["--out", "o", "--rounds", bad])).toThrow();
    }
  });
  it("rejects a missing value and an unknown argument", () => {
    expect(() => parseArgs(["--out"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--out", "o", "--nope"])).toThrow(/unknown argument/);
  });
});

describe("Net.get against real local servers", () => {
  const fast = { maxAttempts: 3, backoffBaseMs: 1 };

  it("reads a 404 and a 410 as a definitive absence, with no retry", async () => {
    for (const status of [404, 410]) {
      const server = await serveStatus(status, "gone");
      try {
        const net = new Net(fast);
        expect(await net.get(`${server.origin}/x`)).toEqual({ kind: "absent", status });
        expect(net.stats.attempts).toBe(1);
        expect(net.stats.exhausted).toBe(0);
      } finally {
        await server.close();
      }
    }
  });

  it("never reads 401, 403, 408, 429 or 500 as an absence: it retries and ends transient", async () => {
    for (const status of [401, 403, 408, 429, 500]) {
      const server = await serveStatus(status, "no");
      try {
        const net = new Net(fast);
        expect(await net.get(`${server.origin}/x`)).toEqual({ kind: "transient", status });
        expect(net.stats.attempts).toBe(3);
        expect(net.stats.exhausted).toBe(1);
        expect(net.stats.absent).toEqual({});
      } finally {
        await server.close();
      }
    }
  });

  it("treats a refused connection as transient", async () => {
    const net = new Net(fast);
    expect(await net.get(`${await closedLocalOrigin()}/x`)).toEqual({
      kind: "transient",
      status: null,
    });
    expect(net.stats.failedAttempts.network).toBe(3);
  });

  it("returns a 200 body", async () => {
    const server = await serveStatus(200, '{"a":1}');
    try {
      expect(await new Net(fast).get(`${server.origin}/x`)).toEqual({
        kind: "ok",
        body: '{"a":1}',
      });
    } finally {
      await server.close();
    }
  });
});
