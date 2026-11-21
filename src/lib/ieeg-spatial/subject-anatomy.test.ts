import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeFs, repoPath } from "../../../test/node";
import {
  IntegrityError,
  MAX_INDEX_BYTES,
  MAX_INDEX_ENTRIES,
  SUBJECT_LABEL,
  type SubjectEntry,
  entryFor,
  fetchGeometryIndex,
  forgetWarnings,
  geometryBaseUrl,
  loadSubjectSurface,
  parseGeometryIndex,
  silhouette,
  subjectLabel,
  subjectNotes,
  subjectOutlines,
} from "./subject-anatomy";

const fs = await nodeFs();
const DIR = "test/fixtures/ieeg-subject-anatomy/on004473/zarr/geometry/";
const indexText = fs.readFileSync(repoPath(`${DIR}index.json`), "utf8");
const ELECTRODES = "sub-1/ieeg/sub-1_space-ACPC_electrodes.tsv";

/** The pipeline's own output, as a fresh object each time so a test may damage it. */
const realIndex = () => JSON.parse(indexText);

/** HTTP answers backed by the committed files, optionally with one file's bytes damaged. */
function server(damage?: (path: string, bytes: Uint8Array) => void) {
  return async (url: string): Promise<Response> => {
    const rel = url.replace(/^.*\/zarr\/geometry\//, "");
    const file = repoPath(`${DIR}${rel}`);
    if (!fs.existsSync(file)) return new Response("no", { status: 404 });
    const bytes = new Uint8Array(fs.readFileSync(file));
    damage?.(rel, bytes);
    return new Response(bytes);
  };
}

afterEach(() => {
  forgetWarnings();
  vi.restoreAllMocks();
});

describe("the index", () => {
  it("reads the pipeline's own index and matches an entry by its electrodes path", () => {
    const parsed = parseGeometryIndex(realIndex());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toHaveLength(1);
    const entry = entryFor(parsed.entries, ELECTRODES);
    expect(entry?.grade).toBe("plausible");
    expect(entry?.hemispheres).toEqual(["L", "R"]);
    expect(entryFor(parsed.entries, "sub-1/ieeg/sub-1_space-ScanRAS_electrodes.tsv")).toBeNull();
    expect(entryFor(parsed.entries, null)).toBeNull();
  });

  it("refuses a document of another schema or version whole", () => {
    expect(parseGeometryIndex({ ...realIndex(), schema: "other" }).ok).toBe(false);
    expect(parseGeometryIndex({ ...realIndex(), version: 2 }).ok).toBe(false);
    expect(parseGeometryIndex([]).ok).toBe(false);
  });

  it("drops an entry with an unknown hemisphere key, a mismatched address or a failed fit", () => {
    type Raw = {
      meshes: Record<string, { sha256: string }>;
      hemispheres: string[];
      fit: { passed: boolean };
      sources: string[];
    };
    const bad = (edit: (e: Raw) => void) => {
      const index = realIndex();
      edit(index.entries[0]);
      const parsed = parseGeometryIndex(index);
      expect(parsed.ok && parsed.entries.length === 0 && parsed.dropped.length === 1).toBe(true);
    };
    bad((e) => {
      e.meshes.X = e.meshes.L;
    });
    bad((e) => {
      e.meshes.L.sha256 = "0".repeat(64);
    });
    bad((e) => {
      e.hemispheres = ["L"];
    });
    bad((e) => {
      e.fit.passed = false;
    });
    bad((e) => {
      e.sources = [];
    });
  });
});

describe("the label and the notes", () => {
  const entry = (grade: "specific" | "plausible", hemispheres: ("L" | "R")[]): SubjectEntry => ({
    electrodes: ELECTRODES,
    grade,
    hemispheres,
    sources: ["derivatives/freesurfer/sub-1/surf/rh.pial"],
    meshes: {},
  });

  it("says approximate alignment for a plausible fit and nothing more for a specific one", () => {
    expect(subjectLabel(entry("specific", ["L", "R"]))).toBe(SUBJECT_LABEL);
    expect(SUBJECT_LABEL).toBe("This subject's anatomy, from the dataset's own surfaces");
    expect(subjectLabel(entry("plausible", ["L", "R"]))).toBe(
      `${SUBJECT_LABEL}; approximate alignment (depth contacts)`,
    );
  });

  it("cites the sources and says a single hemisphere", () => {
    const both = subjectNotes(entry("specific", ["L", "R"]));
    expect(both).toEqual(["Subject surfaces: derivatives/freesurfer/sub-1/surf/rh.pial."]);
    expect(subjectNotes(entry("specific", ["R"]))).toContain(
      "Right hemisphere only: the dataset ships one hemisphere for this subject.",
    );
    expect(subjectNotes(entry("specific", ["L"]))[1]).toMatch(/^Left hemisphere only/);
  });
});

describe("fetching", () => {
  it("builds the address beside the Zarr copy", () => {
    expect(geometryBaseUrl("on004473", "https://zarr.nemar.org/")).toBe(
      "https://zarr.nemar.org/on004473/zarr/geometry/",
    );
  });

  it("a 404 is a dataset without subject anatomy, a 500 is a failure to retry", async () => {
    expect(
      await fetchGeometryIndex("x", { fetch: async () => new Response("", { status: 404 }) }),
    ).toEqual({
      kind: "none",
    });
    await expect(
      fetchGeometryIndex("x", { fetch: async () => new Response("", { status: 500 }) }),
    ).rejects.toThrow(/500/);
  });

  it("an invalid index hides the option with one console warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchWrong = async () => new Response(JSON.stringify({ ...realIndex(), version: 9 }));
    for (let i = 0; i < 3; i++) {
      expect((await fetchGeometryIndex("on004473", { fetch: fetchWrong })).kind).toBe("invalid");
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("loads both hemispheres as one mesh when every check passes", async () => {
    const found = await fetchGeometryIndex("on004473", { fetch: server() });
    expect(found.kind).toBe("found");
    if (found.kind !== "found") return;
    const mesh = await loadSubjectSurface("on004473", found.entries[0], { fetch: server() });
    const refs = Object.values(found.entries[0].meshes);
    expect(mesh.positions.length / 3).toBe(refs.reduce((n, r) => n + (r?.vertices ?? 0), 0));
    expect(mesh.indices.length / 3).toBe(refs.reduce((n, r) => n + (r?.faces ?? 0), 0));
  });

  it("refuses a mesh whose bytes do not match the hash before decoding it", async () => {
    const found = await fetchGeometryIndex("on004473", { fetch: server() });
    if (found.kind !== "found") throw new Error("fixture index");
    const flipped = server((rel, bytes) => {
      if (rel.startsWith("meshes/")) bytes[bytes.length - 1] ^= 1;
    });
    await expect(
      loadSubjectSurface("on004473", found.entries[0], { fetch: flipped }),
    ).rejects.toThrow(/SHA-256/);
  });
});

describe("outlines from the subject's own mesh", () => {
  // A closed cube, 20 mm on a side, centered on the origin.
  const cube = () => {
    const c = [
      [-10, -10, -10],
      [10, -10, -10],
      [10, 10, -10],
      [-10, 10, -10],
      [-10, -10, 10],
      [10, -10, 10],
      [10, 10, 10],
      [-10, 10, 10],
    ].flat();
    const f = [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0,
      4, 7, 0, 7, 3,
    ];
    return { positions: new Float32Array(c), indices: new Uint16Array(f) };
  };

  it("traces one closed polyline around a cube, as wide as the cube", () => {
    const rings = silhouette(cube(), 0, 2);
    expect(rings).toHaveLength(1);
    const xs = rings[0].map((p) => p[0]);
    const zs = rings[0].map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(19);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(21.5);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(19);
  });

  it("names the three views' axes like a template's views.json", () => {
    const out = subjectOutlines(cube());
    expect(out.left.axes).toEqual(["y", "z"]);
    expect(out.top.axes).toEqual(["x", "y"]);
    expect(out.front.axes).toEqual(["x", "z"]);
  });

  it("draws the real subject's mesh within its own extent in every view", async () => {
    const found = await fetchGeometryIndex("on004473", { fetch: server() });
    if (found.kind !== "found") throw new Error("fixture index");
    const mesh = await loadSubjectSurface("on004473", found.entries[0], { fetch: server() });
    const out = subjectOutlines(mesh);
    for (const view of Object.values(out)) {
      expect(view.polylines.length).toBeGreaterThan(0);
      for (const ring of view.polylines) expect(ring.length).toBeGreaterThanOrEqual(3);
    }
    // Front view (x, z): the outline spans the mesh's own x range to within a cell.
    const xs = out.front.polylines.flat().map((p) => p[0]);
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      lo = Math.min(lo, mesh.positions[i]);
      hi = Math.max(hi, mesh.positions[i]);
    }
    expect(Math.min(...xs)).toBeGreaterThan(lo - 1.5);
    expect(Math.max(...xs)).toBeLessThan(hi + 1.5);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(hi - lo - 3);
  });

  it("an empty mesh has no outline", () => {
    expect(silhouette(encodeToMesh(), 0, 1)).toEqual([]);
  });
});

function encodeToMesh() {
  return { positions: new Float32Array(0), indices: new Uint16Array(0) };
}

describe("integrity and transport failures", () => {
  const first = async () => {
    const found = await fetchGeometryIndex("on004473", { fetch: server() });
    if (found.kind !== "found") throw new Error("fixture index");
    return found.entries[0];
  };

  it("hashes before decoding: garbage of the right length fails on the SHA-256, not the decoder", async () => {
    const entry = await first();
    const garbage = async (url: string) => {
      const real = await server()(url);
      return new Response(new Uint8Array((await real.arrayBuffer()).byteLength).fill(7));
    };
    const err = await loadSubjectSurface("on004473", entry, { fetch: garbage }).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrityError);
    expect(String(err.message)).toMatch(/SHA-256/);
  });

  it("refuses a different byte length, declared or streamed", async () => {
    const entry = await first();
    const short = async (url: string) =>
      new Response((await (await server()(url)).arrayBuffer()).slice(0, 100));
    const e1 = await loadSubjectSurface("on004473", entry, { fetch: short }).catch((e) => e);
    expect(e1).toBeInstanceOf(IntegrityError);
    expect(String(e1.message)).toMatch(/bytes/);
    const declared = async (url: string) => {
      const real = await server()(url);
      return new Response(await real.arrayBuffer(), { headers: { "content-length": "5" } });
    };
    const e2 = await loadSubjectSurface("on004473", entry, { fetch: declared }).catch((e) => e);
    expect(e2).toBeInstanceOf(IntegrityError);
    expect(String(e2.message)).toMatch(/declares 5 bytes/);
    // No declared length and too many bytes: cut off at the entry's size.
    const long = async (url: string) => {
      const real = await (await server()(url)).arrayBuffer();
      const bigger = new Uint8Array(real.byteLength + 1000);
      bigger.set(new Uint8Array(real));
      return new Response(bigger);
    };
    const e3 = await loadSubjectSurface("on004473", entry, { fetch: long }).catch((e) => e);
    expect(e3).toBeInstanceOf(IntegrityError);
    expect(String(e3.message)).toMatch(/over/);
  });

  it("refuses counts that disagree with the index after a clean hash", async () => {
    const entry = await first();
    const L = entry.meshes.L;
    if (!L) throw new Error("fixture");
    const wrong: SubjectEntry = {
      ...entry,
      meshes: { L: { ...L, vertices: L.vertices + 1 } },
      hemispheres: ["L"],
    };
    const err = await loadSubjectSurface("on004473", wrong, { fetch: server() }).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrityError);
    expect(String(err.message)).toMatch(/counts disagree/);
  });

  it("a 503, a 403 or a rejected request on a mesh is a transport failure, not integrity", async () => {
    const entry = await first();
    for (const respond of [
      async () => new Response("", { status: 503 }),
      async () => new Response("", { status: 403 }),
      async () => {
        throw new TypeError("network down");
      },
    ]) {
      const err = await loadSubjectSurface("on004473", entry, { fetch: respond }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(IntegrityError);
    }
  });

  it("refuses a hemispheres list that disagrees with the meshes and a path that climbs out", () => {
    const a = realIndex();
    a.entries[0].hemispheres = ["R"];
    expect(parseGeometryIndex(a)).toMatchObject({ ok: true, entries: [] });
    const b = realIndex();
    b.entries[0].meshes.L.path = `../${b.entries[0].meshes.L.path}`;
    expect(parseGeometryIndex(b)).toMatchObject({ ok: true, entries: [] });
    const c = realIndex();
    c.entries[0].meshes.L.path = `meshes/../${b.entries[0].meshes.L.path.slice(3)}`;
    expect(parseGeometryIndex(c)).toMatchObject({ ok: true, entries: [] });
  });

  it("caps the index's size and its entry count", async () => {
    const big = async () => new Response(`{"pad":"${"x".repeat(MAX_INDEX_BYTES)}"}`);
    expect((await fetchGeometryIndex("x", { fetch: big })).kind).toBe("invalid");
    const many = {
      ...realIndex(),
      entries: Array.from({ length: MAX_INDEX_ENTRIES + 1 }, () => ({})),
    };
    expect(parseGeometryIndex(many).ok).toBe(false);
  });
});
