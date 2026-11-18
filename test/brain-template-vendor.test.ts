/**
 * Guards on the vendored template brain surface (card IS-T1, the pattern of website ADR 0028).
 *
 * The surface is built once by `scripts/vendor-brain-template.py` and committed. CI never rebuilds
 * it, so these are the checks that the committed folder is what it says it is:
 *
 *  - the bytes on disk are the bytes `SHA256SUMS` names, and nothing else is in the folder;
 *  - `provenance.json` names the SHA-256 of the script as it is in the working tree, so editing
 *    the script without rerunning it fails here;
 *  - the MNI copyright notice travels in `LICENSE.txt`, verbatim;
 *  - each hemisphere is a valid `brain-mesh v1` file inside the vertex and size budgets, on its own
 *    side of the midline and inside the template brain's extent, wound counter-clockwise from
 *    outside;
 *  - the script's Python writer and the TypeScript reader agree on the format, byte for byte.
 *
 * Every read goes through `./node.ts`; see there for why.
 */

import { describe, expect, it } from "vitest";
import {
  type BrainMesh,
  decodeBrainMesh,
  encodeBrainMesh,
} from "../src/lib/ieeg-spatial/mesh-format";
import { nodeFs, repoPath, sha256Hex } from "./node";

const fs = await nodeFs();
const DIR = "public/vendor/brain-templates/mni152nlin2009casym@1";
const SCRIPT = "scripts/vendor-brain-template.py";
const REBUILD = `uv run ${SCRIPT}`;
const MAX_VERTICES = 15000;
const MAX_TOTAL_BYTES = 600 * 1000;
const MAX_VIEWS_BYTES = 40 * 1024;

const text = (relative: string): string => fs.readFileSync(repoPath(relative), "utf8");
const bytes = (relative: string): Uint8Array => fs.readFileSync(repoPath(relative));

interface Provenance {
  name: string;
  regenerate: string;
  script: { path: string; sha256: string };
  sources: { path: string; bytes: number; sha256: string; role: string }[];
  licenseSource: { sha256: string };
  outputs: Record<string, { vertices: number; triangles: number }>;
}

const readProvenance = (): Provenance => JSON.parse(text(`${DIR}/provenance.json`)) as Provenance;

/** `sha256sum` format: a hex digest, two spaces, a file name. */
function parseSums(list: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of list.split("\n")) {
    if (!line) continue;
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!match) throw new Error(`SHA256SUMS has a line that is not "<sha256>  <name>": ${line}`);
    sums.set(match[2], match[1]);
  }
  return sums;
}

function bounds(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], positions[i]);
    max[i % 3] = Math.max(max[i % 3], positions[i]);
  }
  return { min, max };
}

function header(file: Uint8Array): {
  version: number;
  width: number;
  vertices: number;
  indices: number;
} {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  return {
    version: v.getUint16(4, true),
    width: v.getUint16(6, true),
    vertices: v.getUint32(8, true),
    indices: v.getUint32(12, true),
  };
}

const left = (): BrainMesh => decodeBrainMesh(bytes(`${DIR}/lh.mesh.bin`));
const right = (): BrainMesh => decodeBrainMesh(bytes(`${DIR}/rh.mesh.bin`));

describe("the vendored template brain folder", () => {
  it("holds exactly the files its checksum list names, and the list", () => {
    const named = [...parseSums(text(`${DIR}/SHA256SUMS`)).keys()];
    expect(fs.readdirSync(repoPath(DIR)).sort()).toEqual([...named, "SHA256SUMS"].sort());
    expect(named.sort()).toEqual([
      "LICENSE.txt",
      "README.md",
      "lh.mesh.bin",
      "provenance.json",
      "rh.mesh.bin",
      "views.json",
    ]);
  });

  it("matches its checksum list, byte for byte", async () => {
    const mismatched: string[] = [];
    for (const [name, expected] of parseSums(text(`${DIR}/SHA256SUMS`))) {
      if ((await sha256Hex(bytes(`${DIR}/${name}`))) !== expected) mismatched.push(name);
    }
    expect(mismatched, `Hand-edited? Rebuild with: ${REBUILD}`).toEqual([]);
  });

  it("totals at most 600 KB, the template budget", () => {
    let total = 0;
    for (const name of fs.readdirSync(repoPath(DIR))) total += bytes(`${DIR}/${name}`).length;
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });
});

describe("provenance.json", () => {
  it("names the SHA-256 of the script that is in the working tree", async () => {
    const provenance = readProvenance();
    expect(provenance.script.path).toBe(SCRIPT);
    expect(provenance.regenerate).toBe(REBUILD);
    expect(
      provenance.script.sha256,
      `The script changed since the folder was built. Rebuild with: ${REBUILD}`,
    ).toBe(await sha256Hex(bytes(SCRIPT)));
  });

  it("records the three source files, and the script pins the same values", () => {
    const provenance = readProvenance();
    expect(provenance.sources.map((s) => s.role).sort()).toEqual([
      "license",
      "probability map",
      "probability map",
    ]);
    const script = text(SCRIPT);
    for (const source of provenance.sources) {
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(script, `${source.path} is not pinned in the script`).toContain(source.sha256);
      const name = source.path.split("/").pop() ?? "";
      const key =
        name === "LICENSE" ? '"LICENSE"' : name.includes("label-GM") ? "GM_FILE" : "WM_FILE";
      expect(script, `${source.path}: size and hash are not pinned together as ${key}`).toContain(
        `${key}: (${source.bytes}, "${source.sha256}")`,
      );
    }
  });

  it("counts the vertices and triangles that the mesh headers say", () => {
    const provenance = readProvenance();
    for (const name of ["lh.mesh.bin", "rh.mesh.bin"]) {
      const h = header(bytes(`${DIR}/${name}`));
      expect(provenance.outputs[name]).toEqual({ vertices: h.vertices, triangles: h.indices / 3 });
    }
  });
});

describe("LICENSE.txt", () => {
  it("carries the MNI copyright notice, verbatim, and names this derived surface", async () => {
    const license = text(`${DIR}/LICENSE.txt`);
    expect(license).toContain("Copyright (C) 1993–2004 Louis Collins");
    expect(license).toContain(
      "McConnell Brain Imaging Centre, Montreal Neurological Institute, McGill University",
    );
    expect(license).toContain("provided that the above copyright notice appear in all copies");
    // The source notice is everything before the one added line, and hashes to the recorded value.
    const marker = "\n\nThis folder holds a brain surface derived from";
    const at = license.indexOf(marker);
    expect(at).toBeGreaterThan(0);
    expect(license.slice(at)).toContain(SCRIPT);
    const source = new TextEncoder().encode(`${license.slice(0, at)}\n`);
    expect(await sha256Hex(source)).toBe(readProvenance().licenseSource.sha256);
  });

  it("is accompanied by the template's reference in the README and the provenance", () => {
    for (const name of ["README.md", "provenance.json"]) {
      expect(text(`${DIR}/${name}`)).toContain("10.1016/j.neuroimage.2010.07.033");
    }
  });
});

describe("the hemisphere meshes", () => {
  it("are brain-mesh v1 with 16-bit indices and at most 15,000 vertices each", () => {
    for (const name of ["lh.mesh.bin", "rh.mesh.bin"]) {
      const file = bytes(`${DIR}/${name}`);
      expect(String.fromCharCode(...file.slice(0, 4))).toBe("NMBM");
      const h = header(file);
      expect(h.version).toBe(1);
      expect(h.width).toBe(16);
      expect(h.vertices).toBeGreaterThan(5000);
      expect(h.vertices).toBeLessThanOrEqual(MAX_VERTICES);
      expect(h.indices % 3).toBe(0);
      expect(() => decodeBrainMesh(file)).not.toThrow();
    }
  });

  it("landmark 1: every left vertex has x at most 1 mm", () => {
    expect(bounds(left().positions).max[0]).toBeLessThanOrEqual(1);
  });

  it("landmark 2: every right vertex has x at least -1 mm", () => {
    expect(bounds(right().positions).min[0]).toBeGreaterThanOrEqual(-1);
  });

  it("reach the midline: the cut is on x = 0 and most of the cut vertices sit exactly on it", () => {
    for (const [mesh, nearest] of [
      [left(), (b: ReturnType<typeof bounds>) => b.max[0]],
      [right(), (b: ReturnType<typeof bounds>) => -b.min[0]],
    ] as const) {
      expect(Math.abs(nearest(bounds(mesh.positions)))).toBeLessThan(0.01);
      let onPlane = 0;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        if (Math.abs(mesh.positions[i]) < 0.01) onPlane++;
      }
      // The surface is cut, not capped: hundreds of vertices lie on the plane.
      expect(onPlane).toBeGreaterThan(300);
    }
  });

  it("landmark 3: x lies within -75 to 75 mm", () => {
    const l = bounds(left().positions);
    const r = bounds(right().positions);
    expect(Math.min(l.min[0], r.min[0])).toBeGreaterThanOrEqual(-75);
    expect(Math.max(l.max[0], r.max[0])).toBeLessThanOrEqual(75);
  });

  it("landmark 4: y lies within -110 to 75 mm", () => {
    const l = bounds(left().positions);
    const r = bounds(right().positions);
    expect(Math.min(l.min[1], r.min[1])).toBeGreaterThanOrEqual(-110);
    expect(Math.max(l.max[1], r.max[1])).toBeLessThanOrEqual(75);
  });

  it("landmark 5: z lies within -75 to 85 mm", () => {
    const l = bounds(left().positions);
    const r = bounds(right().positions);
    expect(Math.min(l.min[2], r.min[2])).toBeGreaterThanOrEqual(-75);
    expect(Math.max(l.max[2], r.max[2])).toBeLessThanOrEqual(85);
  });

  it("fill the template brain, not a fragment of it", () => {
    const l = bounds(left().positions);
    const r = bounds(right().positions);
    // The cerebrum is about 140 mm wide, 175 mm long and 130 mm tall.
    expect(r.max[0] - l.min[0]).toBeGreaterThan(130);
    expect(Math.max(l.max[1], r.max[1]) - Math.min(l.min[1], r.min[1])).toBeGreaterThan(165);
    expect(Math.max(l.max[2], r.max[2]) - Math.min(l.min[2], r.min[2])).toBeGreaterThan(145);
  });

  it("wind counter-clockwise seen from outside", () => {
    for (const mesh of [left(), right()]) {
      const p = mesh.positions;
      const ix = mesh.indices;
      const mean = [0, 0, 0];
      for (let i = 0; i < p.length; i++) mean[i % 3] += p[i] / (p.length / 3);
      let outward = 0;
      for (let t = 0; t < ix.length; t += 3) {
        const [a, b, c] = [ix[t] * 3, ix[t + 1] * 3, ix[t + 2] * 3];
        const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
        const w = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const out = [0, 1, 2].map((k) => (p[a + k] + p[b + k] + p[c + k]) / 3 - mean[k]);
        if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] > 0) outward++;
      }
      // Folds and the open midline face inward; a flipped mesh would be near zero.
      expect(outward / (ix.length / 3)).toBeGreaterThan(0.7);
    }
  });
});

/**
 * The format example `uv run scripts/vendor-brain-template.py --known-answer` prints: the Python
 * writer's bytes for five vertices (coordinates that are not exactly float32) and four triangles.
 */
const KNOWN_ANSWER_HEX =
  "4e4d424d01001000050000000c00000008ce9d3a5325be3a36c19a3accccc4c0285c5d410080fb410cecdde601802b55018098ccf413ff7fb88f018048bf5c18ff7f0ffbff7f000001000200010003000200000002000400020003000400";
const KNOWN_ANSWER: BrainMesh = {
  positions: Float32Array.from([
    -12.3, 4.5, -7.25, 20.1, -33.7, 15.9, 0.0, 61.37, -2.5, -45.6, -10.2, 38.8, 33.3, 12.0, 70.125,
  ]),
  indices: Uint16Array.from([0, 1, 2, 1, 3, 2, 0, 2, 4, 2, 3, 4]),
};

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("the Python writer and the TypeScript reader", () => {
  it("agree on the known answer, byte for byte", () => {
    expect(hex(encodeBrainMesh(KNOWN_ANSWER))).toBe(KNOWN_ANSWER_HEX);
  });

  it("decode the Python bytes to the vertices that were written, within one quantum", () => {
    const bytesIn = Uint8Array.from(KNOWN_ANSWER_HEX.match(/../g) ?? [], (h) =>
      Number.parseInt(h, 16),
    );
    const mesh = decodeBrainMesh(bytesIn);
    expect([...mesh.indices]).toEqual([...KNOWN_ANSWER.indices]);
    const scale = new DataView(bytesIn.buffer).getFloat32(16, true);
    for (let i = 0; i < mesh.positions.length; i++) {
      // x spans the widest range of the three axes here, so scale[0] is the coarsest step.
      expect(Math.abs(mesh.positions[i] - KNOWN_ANSWER.positions[i])).toBeLessThanOrEqual(scale);
    }
  });

  it("read the committed meshes and write them back to the same bytes", () => {
    for (const name of ["lh.mesh.bin", "rh.mesh.bin"]) {
      const file = bytes(`${DIR}/${name}`);
      const again = encodeBrainMesh(decodeBrainMesh(file));
      expect(again.byteLength).toBe(file.byteLength);
      // Re-quantizing decoded vertices may move a value by one step at most.
      const a = new Int16Array(file.buffer, file.byteOffset + 40, 3 * header(file).vertices);
      const b = new Int16Array(again, 40, a.length);
      let worst = 0;
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
      expect(worst).toBeLessThanOrEqual(1);
    }
  });
});

describe("views.json", () => {
  interface Views {
    format: string;
    views: Record<string, { axes: string[]; polylines: number[][][] }>;
  }
  const views = (): Views => JSON.parse(text(`${DIR}/views.json`)) as Views;

  it("stays within its 40 KB budget", () => {
    expect(bytes(`${DIR}/views.json`).length).toBeLessThanOrEqual(MAX_VIEWS_BYTES);
  });

  it("holds the left, top and front outlines as closed polylines in millimeters", () => {
    const doc = views();
    expect(doc.format).toBe("brain-template-views v1");
    expect(Object.keys(doc.views).sort()).toEqual(["front", "left", "top"]);
    const axes = { left: ["y", "z"], top: ["x", "y"], front: ["x", "z"] };
    const extent = { x: [-75, 75], y: [-110, 75], z: [-75, 85] } as Record<string, number[]>;
    for (const [name, view] of Object.entries(doc.views)) {
      expect(view.axes).toEqual(axes[name as keyof typeof axes]);
      expect(view.polylines.length).toBeGreaterThanOrEqual(1);
      for (const line of view.polylines) {
        expect(line.length).toBeGreaterThanOrEqual(3);
        for (const point of line) {
          expect(point).toHaveLength(2);
          point.forEach((value, k) => {
            expect(Number.isFinite(value)).toBe(true);
            const [lo, hi] = extent[view.axes[k]];
            // The outline is drawn on a 0.5 mm raster with a 2 mm margin, so allow that.
            expect(value).toBeGreaterThanOrEqual(lo - 1);
            expect(value).toBeLessThanOrEqual(hi + 1);
          });
        }
      }
    }
  });
});
