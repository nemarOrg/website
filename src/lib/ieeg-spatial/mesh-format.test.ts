import { describe, expect, it } from "vitest";
import {
  type BrainMesh,
  decodeBrainMesh,
  encodeBrainMesh,
  icosphere,
  vertexNormals,
} from "./mesh-format";

/**
 * The brain-mesh v1 layout, written out byte by byte here from the format's description, so the
 * decoder is tested against the format and not only against its own encoder (the template
 * builder, IS-T1, writes this layout from Python):
 *
 *   0  char[4]  "NMBM"
 *   4  u16      version, 1
 *   6  u16      index width in bits, 16 or 32
 *   8  u32      vertex count
 *   12 u32      index count
 *   16 f32[3]   scale x, y, z
 *   28 f32[3]   offset x, y, z
 *   40 i16[3n]  quantized positions, x y z per vertex; position = q * scale + offset
 *   .. u16|u32  indices
 *
 * Everything little-endian, no padding.
 */
function handBuilt(width: 16 | 32): ArrayBuffer {
  const nv = 3;
  const ni = 3;
  const bytes = 40 + 6 * nv + ni * (width / 8);
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  for (const [i, ch] of [..."NMBM"].entries()) v.setUint8(i, ch.charCodeAt(0));
  v.setUint16(4, 1, true);
  v.setUint16(6, width, true);
  v.setUint32(8, nv, true);
  v.setUint32(12, ni, true);
  [0.5, 0.25, 0.125].forEach((s, i) => v.setFloat32(16 + 4 * i, s, true));
  [10, 20, 30].forEach((o, i) => v.setFloat32(28 + 4 * i, o, true));
  [0, 0, 0, 2, 0, 0, 0, 4, 8].forEach((q, i) => v.setInt16(40 + 2 * i, q, true));
  const at = 40 + 6 * nv;
  [0, 1, 2].forEach((idx, i) => {
    if (width === 16) v.setUint16(at + 2 * i, idx, true);
    else v.setUint32(at + 4 * i, idx, true);
  });
  return buf;
}

/** A sphere of radius 70 mm centered away from the origin, so a dropped offset cannot hide. */
function offCenterSphere(subdivisions = 2): BrainMesh {
  const s = icosphere(subdivisions, 70);
  const center = [10, -20, 30];
  for (let i = 0; i < s.positions.length; i++) s.positions[i] += center[i % 3];
  return s;
}

describe("brain-mesh v1 decoding", () => {
  for (const width of [16, 32] as const) {
    it(`decodes a hand-built ${width}-bit-index file to its known positions and indices`, () => {
      const mesh = decodeBrainMesh(handBuilt(width));
      expect([...mesh.positions]).toEqual([10, 20, 30, 11, 20, 30, 10, 21, 31]);
      expect([...mesh.indices]).toEqual([0, 1, 2]);
      expect(mesh.indices).toBeInstanceOf(width === 16 ? Uint16Array : Uint32Array);
    });
  }

  it("reads through a typed-array view that does not start at byte zero", () => {
    const inner = new Uint8Array(handBuilt(16));
    const padded = new Uint8Array(inner.length + 5);
    padded.set(inner, 5);
    const mesh = decodeBrainMesh(padded.subarray(5));
    expect([...mesh.positions]).toEqual([10, 20, 30, 11, 20, 30, 10, 21, 31]);
  });
});

describe("brain-mesh v1 round trip", () => {
  it("reproduces positions within one quantization step and the indices exactly", () => {
    const src = offCenterSphere();
    const out = decodeBrainMesh(encodeBrainMesh(src));
    expect(out.positions.length).toBe(src.positions.length);
    // The step is the sphere's 140 mm extent over 65534 levels, about 0.002 mm.
    const step = 140 / 65534;
    for (let i = 0; i < src.positions.length; i++) {
      expect(Math.abs(out.positions[i] - src.positions[i])).toBeLessThanOrEqual(step);
    }
    expect([...out.indices]).toEqual([...src.indices]);
  });

  it("keeps 32-bit indices when the mesh is given with them", () => {
    const src = offCenterSphere(1);
    const wide = { positions: src.positions, indices: Uint32Array.from(src.indices) };
    const out = decodeBrainMesh(encodeBrainMesh(wide));
    expect(out.indices).toBeInstanceOf(Uint32Array);
    expect([...out.indices]).toEqual([...src.indices]);
  });

  it("decodes a flat axis (every z equal) to that value", () => {
    const positions = new Float32Array([0, 0, 5, 10, 0, 5, 0, 10, 5]);
    const out = decodeBrainMesh(
      encodeBrainMesh({ positions, indices: new Uint16Array([0, 1, 2]) }),
    );
    expect([out.positions[2], out.positions[5], out.positions[8]]).toEqual([5, 5, 5]);
  });

  it("refuses to encode a non-finite coordinate", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, Number.NaN, 0, 1, 0]);
    expect(() => encodeBrainMesh({ positions, indices: new Uint16Array([0, 1, 2]) })).toThrow(
      /finite/,
    );
  });
});

describe("brain-mesh v1 refusals", () => {
  function corrupt(edit: (v: DataView, bytes: Uint8Array) => void): ArrayBuffer {
    const buf = handBuilt(16);
    edit(new DataView(buf), new Uint8Array(buf));
    return buf;
  }

  it("refuses a wrong magic", () => {
    const buf = encodeBrainMesh(offCenterSphere(1));
    new Uint8Array(buf)[0] = "X".charCodeAt(0);
    expect(() => decodeBrainMesh(buf)).toThrow(/magic/);
  });

  it("refuses a file shorter than its header", () => {
    expect(() => decodeBrainMesh(new ArrayBuffer(12))).toThrow(/header/);
  });

  const refusals: Array<[string, RegExp, (v: DataView) => void]> = [
    ["an unsupported version", /version 2/, (v) => v.setUint16(4, 2, true)],
    ["an index width of 8", /index width/, (v) => v.setUint16(6, 8, true)],
    ["a vertex count the bytes cannot hold", /size/, (v) => v.setUint32(8, 4, true)],
    [
      "an index past the last vertex",
      /past the last vertex/,
      (v) => v.setUint16(40 + 18 + 4, 3, true),
    ],
    ["a non-finite scale", /scale/, (v) => v.setFloat32(16, Number.NaN, true)],
    ["a non-finite offset", /offset/, (v) => v.setFloat32(28, Number.POSITIVE_INFINITY, true)],
  ];
  for (const [what, pattern, edit] of refusals) {
    it(`refuses ${what}`, () => {
      expect(() => decodeBrainMesh(corrupt((v) => edit(v)))).toThrow(pattern);
    });
  }

  it("refuses an index count that is not a multiple of three", () => {
    const buf = handBuilt(16).slice(0, 40 + 18 + 4); // two indices, bytes and count agree
    new DataView(buf).setUint32(12, 2, true);
    expect(() => decodeBrainMesh(buf)).toThrow(/multiple of three/);
  });

  it("refuses a truncated file and a file with trailing bytes", () => {
    const good = handBuilt(16);
    expect(() => decodeBrainMesh(good.slice(0, good.byteLength - 2))).toThrow(/size/);
    const longer = new Uint8Array(good.byteLength + 1);
    longer.set(new Uint8Array(good));
    expect(() => decodeBrainMesh(longer)).toThrow(/size/);
  });
});

describe("icosphere", () => {
  it("has the counts of a subdivided icosahedron and every vertex on the radius", () => {
    for (const s of [0, 1, 2]) {
      const m = icosphere(s, 3);
      expect(m.positions.length / 3).toBe(10 * 4 ** s + 2);
      expect(m.indices.length / 3).toBe(20 * 4 ** s);
      for (let i = 0; i < m.positions.length; i += 3) {
        expect(Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2])).toBeCloseTo(
          3,
          5,
        );
      }
    }
  });
});

describe("vertexNormals", () => {
  it("gives a counter-clockwise triangle in the xy plane the normal +z", () => {
    const positions = new Float32Array([0, 0, 0, 4, 0, 0, 0, 3, 0]);
    const n = vertexNormals({ positions, indices: new Uint16Array([0, 1, 2]) });
    expect([...n]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it("points outward on an icosphere, which also pins its winding order", () => {
    for (const s of [0, 1]) {
      const m = icosphere(s, 50);
      const n = vertexNormals(m);
      for (let i = 0; i < m.positions.length; i += 3) {
        const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
        expect(len).toBeCloseTo(1, 5);
        const radial =
          (n[i] * m.positions[i] + n[i + 1] * m.positions[i + 1] + n[i + 2] * m.positions[i + 2]) /
          50;
        expect(radial).toBeGreaterThan(0.99);
      }
    }
  });

  it("leaves a vertex used by no triangle with a zero normal instead of NaN", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 9, 9, 9]);
    const n = vertexNormals({ positions, indices: new Uint16Array([0, 1, 2]) });
    expect([n[9], n[10], n[11]]).toEqual([0, 0, 0]);
  });
});
