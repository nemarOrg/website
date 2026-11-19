/**
 * The subject's own cortical surface under the contacts (card A2, ADR 0034).
 *
 * NEMAR's geometry pipeline writes, beside a dataset's Zarr copy, an index of subject surfaces
 * (`geometry/index.json`, schema `nemar-ieeg-geometry-index` version 1) and the surfaces as
 * content-addressed `brain-mesh v1` files (`geometry/meshes/<sha256>.mesh.bin`). A mesh is already
 * in the frame its electrodes file declares, so the panel draws it under the contacts as they are:
 * no transform, no template, and never a mix of the two.
 *
 * This module is the pure half: it reads and validates the index, picks the entry for the
 * electrodes file the panel shows, fetches and verifies the meshes, words the label and the notes,
 * and draws the 2D views' outlines from the subject's own mesh. It decides nothing about the panel;
 * `panel.ts` asks it.
 *
 * Strictness is the point. The index, every entry and every mesh is checked in code (schema name,
 * version, hemisphere keys, content address, byte count, SHA-256 of the fetched bytes before the
 * decoder sees them, counts after it). Anything that does not match hides the option with one
 * console warning per cause; a broken drawing is never the outcome.
 */

import { zarrBase } from "../zarr-base";
import { type BrainMesh, decodeBrainMesh } from "./mesh-format";
import { mergeMeshes } from "./transforms";
import type { TemplateOutlines, ViewName } from "./views2d";
import { VIEW_DEFS, VIEW_NAMES } from "./views2d";

export type Hemisphere = "L" | "R";
export type SubjectGrade = "specific" | "plausible";

export interface SubjectMeshRef {
  /** Path relative to the index's directory: `meshes/<sha256>.mesh.bin`. */
  path: string;
  sha256: string;
  bytes: number;
  vertices: number;
  faces: number;
}

/** One validated index entry: what the panel needs and nothing it has to trust further. */
export interface SubjectEntry {
  /** Dataset-relative path of the electrodes file the mesh was verified against. */
  electrodes: string;
  grade: SubjectGrade;
  /** The hemispheres present, in the order L then R. */
  hemispheres: readonly Hemisphere[];
  /** Dataset-relative paths of the source surfaces, as the pipeline recorded them. */
  sources: readonly string[];
  meshes: Readonly<Partial<Record<Hemisphere, SubjectMeshRef>>>;
}

export type IndexParse =
  | { ok: true; entries: SubjectEntry[]; dropped: string[] }
  | { ok: false; why: string };

export const GEOMETRY_INDEX_SCHEMA = "nemar-ieeg-geometry-index";
export const GEOMETRY_INDEX_VERSION = 1;
/** The schema's largest mesh: a larger answer is refused before it is read. */
export const MAX_MESH_BYTES = 1_500_000;

const HEMISPHERES: readonly Hemisphere[] = ["L", "R"];
const SHA256 = /^[0-9a-f]{64}$/;
const MESH_PATH = /^meshes\/([0-9a-f]{64})\.mesh\.bin$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseMeshRef(h: string, raw: unknown): SubjectMeshRef | string {
  if (!isRecord(raw)) return `the ${h} mesh is not an object`;
  const { path, sha256, bytes, vertices, faces } = raw;
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return `the ${h} mesh has no SHA-256`;
  if (typeof path !== "string") return `the ${h} mesh has no path`;
  const m = MESH_PATH.exec(path);
  if (!m || m[1] !== sha256) return `the ${h} mesh path is not its content address`;
  if (!Number.isInteger(bytes) || (bytes as number) < 40 || (bytes as number) > MAX_MESH_BYTES) {
    return `the ${h} mesh byte count is out of range`;
  }
  if (!Number.isInteger(vertices) || (vertices as number) < 0 || (vertices as number) > 65535) {
    return `the ${h} mesh vertex count is out of range`;
  }
  if (!Number.isInteger(faces) || (faces as number) < 0) return `the ${h} mesh face count is bad`;
  return {
    path,
    sha256,
    bytes: bytes as number,
    vertices: vertices as number,
    faces: faces as number,
  };
}

function parseEntry(raw: unknown): SubjectEntry | string {
  if (!isRecord(raw)) return "an entry is not an object";
  const { electrodes, meshes, hemispheres, fit, sources } = raw;
  if (typeof electrodes !== "string" || electrodes === "") return "an entry has no electrodes path";
  if (!isRecord(meshes)) return `${electrodes}: no meshes`;
  const keys = Object.keys(meshes);
  const unknown = keys.filter((k) => !HEMISPHERES.includes(k as Hemisphere));
  if (unknown.length > 0)
    return `${electrodes}: unknown hemisphere key ${JSON.stringify(unknown[0])}`;
  if (keys.length === 0) return `${electrodes}: no hemisphere`;
  if (
    !Array.isArray(hemispheres) ||
    hemispheres.length !== keys.length ||
    !hemispheres.every((h) => typeof h === "string" && keys.includes(h))
  ) {
    return `${electrodes}: the hemispheres list does not match the meshes`;
  }
  const refs: Partial<Record<Hemisphere, SubjectMeshRef>> = {};
  for (const h of HEMISPHERES) {
    if (!(h in meshes)) continue;
    const ref = parseMeshRef(h, meshes[h]);
    if (typeof ref === "string") return `${electrodes}: ${ref}`;
    refs[h] = ref;
  }
  if (
    !isRecord(fit) ||
    (fit.grade !== "specific" && fit.grade !== "plausible") ||
    fit.passed !== true
  ) {
    return `${electrodes}: the fit is not a passing specific or plausible one`;
  }
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    !sources.every((s) => typeof s === "string")
  ) {
    return `${electrodes}: no source surfaces`;
  }
  return {
    electrodes,
    grade: fit.grade,
    hemispheres: HEMISPHERES.filter((h) => h in refs),
    sources: [...(sources as string[])],
    meshes: refs,
  };
}

/**
 * Validate a parsed `geometry/index.json`. A document that is not the v1 index is refused whole;
 * an entry that does not validate is dropped alone and named in `dropped`, so one bad subject
 * never hides the rest.
 */
export function parseGeometryIndex(json: unknown): IndexParse {
  if (!isRecord(json)) return { ok: false, why: "the index is not an object" };
  if (json.schema !== GEOMETRY_INDEX_SCHEMA)
    return { ok: false, why: "the index names another schema" };
  if (json.version !== GEOMETRY_INDEX_VERSION) {
    return {
      ok: false,
      why: `the index is version ${String(json.version)}, not ${GEOMETRY_INDEX_VERSION}`,
    };
  }
  if (!Array.isArray(json.entries)) return { ok: false, why: "the index has no entries list" };
  const entries: SubjectEntry[] = [];
  const dropped: string[] = [];
  for (const raw of json.entries) {
    const entry = parseEntry(raw);
    if (typeof entry === "string") dropped.push(entry);
    else entries.push(entry);
  }
  return { ok: true, entries, dropped };
}

/** The entry for the electrodes file the panel shows, matched on the dataset-relative path. */
export function entryFor(
  entries: readonly SubjectEntry[],
  electrodesPath: string | null,
): SubjectEntry | null {
  if (electrodesPath === null) return null;
  return entries.find((e) => e.electrodes === electrodesPath) ?? null;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export const SUBJECT_ANATOMY_LABEL = "This subject's anatomy";
export const SUBJECT_LABEL = "This subject's anatomy, from the dataset's own surfaces";
const APPROXIMATE_SENTENCE = "approximate alignment (depth contacts)";

/** The label in the template-label slot: nothing more for a specific fit. */
export function subjectLabel(entry: SubjectEntry): string {
  return entry.grade === "plausible" ? `${SUBJECT_LABEL}; ${APPROXIMATE_SENTENCE}` : SUBJECT_LABEL;
}

/** The notes the surface owes the reader: the source surfaces, and a missing hemisphere. */
export function subjectNotes(entry: SubjectEntry): string[] {
  const notes = [`Subject surfaces: ${entry.sources.join(", ")}.`];
  if (entry.hemispheres.length === 1) {
    const side = entry.hemispheres[0] === "L" ? "Left" : "Right";
    notes.push(`${side} hemisphere only: the dataset ships one hemisphere for this subject.`);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Where the files are, and fetching them
// ---------------------------------------------------------------------------

/** The directory beside the dataset's Zarr copy that holds the index and the meshes. */
export function geometryBaseUrl(datasetId: string, base: string = zarrBase()): string {
  return `${base.replace(/\/$/, "")}/${encodeURIComponent(datasetId)}/zarr/geometry/`;
}

export type IndexResult =
  /** No index there (404): this dataset has no subject anatomy, and that is not a fault. */
  | { kind: "none" }
  | { kind: "found"; entries: SubjectEntry[] }
  /** An index that is not valid v1: no option, one warning. */
  | { kind: "invalid"; why: string };

const warned = new Set<string>();
/** One console warning per cause for the page's life. */
export function warnOnce(cause: string, detail: unknown): void {
  if (warned.has(cause)) return;
  warned.add(cause);
  console.warn(`[ieeg-spatial] subject anatomy hidden: ${cause}`, detail);
}
/** For tests: start from a page that has warned about nothing. */
export function forgetWarnings(): void {
  warned.clear();
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/**
 * Read the dataset's geometry index. Resolves `none` for a 404, `invalid` (and warns once) for a
 * document that is not the v1 index, and throws for a failure that may pass (network, 5xx), which
 * the caller does not cache.
 */
export async function fetchGeometryIndex(
  datasetId: string,
  options: { fetch?: FetchLike; base?: string; signal?: AbortSignal } = {},
): Promise<IndexResult> {
  const doFetch = options.fetch ?? ((u, i) => fetch(u, i));
  const url = `${geometryBaseUrl(datasetId, options.base)}index.json`;
  const res = await doFetch(url, { signal: options.signal });
  if (res.status === 404 || res.status === 403) return { kind: "none" };
  if (!res.ok) throw new Error(`subject-anatomy: ${url} answered ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    warnOnce(`${datasetId}: the index is not JSON`, err);
    return { kind: "invalid", why: "the index is not JSON" };
  }
  const parsed = parseGeometryIndex(json);
  if (!parsed.ok) {
    warnOnce(`${datasetId}: ${parsed.why}`, url);
    return { kind: "invalid", why: parsed.why };
  }
  for (const why of parsed.dropped) warnOnce(`${datasetId}: ${why}`, url);
  return { kind: "found", entries: parsed.entries };
}

const indexLoads = new Map<string, Promise<IndexResult>>();
/**
 * The index, once per dataset for the page's life (a panel that reopens, or a second recording of
 * the same dataset, shares it). A failure is not kept, so the next ask tries again.
 */
export function geometryIndexFor(
  datasetId: string,
  options: { fetch?: FetchLike; base?: string } = {},
): Promise<IndexResult> {
  let load = indexLoads.get(datasetId);
  if (!load) {
    load = fetchGeometryIndex(datasetId, options).catch((err) => {
      indexLoads.delete(datasetId);
      throw err;
    });
    indexLoads.set(datasetId, load);
  }
  return load;
}
/** For tests: forget every cached index and mesh. */
export function forgetSubjectLoads(): void {
  indexLoads.clear();
  meshLoads.clear();
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch one hemisphere and check it before the decoder sees a byte: the length the index names,
 * the SHA-256 the index names, then (after decoding) the vertex and face counts.
 */
async function loadHemisphere(
  base: string,
  h: Hemisphere,
  ref: SubjectMeshRef,
  doFetch: FetchLike,
): Promise<BrainMesh> {
  const res = await doFetch(`${base}${ref.path}`);
  if (!res.ok) throw new Error(`subject-anatomy: the ${h} mesh answered ${res.status}`);
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength !== ref.bytes) {
    throw new Error(
      `subject-anatomy: the ${h} mesh is ${bytes.byteLength} bytes, not ${ref.bytes}`,
    );
  }
  if ((await sha256Hex(bytes)) !== ref.sha256) {
    throw new Error(`subject-anatomy: the ${h} mesh does not match its SHA-256`);
  }
  const mesh = decodeBrainMesh(bytes);
  if (mesh.positions.length / 3 !== ref.vertices || mesh.indices.length / 3 !== ref.faces) {
    throw new Error(`subject-anatomy: the ${h} mesh counts disagree with the index`);
  }
  return mesh;
}

/** The subject's hemispheres as one mesh. Rejects on any failed read or check. */
export async function loadSubjectSurface(
  datasetId: string,
  entry: SubjectEntry,
  options: { fetch?: FetchLike; base?: string } = {},
): Promise<BrainMesh> {
  const doFetch = options.fetch ?? ((u, i) => fetch(u, i));
  const base = geometryBaseUrl(datasetId, options.base);
  const parts = await Promise.all(
    HEMISPHERES.flatMap((h) => {
      const ref = entry.meshes[h];
      return ref ? [loadHemisphere(base, h, ref, doFetch)] : [];
    }),
  );
  return parts.length === 1 ? parts[0] : mergeMeshes(parts[0], parts[1]);
}

const meshLoads = new Map<string, Promise<BrainMesh>>();
/** One load per dataset and electrodes file for the page's life; a failure is not kept. */
export function subjectSurfaceFor(datasetId: string, entry: SubjectEntry): Promise<BrainMesh> {
  const key = subjectKey(datasetId, entry);
  let load = meshLoads.get(key);
  if (!load) {
    load = loadSubjectSurface(datasetId, entry).catch((err) => {
      meshLoads.delete(key);
      throw err;
    });
    meshLoads.set(key, load);
  }
  return load;
}

export function subjectKey(datasetId: string, entry: SubjectEntry): string {
  return `${datasetId}|${entry.electrodes}`;
}

// ---------------------------------------------------------------------------
// The 2D views' outlines, from the subject's own mesh
// ---------------------------------------------------------------------------

/** Cell size of the silhouette's raster, millimeters. Finer than a contact, coarser than a pixel. */
const CELL_MM = 0.75;
const AXIS_NAMES = ["x", "y", "z"] as const;

/**
 * The silhouette of the mesh as seen along one axis: the projected triangles are rasterized, the
 * background is flooded from the border (so a speck between triangles is not a hole), and the
 * boundary of what is left is traced into closed polylines and lightly smoothed. Coordinates are
 * [horizontal, vertical] in millimeters, unflipped, the same convention as a template's
 * `views.json`.
 */
export function silhouette(mesh: BrainMesh, h: 0 | 1 | 2, v: 0 | 1 | 2): [number, number][][] {
  const p = mesh.positions;
  const n = p.length / 3;
  if (n === 0) return [];
  let loH = Number.POSITIVE_INFINITY;
  let hiH = Number.NEGATIVE_INFINITY;
  let loV = Number.POSITIVE_INFINITY;
  let hiV = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    loH = Math.min(loH, p[3 * i + h]);
    hiH = Math.max(hiH, p[3 * i + h]);
    loV = Math.min(loV, p[3 * i + v]);
    hiV = Math.max(hiV, p[3 * i + v]);
  }
  const PAD = 2;
  const w = Math.ceil((hiH - loH) / CELL_MM) + 2 * PAD + 1;
  const ht = Math.ceil((hiV - loV) / CELL_MM) + 2 * PAD + 1;
  const mark = new Uint8Array(w * ht);
  const cx = (i: number) => (p[3 * i + h] - loH) / CELL_MM + PAD;
  const cy = (i: number) => (p[3 * i + v] - loV) / CELL_MM + PAD;

  for (let i = 0; i < n; i++) mark[Math.floor(cy(i)) * w + Math.floor(cx(i))] = 1;
  const idx = mesh.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const ax = cx(idx[t]);
    const ay = cy(idx[t]);
    const bx = cx(idx[t + 1]);
    const by = cy(idx[t + 1]);
    const ex = cx(idx[t + 2]);
    const ey = cy(idx[t + 2]);
    const det = (by - ey) * (ax - ex) + (ex - bx) * (ay - ey);
    if (det === 0) continue;
    const x0 = Math.floor(Math.min(ax, bx, ex));
    const x1 = Math.floor(Math.max(ax, bx, ex));
    const y0 = Math.floor(Math.min(ay, by, ey));
    const y1 = Math.floor(Math.max(ay, by, ey));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const l1 = ((by - ey) * (px - ex) + (ex - bx) * (py - ey)) / det;
        const l2 = ((ey - ay) * (px - ex) + (ax - ex) * (py - ey)) / det;
        if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) mark[y * w + x] = 1;
      }
    }
  }

  // Flood the background from the border; whatever it cannot reach is the silhouette.
  const outside = new Uint8Array(w * ht);
  const stack: number[] = [0];
  outside[0] = 1;
  while (stack.length > 0) {
    const c = stack.pop() as number;
    const x = c % w;
    const y = (c - x) / w;
    const next: number[] = [];
    if (x > 0) next.push(c - 1);
    if (x < w - 1) next.push(c + 1);
    if (y > 0) next.push(c - w);
    if (y < ht - 1) next.push(c + w);
    for (const q of next) {
      if (!mark[q] && !outside[q]) {
        outside[q] = 1;
        stack.push(q);
      }
    }
  }
  const filled = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < ht && !outside[y * w + x];

  // Directed boundary edges with the silhouette on the left, keyed by their start vertex.
  const key = (x: number, y: number) => y * (w + 1) + x;
  const edges = new Map<number, number[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = key(x0, y0);
    const list = edges.get(k);
    if (list) list.push(key(x1, y1));
    else edges.set(k, [key(x1, y1)]);
  };
  for (let y = 0; y < ht; y++) {
    for (let x = 0; x < w; x++) {
      if (!filled(x, y)) continue;
      if (!filled(x, y - 1)) add(x, y, x + 1, y);
      if (!filled(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!filled(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!filled(x - 1, y)) add(x, y + 1, x, y);
    }
  }

  const loops: [number, number][][] = [];
  for (const startKey of [...edges.keys()]) {
    while ((edges.get(startKey)?.length ?? 0) > 0) {
      const ring: number[] = [startKey];
      let at = startKey;
      for (;;) {
        const out = edges.get(at);
        const to = out?.pop();
        if (to === undefined) break;
        if (to === startKey) break;
        ring.push(to);
        at = to;
      }
      const pts = ring.map((k): [number, number] => {
        const x = k % (w + 1);
        return [x, (k - x) / (w + 1)];
      });
      loops.push(
        smooth(dropCollinear(pts)).map(([x, y]) => [
          round2(loH + (x - PAD) * CELL_MM),
          round2(loV + (y - PAD) * CELL_MM),
        ]),
      );
    }
  }
  return loops.filter((ring) => ring.length >= 3);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function dropCollinear(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b);
  }
  return out;
}

/** One round of corner cutting: rounds the raster's stair steps without moving the outline by more than a quarter cell. */
function smooth(pts: [number, number][]): [number, number][] {
  const n = pts.length;
  if (n < 3) return pts;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
    out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
  }
  return out;
}

/** The three views' outlines of the subject's surface, in the shape a template's `views.json` has. */
export function subjectOutlines(mesh: BrainMesh): TemplateOutlines {
  const out = {} as TemplateOutlines;
  for (const name of VIEW_NAMES as readonly ViewName[]) {
    const def = VIEW_DEFS[name];
    out[name] = {
      axes: [AXIS_NAMES[def.h], AXIS_NAMES[def.v]],
      polylines: silhouette(mesh, def.h, def.v),
    };
  }
  return out;
}
