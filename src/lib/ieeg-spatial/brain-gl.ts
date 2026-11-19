/**
 * A small WebGL2 renderer for a translucent brain mesh and up to 2,000 electrode contacts
 * (card IS-R1). Hand-written like the signal viewer's trace layer (`eeg-viewer/gl-trace.ts`):
 * no three.js, no new dependency, drawn on demand (no animation loop while idle), and loaded
 * in the panel's own lazy chunk, fetched only for an iEEG recording.
 *
 * Coordinates are millimeters in right-anterior-superior (RAS) space with +z up; see
 * `camera.ts` for the orbit camera and the six view presets. Contacts are one instanced
 * icosphere; each contact's radius comes from its BIDS `size` (square millimeters). The mesh
 * is drawn after the opaque contacts with depth writes off, so a contact inside the cortex
 * stays visible through it. Picking is on the CPU (a ray against the spheres), never a second
 * render pass.
 */

import {
  type Camera,
  type Mat4,
  type Vec3,
  type ViewPreset,
  createCamera,
  fitCamera,
  mmPerPixel,
  multiply,
  nearFar,
  orbitBy,
  projectionMatrix,
  rescaleForAspect,
  screenRay,
  setPreset,
  viewMatrix,
  zoomBy,
} from "./camera";
import { type BrainMesh, icosphere, vertexNormals } from "./mesh-format";

export type { ViewPreset } from "./camera";
export type { BrainMesh } from "./mesh-format";

/** The most contacts one view draws; a caller with more refuses before it reaches the renderer. */
export const MAX_CONTACTS = 2000;
/**
 * A contact is pickable within at least this many CSS pixels of its center, however small. It is
 * the default of `pick`'s `minPx`, exported so the panel can pass a larger one for a coarse
 * pointer (a finger needs more than a mouse).
 */
export const MIN_PICK_PX = 4;

const DEFAULT_RADIUS_MM = 1.5;
const MESH_ALPHA = 0.25;
/** Light backgrounds show the surface as a heavy gray at the dark theme's alpha, so it gets less. */
const MESH_ALPHA_LIGHT = 0.12;
/** While Activity colors the contacts the surface steps back again, so the colors read through it. */
const EMPHASIS_ALPHA_FACTOR = 0.45;
/** Contacts are drawn this much larger with Activity on, inside a thin outline of the contrast color. */
export const EMPHASIS_GROW = 1.3;
const OUTLINE_GROW = 1.22;
const MAX_DPR = 2;
/** Selection ring thickness, CSS pixels. */
const RING_PX = 3;

export interface BrainContact {
  /**
   * Millimeters, RAS. The caller filters out contacts that have no position (an unlocated
   * contact upstream has a null one) and keeps its own map from this array's indices to its
   * contacts; a null or non-finite position makes `setContacts` throw a `RangeError`.
   */
  position: Vec3;
  /** BIDS `size`, square millimeters; null, missing or not positive means n/a. */
  size?: number | null;
}

/** Resolved CSS colors ("#rrggbb", "#rgb" or "rgb(...)"), read by the panel from the theme tokens. */
export interface BrainTheme {
  /** Canvas background (`--color-bg`). */
  background: string;
  /** Selection ring and mesh rim (`--color-fg`). */
  outline: string;
  /** Mesh body (`--color-fg-muted`). */
  mesh: string;
  /** A contact with no color of its own (`--brand-electrode`). */
  contact: string;
}

export interface BrainRenderer {
  /**
   * The mesh to draw, or null for none. `alpha` defaults to the theme's (`meshAlphaFor`). Re-fits
   * the camera.
   */
  setMesh(mesh: BrainMesh | null, alpha?: number): void;
  /** Replace the contacts. Resets colors and selection and re-fits the camera. */
  setContacts(contacts: readonly BrainContact[]): void;
  /**
   * Four values in 0..1 (r, g, b, a) per contact. Alpha 0 hides a contact and its pick area;
   * alpha between 0 and 1 draws it translucent, in a second pass sorted back to front with depth
   * writes off, so overlapping translucent contacts compose in any index order.
   */
  setColors(rgba: ArrayLike<number>): void;
  /**
   * Make colored contacts read (Activity on): the surface gets more transparent, and contacts are
   * drawn unlit at full color, a little larger, inside a thin outline.
   */
  setEmphasis(on: boolean): void;
  /** Ring one contact (drawn on top, even when hidden behind others), or null for none. */
  setSelected(index: number | null): void;
  /** Re-fit the camera to the content and look from a preset direction. */
  setView(preset: ViewPreset): void;
  /**
   * The contact under a point in CSS pixels from the canvas's top-left corner, or null. Exact
   * sphere hits win, nearest first; failing that, the contact whose center is closest within
   * `minPx` pixels (default MIN_PICK_PX).
   */
  pick(x: number, y: number, minPx?: number): number | null;
  /** Recolor the background, rim and default contact. */
  setTheme(theme: BrainTheme): void;
  /** Draw now. Called for you after any input or state change; rarely needed directly. */
  render(): void;
  /**
   * Match the drawing buffer to the canvas's CSS size (device pixel ratio capped at 2) and, if
   * the canvas changed shape since the camera was fitted, rescale the camera to still fit, keeping
   * the user's zoom.
   */
  resize(): void;
  /** The current frame, top row first. Throws while the context is lost. */
  snapshot(): ImageData;
  /**
   * Free every GPU resource and listener. Safe to call twice. The canvas is left holding a
   * deliberately lost context (so the browser's context cap is not used up), as it is after a
   * failed `createBrainRenderer`: use a fresh canvas element for each renderer.
   */
  dispose(): void;
}

/**
 * The surface's alpha: tuned per theme (a light canvas needs far less than a dark one to read as a
 * translucent shell) and reduced again while `emphasis` (Activity) wants the contacts to read.
 * `background` is the canvas color as 0..1 RGB.
 */
export function meshAlphaFor(
  background: readonly [number, number, number],
  emphasis: boolean,
): number {
  const luma = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2];
  const base = luma > 0.5 ? MESH_ALPHA_LIGHT : MESH_ALPHA;
  return emphasis ? base * EMPHASIS_ALPHA_FACTOR : base;
}

/** radius = sqrt(size / pi), clamped to 0.5-3 mm; 1.5 mm when the size is n/a. */
export function contactRadius(size: number | null | undefined): number {
  if (typeof size !== "number" || !(size > 0)) return DEFAULT_RADIUS_MM;
  return Math.min(3, Math.max(0.5, Math.sqrt(size / Math.PI)));
}

/** x, y, z and radius per contact, the layout of the instance buffer and of picking. */
export function packContacts(contacts: readonly BrainContact[]): Float32Array {
  if (contacts.length > MAX_CONTACTS) {
    throw new RangeError(`brain-gl: at most ${MAX_CONTACTS} contacts, got ${contacts.length}`);
  }
  const out = new Float32Array(contacts.length * 4);
  contacts.forEach((c, i) => {
    if (!c.position || !c.position.every(Number.isFinite)) {
      throw new RangeError(`brain-gl: contact ${i} has no finite position`);
    }
    out.set(c.position, i * 4);
    out[i * 4 + 3] = contactRadius(c.size);
  });
  return out;
}

/** "#rgb", "#rrggbb", "rgb(r, g, b)" or "rgba(r g b / a)" to 0..1; mid-gray (with a warning) otherwise. */
export function parseColor(css: string): [number, number, number] {
  const s = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (fn)
    return [1, 2, 3].map((i) => Math.min(255, Number(fn[i])) / 255) as [number, number, number];
  console.warn(`[ieeg-spatial] unreadable color "${css}", using gray`);
  return [0.5, 0.5, 0.5];
}

/**
 * The contact under a canvas point (CSS pixels), or null. Exact sphere hits win, nearest to the
 * eye first. Spheres smaller than `minPx` pixels (default MIN_PICK_PX) also count within that
 * floor, but only when no exact sphere is under the point, and then the contact whose center
 * is closest to the point wins, not the nearest in depth. A contact whose alpha byte is 0 is
 * hidden and skipped; one behind the eye is never hit, because its closest approach to the ray
 * lies behind the ray's origin.
 */
export function pickNearest(
  cam: Camera,
  x: number,
  y: number,
  width: number,
  height: number,
  spheres: Float32Array,
  colors?: Uint8Array,
  minPx: number = MIN_PICK_PX,
): number | null {
  const { origin: o, dir: d } = screenRay(cam, x, y, width, height);
  const fwd = screenRay(cam, width / 2, height / 2, width, height).dir;
  let exact: number | null = null;
  let exactT = Number.POSITIVE_INFINITY;
  let floor: number | null = null;
  let floorPx = Number.POSITIVE_INFINITY;
  for (let i = 0; i < spheres.length / 4; i++) {
    if (colors && colors[i * 4 + 3] === 0) continue;
    const mx = spheres[i * 4] - o[0];
    const my = spheres[i * 4 + 1] - o[1];
    const mz = spheres[i * 4 + 2] - o[2];
    const depth = mx * fwd[0] + my * fwd[1] + mz * fwd[2];
    const mm = mmPerPixel(cam, depth, height);
    const r = spheres[i * 4 + 3];
    const tca = mx * d[0] + my * d[1] + mz * d[2];
    const miss2 = mx * mx + my * my + mz * mz - tca * tca;
    if (tca < 0 || miss2 > Math.max(r, minPx * mm) ** 2) continue;
    if (miss2 <= r * r) {
      const t = tca - Math.sqrt(r * r - miss2);
      if (t < exactT) {
        exactT = t;
        exact = i;
      }
    } else if (Math.sqrt(miss2) / mm < floorPx) {
      floorPx = Math.sqrt(miss2) / mm;
      floor = i;
    }
  }
  return exact ?? floor;
}

/**
 * The contacts to draw in the translucent pass (alpha byte 1 to 254), farthest from the eye
 * first, given the view matrix. Opaque contacts (255) are drawn in the first pass and hidden
 * ones (0) not at all.
 */
export function translucentOrder(spheres: Float32Array, colors: Uint8Array, view: Mat4): number[] {
  const order: number[] = [];
  const depth: number[] = [];
  for (let i = 0; i < colors.length / 4; i++) {
    const a = colors[i * 4 + 3];
    if (a > 0 && a < 255) {
      order.push(i);
      depth[i] = -(
        view[2] * spheres[i * 4] +
        view[6] * spheres[i * 4 + 1] +
        view[10] * spheres[i * 4 + 2] +
        view[14]
      );
    }
  }
  return order.sort((p, q) => depth[q] - depth[p]);
}

// --- shaders ---------------------------------------------------------------

// The light is fixed in view space, upper left and toward the viewer, so shading follows the
// camera. Normals leave the vertex stage already rotated into view space.
const MESH_VS = `#version 300 es
layout(location=0) in vec3 a_p;
layout(location=1) in vec3 a_n;
uniform mat4 u_vp, u_v;
out vec3 v_n;
void main(){
  v_n = mat3(u_v) * a_n;
  gl_Position = u_vp * vec4(a_p, 1);
}`;

const MESH_FS = `#version 300 es
precision mediump float;
in vec3 v_n;
uniform vec3 u_c, u_o;
uniform float u_a;
out vec4 o;
void main(){
  vec3 n = normalize(v_n);
  float rim = pow(1. - abs(n.z), 2.);
  vec3 c = u_c * (.35 + .65 * abs(dot(n, vec3(.3, .5, .8))));
  o = vec4(mix(c, u_o, rim * .5), u_a * (1. + 1.5 * rim));
}`;

// u_mode 0 draws the opaque contacts, 3 the translucent ones (from their own sorted buffers),
// 1 the ring (the selected instance, grown), 2 the selected instance alone at its own alpha,
// 4 the outline of the opaque ones (an inverted hull: a larger sphere, front faces culled).
// For 1 and 2 other instances are pushed outside the clip volume instead of drawn, which keeps
// the selection passes on the main buffers and VAO.
const CONTACT_VS = (OUTLINE: number) => `#version 300 es
layout(location=0) in vec3 a_p;
layout(location=1) in vec4 a_c;
layout(location=2) in vec4 a_k;
uniform mat4 u_vp, u_v;
uniform int u_sel, u_mode;
uniform float u_ring, u_grow;
out vec3 v_n;
flat out vec4 v_k;
void main(){
  if ((u_mode == 1 || u_mode == 2) && gl_InstanceID != u_sel) { gl_Position = vec4(2, 2, 2, 1); return; }
  float r = a_c.w * u_grow;
  if (u_mode == 4) r *= ${OUTLINE.toFixed(2)};
  if (u_mode == 1) r += max(.35 * r, u_ring * (u_vp * vec4(a_c.xyz, 1)).w);
  v_n = mat3(u_v) * a_p;
  v_k = a_k;
  gl_Position = u_vp * vec4(a_c.xyz + a_p * r, 1);
}`;

const CONTACT_FS = `#version 300 es
precision mediump float;
precision highp int;
in vec3 v_n;
flat in vec4 v_k;
uniform vec3 u_o;
uniform int u_mode;
uniform float u_flat;
out vec4 o;
void main(){
  if (v_k.a < .002 || ((u_mode == 0 || u_mode == 4) && v_k.a < .998)) discard;
  if (u_mode == 1 || u_mode == 4) { o = vec4(u_o, 1); return; }
  float d = max(dot(normalize(v_n), vec3(.3, .5, .8)), 0.);
  o = vec4(mix(v_k.rgb * (.45 + .55 * d), v_k.rgb, u_flat), v_k.a);
}`;

// --- renderer --------------------------------------------------------------

interface Program {
  p: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

/**
 * A renderer on `canvas`, or null when WebGL2 or shader compilation is unavailable (the caller
 * then uses the 2D views). The canvas's CSS size is the panel's to set; call `resize()` after it
 * changes. Pointer drag orbits, wheel and pinch zoom; a click that ends a drag is swallowed so
 * the panel's own click handler sees only taps. After a failed call or after `dispose()` the
 * canvas holds a deliberately lost context, so use a fresh canvas element per renderer.
 */
export function createBrainRenderer(
  canvas: HTMLCanvasElement,
  themeColors: BrainTheme,
): BrainRenderer | null {
  let ctx: WebGL2RenderingContext | null = null;
  try {
    ctx = canvas.getContext("webgl2", {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: false,
    });
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  const gl: WebGL2RenderingContext = ctx;

  // CPU copies of every input: the source of truth a context restore rebuilds from.
  const cam = createCamera();
  let theme = readTheme(themeColors);
  let mesh: BrainMesh | null = null;
  let meshNormals: Float32Array | null = null;
  /** An alpha the caller chose; null lets the theme and `emphasis` decide. */
  let meshAlphaOverride: number | null = null;
  let emphasis = false;
  let spheres: Float32Array = new Float32Array(0);
  let colors = new Uint8Array(0);
  let ownColors = false;
  let selected: number | null = null;
  let center: Vec3 = [0, 0, 0];
  let radius = 100;
  let dpr = 1;
  // The aspect ratio the camera was last fitted or rescaled for (a 0 x 0 canvas counts as 1).
  let fitAspect = 1;
  let lost = false;
  let disposed = false;
  let frame = 0;

  // Every GPU object lives in one of these sets until it is deleted, so dispose and a context
  // restore can free all of it without chasing names.
  const buffers = new Set<WebGLBuffer>();
  const vaos = new Set<WebGLVertexArrayObject>();
  const programs = new Set<WebGLProgram>();
  const need = <T>(o: T | null): T => {
    if (!o) throw new Error("brain-gl: GPU allocation failed");
    return o;
  };
  const makeBuffer = (
    target: number,
    data: ArrayBufferView,
    usage: number = gl.STATIC_DRAW,
  ): WebGLBuffer => {
    const b = need(gl.createBuffer());
    buffers.add(b);
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, usage);
    return b;
  };
  const makeVao = (): WebGLVertexArrayObject => {
    const v = need(gl.createVertexArray());
    vaos.add(v);
    gl.bindVertexArray(v);
    return v;
  };
  const dropBuffer = (b: WebGLBuffer | null): void => {
    if (b && buffers.delete(b)) gl.deleteBuffer(b);
  };
  const dropVao = (v: WebGLVertexArrayObject | null): void => {
    if (v && vaos.delete(v)) gl.deleteVertexArray(v);
  };
  const forget = (): void => {
    buffers.clear();
    vaos.clear();
    programs.clear();
  };
  const freeAll = (): void => {
    for (const b of buffers) gl.deleteBuffer(b);
    for (const v of vaos) gl.deleteVertexArray(v);
    for (const p of programs) gl.deleteProgram(p);
    forget();
  };

  function compile(type: number, src: string): WebGLShader {
    const sh = need(gl.createShader(type));
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`brain-gl: shader compile failed: ${log}`);
    }
    return sh;
  }
  function link(vs: string, fs: string, uniforms: string[]): Program {
    const a = compile(gl.VERTEX_SHADER, vs);
    let b: WebGLShader | null = null;
    try {
      b = compile(gl.FRAGMENT_SHADER, fs);
      const p = need(gl.createProgram());
      programs.add(p);
      gl.attachShader(p, a);
      gl.attachShader(p, b);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error(`brain-gl: program link failed: ${gl.getProgramInfoLog(p)}`);
      }
      return { p, u: Object.fromEntries(uniforms.map((n) => [n, gl.getUniformLocation(p, n)])) };
    } finally {
      gl.deleteShader(a);
      if (b) gl.deleteShader(b);
    }
  }

  let meshProg: Program;
  let contactProg: Program;
  let sphereVao: WebGLVertexArrayObject;
  // The translucent pass reads its own VAO over the same sphere geometry, and instance buffers
  // refilled each frame in back-to-front order.
  let softVao: WebGLVertexArrayObject;
  let sphereIndexCount = 0;
  let instanceBuf: WebGLBuffer | null = null;
  let colorBuf: WebGLBuffer | null = null;
  let softInstanceBuf: WebGLBuffer | null = null;
  let softColorBuf: WebGLBuffer | null = null;
  let softSpheres = new Float32Array(0);
  let softColors = new Uint8Array(0);
  let meshVao: WebGLVertexArrayObject | null = null;
  let meshBufs: WebGLBuffer[] = [];
  let meshIndexCount = 0;
  let meshIndexType = 0;

  /** Upload (or re-upload) the contact buffers into the sphere VAO. */
  function uploadContacts(): void {
    dropBuffer(instanceBuf);
    dropBuffer(colorBuf);
    dropBuffer(softInstanceBuf);
    dropBuffer(softColorBuf);
    gl.bindVertexArray(sphereVao);
    instanceBuf = makeBuffer(gl.ARRAY_BUFFER, spheres);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    colorBuf = makeBuffer(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(2, 1);
    softSpheres = new Float32Array(spheres.length);
    softColors = new Uint8Array(colors.length);
    gl.bindVertexArray(softVao);
    softInstanceBuf = makeBuffer(gl.ARRAY_BUFFER, softSpheres, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    softColorBuf = makeBuffer(gl.ARRAY_BUFFER, softColors, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
  }

  /**
   * Rewrite the colors in place. The buffer always holds one RGBA entry per contact, and the
   * contact count only changes through `setContacts`, which rebuilds it.
   */
  function uploadColors(): void {
    if (!colorBuf) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors);
  }

  function uploadMesh(): void {
    for (const b of meshBufs) dropBuffer(b);
    dropVao(meshVao);
    meshBufs = [];
    meshVao = null;
    meshIndexCount = 0;
    if (!mesh || !meshNormals) return;
    meshVao = makeVao();
    meshBufs.push(makeBuffer(gl.ARRAY_BUFFER, mesh.positions));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    meshBufs.push(makeBuffer(gl.ARRAY_BUFFER, meshNormals));
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    meshBufs.push(makeBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices));
    gl.bindVertexArray(null);
    meshIndexCount = mesh.indices.length;
    meshIndexType = mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  }

  /** Build every GPU object from the CPU copies. */
  function build(): void {
    instanceBuf = colorBuf = softInstanceBuf = softColorBuf = meshVao = null;
    meshBufs = [];
    meshProg = link(MESH_VS, MESH_FS, ["u_vp", "u_v", "u_c", "u_o", "u_a"]);
    contactProg = link(CONTACT_VS(OUTLINE_GROW), CONTACT_FS, [
      "u_vp",
      "u_v",
      "u_o",
      "u_sel",
      "u_mode",
      "u_ring",
      "u_grow",
      "u_flat",
    ]);
    const s = icosphere(1);
    sphereVao = makeVao();
    const vertices = makeBuffer(gl.ARRAY_BUFFER, s.positions);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const triangles = makeBuffer(gl.ELEMENT_ARRAY_BUFFER, s.indices);
    sphereIndexCount = s.indices.length;
    softVao = makeVao();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triangles);
    gl.bindVertexArray(null);
    uploadContacts();
    uploadMesh();
  }

  try {
    build();
  } catch (e) {
    console.warn("[ieeg-spatial] WebGL2 renderer unavailable:", e);
    freeAll();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  }

  // --- state helpers ---

  function readTheme(t: BrainTheme) {
    return {
      background: parseColor(t.background),
      outline: parseColor(t.outline),
      mesh: parseColor(t.mesh),
      contact: parseColor(t.contact),
    };
  }

  function defaultColors(): void {
    const [r, g, b] = theme.contact.map((v) => Math.round(v * 255));
    for (let i = 0; i < colors.length; i += 4) colors.set([r, g, b, 255], i);
  }

  function aspect(): number {
    return canvas.clientWidth > 0 && canvas.clientHeight > 0
      ? canvas.clientWidth / canvas.clientHeight
      : 1;
  }

  /** Bounding sphere of the mesh and the contacts; the camera fits to it. */
  function refit(): void {
    const lo = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const hi = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    const add = (p: ArrayLike<number>, at: number, pad: number): void => {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], p[at + k] - pad);
        hi[k] = Math.max(hi[k], p[at + k] + pad);
      }
    };
    if (mesh) for (let i = 0; i < mesh.positions.length; i += 3) add(mesh.positions, i, 0);
    for (let i = 0; i < spheres.length; i += 4) add(spheres, i, spheres[i + 3]);
    if (lo[0] === Number.POSITIVE_INFINITY) {
      center = [0, 0, 0];
      radius = 100;
    } else {
      center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      radius = Math.max(10, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    }
    fitAspect = aspect();
    fitCamera(cam, center, radius, fitAspect);
  }

  /** The context is gone: the event has fired, or the browser says so before it does. */
  const isLost = (): boolean => lost || gl.isContextLost();

  function schedule(): void {
    if (frame || disposed || isLost()) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function draw(): void {
    if (disposed || isLost()) return;
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    gl.viewport(0, 0, w, h);
    gl.clearColor(...theme.background, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthFunc(gl.LEQUAL);

    const [near, far] = nearFar(cam, radius);
    const v = viewMatrix(cam);
    const vp = multiply(projectionMatrix(cam, w / h, near, far), v);
    const n = spheres.length / 4;

    // Opaque contacts first.
    if (n) {
      const { p, u } = contactProg;
      gl.useProgram(p);
      gl.bindVertexArray(sphereVao);
      gl.uniformMatrix4fv(u.u_vp, false, vp);
      gl.uniformMatrix4fv(u.u_v, false, v);
      gl.uniform3fv(u.u_o, theme.outline);
      gl.uniform1i(u.u_sel, selected ?? -1);
      gl.uniform1f(u.u_ring, mmPerPixel(cam, 1, h) * RING_PX * dpr);
      gl.uniform1f(u.u_grow, emphasis ? EMPHASIS_GROW : 1);
      gl.uniform1f(u.u_flat, emphasis ? 1 : 0);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.enable(gl.CULL_FACE);
      if (emphasis) {
        gl.cullFace(gl.FRONT);
        gl.uniform1i(u.u_mode, 4);
        gl.drawElementsInstanced(gl.TRIANGLES, sphereIndexCount, gl.UNSIGNED_SHORT, 0, n);
        gl.cullFace(gl.BACK);
      }
      gl.uniform1i(u.u_mode, 0);
      gl.drawElementsInstanced(gl.TRIANGLES, sphereIndexCount, gl.UNSIGNED_SHORT, 0, n);

      // Translucent contacts: depth-tested against the opaque ones, never depth-writing, drawn
      // farthest first from buffers refilled in that order, so they compose in any index order.
      const soft = translucentOrder(spheres, colors, v);
      if (soft.length && softInstanceBuf && softColorBuf) {
        soft.forEach((i, k) => {
          softSpheres.set(spheres.subarray(i * 4, i * 4 + 4), k * 4);
          softColors.set(colors.subarray(i * 4, i * 4 + 4), k * 4);
        });
        gl.bindBuffer(gl.ARRAY_BUFFER, softInstanceBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, softSpheres, 0, soft.length * 4);
        gl.bindBuffer(gl.ARRAY_BUFFER, softColorBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, softColors, 0, soft.length * 4);
        gl.bindVertexArray(softVao);
        gl.depthMask(false);
        gl.uniform1i(u.u_mode, 3);
        gl.drawElementsInstanced(gl.TRIANGLES, sphereIndexCount, gl.UNSIGNED_SHORT, 0, soft.length);
        gl.depthMask(true);
      }
    }

    // The translucent mesh over them: depth-tested, never depth-writing, both faces.
    if (meshVao && meshIndexCount) {
      const { p, u } = meshProg;
      gl.useProgram(p);
      gl.bindVertexArray(meshVao);
      gl.uniformMatrix4fv(u.u_vp, false, vp);
      gl.uniformMatrix4fv(u.u_v, false, v);
      gl.uniform3fv(u.u_c, theme.mesh);
      gl.uniform3fv(u.u_o, theme.outline);
      gl.uniform1f(u.u_a, meshAlphaOverride ?? meshAlphaFor(theme.background, emphasis));
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.drawElements(gl.TRIANGLES, meshIndexCount, meshIndexType, 0);
      gl.depthMask(true);
    }

    // The selection ring and the selected contact, on top of everything.
    if (n && selected !== null) {
      gl.useProgram(contactProg.p);
      gl.bindVertexArray(sphereVao);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      for (const mode of [1, 2]) {
        gl.uniform1i(contactProg.u.u_mode, mode);
        gl.drawElementsInstanced(gl.TRIANGLES, sphereIndexCount, gl.UNSIGNED_SHORT, 0, n);
      }
    }
    gl.bindVertexArray(null);
  }

  // --- input ---

  const pointers = new Map<number, [number, number]>();
  let pinchGap = 0;
  let traveled = 0;
  let swallowClick = false;
  const gap = (): number => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  };
  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (a synthetic or late event). Capture only keeps a drag alive
      // after the pointer leaves the canvas, so the gesture still works without it.
    }
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 1) traveled = 0;
    if (pointers.size === 2) pinchGap = gap();
  };
  const onMove = (e: PointerEvent): void => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev[0];
    const dy = e.clientY - prev[1];
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 1) {
      traveled += Math.abs(dx) + Math.abs(dy);
      orbitBy(cam, dx, dy);
    } else if (pointers.size === 2) {
      const g = gap();
      if (pinchGap > 0 && g > 0) zoomBy(cam, pinchGap / g);
      pinchGap = g;
      traveled = Number.POSITIVE_INFINITY;
    }
    schedule();
  };
  const onUp = (e: PointerEvent): void => {
    if (!pointers.delete(e.pointerId)) return;
    pinchGap = 0;
    if (traveled > 4) {
      swallowClick = true;
      setTimeout(() => {
        swallowClick = false;
      }, 0);
    }
  };
  const onClick = (e: MouseEvent): void => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    zoomBy(cam, Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    schedule();
  };
  const onLost = (e: Event): void => {
    e.preventDefault();
    lost = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const onRestored = (): void => {
    // Every object of the lost context is already invalid: forget them, deleting would only warn.
    forget();
    try {
      build();
      lost = false;
      schedule();
    } catch (e) {
      console.warn("[ieeg-spatial] WebGL2 context could not be rebuilt:", e);
    }
  };

  const touchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("click", onClick, true);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    setMesh(input, alpha) {
      if (disposed) return;
      const next = input && input.positions.length > 0 ? input : null;
      if (next) {
        if (next.positions.length % 3 || next.indices.length % 3) {
          throw new RangeError("brain-gl: mesh counts are not multiples of three");
        }
        const nv = next.positions.length / 3;
        for (let i = 0; i < next.indices.length; i++) {
          if (next.indices[i] >= nv) {
            throw new RangeError("brain-gl: mesh index past the last vertex");
          }
        }
      }
      mesh = next;
      meshNormals = next ? vertexNormals(next) : null;
      meshAlphaOverride = alpha === undefined ? null : Math.min(1, Math.max(0, alpha));
      if (!isLost()) uploadMesh();
      refit();
      schedule();
    },
    setContacts(contacts) {
      if (disposed) return;
      spheres = packContacts(contacts);
      colors = new Uint8Array(contacts.length * 4);
      ownColors = false;
      defaultColors();
      selected = null;
      if (!isLost()) uploadContacts();
      refit();
      schedule();
    },
    setColors(rgba) {
      if (disposed) return;
      if (rgba.length !== colors.length) {
        throw new RangeError(
          `brain-gl: expected ${colors.length} color values, got ${rgba.length}`,
        );
      }
      // A live recolor (every animation frame) rewrites the buffer this renderer already owns.
      const next = ownColors ? colors : new Uint8Array(rgba.length);
      for (let i = 0; i < rgba.length; i++) {
        next[i] = Math.round(Math.min(1, Math.max(0, rgba[i])) * 255);
      }
      colors = next;
      ownColors = true;
      if (!isLost()) uploadColors();
      schedule();
    },
    setEmphasis(on) {
      if (disposed || on === emphasis) return;
      emphasis = on;
      schedule();
    },
    setSelected(index) {
      if (disposed) return;
      if (
        index !== null &&
        !(Number.isInteger(index) && index >= 0 && index < spheres.length / 4)
      ) {
        throw new RangeError(`brain-gl: no contact ${index}`);
      }
      selected = index;
      schedule();
    },
    setView(preset) {
      if (disposed) return;
      setPreset(cam, preset);
      refit();
      schedule();
    },
    pick(x, y, minPx = MIN_PICK_PX) {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (disposed || !w || !h) return null;
      return pickNearest(cam, x, y, w, h, spheres, colors, minPx);
    },
    setTheme(t) {
      if (disposed) return;
      theme = readTheme(t);
      if (!ownColors) {
        defaultColors();
        if (!isLost()) uploadColors();
      }
      schedule();
    },
    render() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      draw();
    },
    resize() {
      if (disposed) return;
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      // Data may have been fitted while the canvas was 0 x 0 or a different shape: keep the
      // user's zoom, but back off (or in) as a fresh fit would for this shape.
      const next = aspect();
      rescaleForAspect(cam, fitAspect, next);
      fitAspect = next;
      schedule();
    },
    snapshot() {
      if (disposed || isLost()) {
        throw new Error("brain-gl: no frame to read, the renderer is unavailable");
      }
      draw();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      if (!w || !h) throw new Error("brain-gl: no frame to read, the canvas has no size");
      const raw = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      // GL's rows run bottom to top; ImageData's run top to bottom.
      const out = new Uint8ClampedArray(raw.length);
      for (let row = 0; row < h; row++) {
        out.set(raw.subarray((h - 1 - row) * w * 4, (h - row) * w * 4), row * w * 4);
      }
      return new ImageData(out, w, h);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("click", onClick, true);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      canvas.style.touchAction = touchAction;
      freeAll();
      // Deleting the objects does not release the context, and browsers cap live contexts
      // (about 16 in Chrome), so lose it on purpose; the same reasoning as gl-trace.ts.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
