/**
 * `brain-mesh v1`, the compact triangle-mesh file the spatial view draws a template brain from
 * (card IS-R1), plus the two small mesh generators the renderer and its tests share.
 *
 * Layout, little-endian, no padding (the template builder, IS-T1, writes it from Python):
 *
 *   0  char[4]  "NMBM"
 *   4  u16      version, 1
 *   6  u16      index width in bits, 16 or 32
 *   8  u32      vertex count
 *   12 u32      index count
 *   16 f32[3]   scale x, y, z
 *   28 f32[3]   offset x, y, z
 *   40 i16[3n]  quantized positions, x y z per vertex; position = q * scale + offset
 *   .. u16|u32  triangle indices, counter-clockwise seen from outside
 *
 * No normals are stored; the renderer computes them on load (`vertexNormals`). Positions are
 * millimeters, right-anterior-superior (RAS). The reader is strict: any byte it cannot account
 * for refuses the file, so a corrupt download never reaches the GPU.
 */

export interface BrainMesh {
  /** x, y, z per vertex, millimeters. */
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
}

const HEADER_BYTES = 40;
const MAGIC = "NMBM";
const VERSION = 1;
const Q_MAX = 32767;

function refuse(why: string): never {
  throw new Error(`brain-mesh: ${why}`);
}

/** Parse a brain-mesh v1 file. Throws an `Error` naming the first thing wrong with it. */
export function decodeBrainMesh(input: ArrayBuffer | ArrayBufferView): BrainMesh {
  const v = ArrayBuffer.isView(input)
    ? new DataView(input.buffer, input.byteOffset, input.byteLength)
    : new DataView(input);
  if (v.byteLength < HEADER_BYTES) refuse("file is shorter than its header");
  for (let i = 0; i < 4; i++) {
    if (v.getUint8(i) !== MAGIC.charCodeAt(i)) refuse("bad magic, not a brain-mesh file");
  }
  const version = v.getUint16(4, true);
  if (version !== VERSION) refuse(`unsupported version ${version}`);
  const width = v.getUint16(6, true);
  if (width !== 16 && width !== 32) refuse(`unsupported index width ${width}`);
  const nv = v.getUint32(8, true);
  const ni = v.getUint32(12, true);
  if (v.byteLength !== HEADER_BYTES + 6 * nv + ni * (width / 8)) {
    refuse("file size does not match its counts");
  }
  if (ni % 3) refuse("index count is not a multiple of three");

  const scale: number[] = [];
  const offset: number[] = [];
  for (let k = 0; k < 3; k++) {
    scale.push(v.getFloat32(16 + 4 * k, true));
    offset.push(v.getFloat32(28 + 4 * k, true));
    if (!Number.isFinite(scale[k])) refuse("scale is not finite");
    if (!Number.isFinite(offset[k])) refuse("offset is not finite");
  }

  const positions = new Float32Array(3 * nv);
  for (let i = 0; i < positions.length; i++) {
    positions[i] = v.getInt16(HEADER_BYTES + 2 * i, true) * scale[i % 3] + offset[i % 3];
  }

  const at = HEADER_BYTES + 6 * nv;
  const indices = width === 16 ? new Uint16Array(ni) : new Uint32Array(ni);
  for (let i = 0; i < ni; i++) {
    const idx = width === 16 ? v.getUint16(at + 2 * i, true) : v.getUint32(at + 4 * i, true);
    if (idx >= nv) refuse("an index points past the last vertex");
    indices[i] = idx;
  }
  return { positions, indices };
}

/**
 * Write a brain-mesh v1 file. The decoder's reference partner: the renderer ships only the
 * decoder (this function is tree-shaken out of the page), and tests and tools use it.
 */
export function encodeBrainMesh(mesh: BrainMesh): ArrayBuffer {
  const { positions, indices } = mesh;
  const nv = positions.length / 3;
  const ni = indices.length;
  if (!Number.isInteger(nv)) refuse("positions are not a whole number of vertices");
  const width = indices instanceof Uint32Array ? 32 : 16;
  const scale: number[] = [];
  const offset: number[] = [];
  for (let k = 0; k < 3; k++) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = k; i < positions.length; i += 3) {
      if (!Number.isFinite(positions[i])) refuse("a coordinate is not finite");
      lo = Math.min(lo, positions[i]);
      hi = Math.max(hi, positions[i]);
    }
    // float32 values, so the encoder quantizes with exactly what the decoder will read.
    offset.push(nv ? Math.fround((lo + hi) / 2) : 0);
    scale.push(nv ? Math.fround((hi - lo) / (2 * Q_MAX)) : 0);
  }

  const buf = new ArrayBuffer(HEADER_BYTES + 6 * nv + ni * (width / 8));
  const v = new DataView(buf);
  for (let i = 0; i < 4; i++) v.setUint8(i, MAGIC.charCodeAt(i));
  v.setUint16(4, VERSION, true);
  v.setUint16(6, width, true);
  v.setUint32(8, nv, true);
  v.setUint32(12, ni, true);
  for (let k = 0; k < 3; k++) {
    v.setFloat32(16 + 4 * k, scale[k], true);
    v.setFloat32(28 + 4 * k, offset[k], true);
  }
  for (let i = 0; i < positions.length; i++) {
    const s = scale[i % 3];
    const q = s > 0 ? Math.round((positions[i] - offset[i % 3]) / s) : 0;
    v.setInt16(HEADER_BYTES + 2 * i, Math.max(-Q_MAX, Math.min(Q_MAX, q)), true);
  }
  const at = HEADER_BYTES + 6 * nv;
  for (let i = 0; i < ni; i++) {
    if (width === 16) v.setUint16(at + 2 * i, indices[i], true);
    else v.setUint32(at + 4 * i, indices[i], true);
  }
  return buf;
}

/**
 * Smooth vertex normals: each triangle's area-weighted normal summed into its three vertices,
 * then normalized. A vertex no triangle uses keeps a zero normal.
 */
export function vertexNormals(mesh: BrainMesh): Float32Array {
  const { positions: p, indices: ix } = mesh;
  const n = new Float32Array(p.length);
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3;
    const b = ix[t + 1] * 3;
    const c = ix[t + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const wx = p[c] - p[a];
    const wy = p[c + 1] - p[a + 1];
    const wz = p[c + 2] - p[a + 2];
    const fx = uy * wz - uz * wy;
    const fy = uz * wx - ux * wz;
    const fz = ux * wy - uy * wx;
    for (const i of [a, b, c]) {
      n[i] += fx;
      n[i + 1] += fy;
      n[i + 2] += fz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (len > 0) {
      n[i] /= len;
      n[i + 1] /= len;
      n[i + 2] /= len;
    }
  }
  return n;
}

/** A geodesic sphere: an icosahedron with each triangle split four ways `subdivisions` times. */
export function icosphere(subdivisions: number, radius = 1): BrainMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  // biome-ignore format: the standard vertex table, kept as one row per three vertices
  const verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  // biome-ignore format: the standard face table, counter-clockwise from outside
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const unit = (p: number[]): number[] => {
    const len = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / len, p[1] / len, p[2] / len];
  };
  for (let i = 0; i < verts.length; i++) verts[i] = unit(verts[i]);
  for (let s = 0; s < subdivisions; s++) {
    const mid = new Map<number, number>();
    const between = (a: number, b: number): number => {
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      let m = mid.get(key);
      if (m === undefined) {
        m = verts.push(unit([0, 1, 2].map((k) => verts[a][k] + verts[b][k]))) - 1;
        mid.set(key, m);
      }
      return m;
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = between(a, b);
      const bc = between(b, c);
      const ca = between(c, a);
      return [
        [a, ab, ca],
        [b, bc, ab],
        [c, ca, bc],
        [ab, bc, ca],
      ];
    });
  }
  return {
    positions: Float32Array.from(verts.flat(), (x) => x * radius),
    indices: Uint16Array.from(faces.flat()),
  };
}
