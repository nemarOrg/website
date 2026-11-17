/**
 * Orbit camera for the iEEG spatial view (card IS-R1). Pure math, no DOM and no GL, so the
 * presets, projection and picking rays are unit-tested in Node.
 *
 * World space is right-anterior-superior (RAS) in millimeters: +x toward the subject's right,
 * +y anterior, +z superior. The camera orbits a target on a turntable: `yaw` turns about +z
 * (0 puts the eye on the +x side), `pitch` lifts the eye above (+) or below (-) the target, and
 * the screen's up axis is +z except at the poles, where it is the analytic limit (so the top
 * and bottom presets have the nose at the top of the screen and nothing is singular).
 *
 * Matrices are column-major `number[16]`, the layout WebGL's `uniformMatrix4fv` takes.
 */

export type Vec3 = readonly [number, number, number];
export type Mat4 = number[];

export type ViewPreset = "left" | "right" | "front" | "back" | "top" | "bottom";

export interface Camera {
  target: Vec3;
  /** Eye to target distance, millimeters. */
  distance: number;
  /** Radians about +z; the eye direction from the target is (cos p cos y, cos p sin y, sin p). */
  yaw: number;
  /** Radians, within [-pi/2, pi/2]. */
  pitch: number;
  /** Vertical field of view, radians. */
  fov: number;
  minDistance: number;
  maxDistance: number;
}

const HALF_PI = Math.PI / 2;

/** [yaw, pitch] of each preset. Anatomy fixes the screen axes: see camera.test.ts. */
export const PRESETS: Record<ViewPreset, readonly [number, number]> = {
  left: [Math.PI, 0],
  right: [0, 0],
  front: [HALF_PI, 0],
  back: [-HALF_PI, 0],
  top: [-HALF_PI, HALF_PI],
  bottom: [HALF_PI, -HALF_PI],
};

/** An oblique right-anterior view from slightly above, the starting view. */
export function createCamera(): Camera {
  return {
    target: [0, 0, 0],
    distance: 400,
    yaw: Math.PI / 4,
    pitch: 0.35,
    fov: (30 * Math.PI) / 180,
    minDistance: 20,
    maxDistance: 4000,
  };
}

export function setPreset(cam: Camera, preset: ViewPreset): void {
  [cam.yaw, cam.pitch] = PRESETS[preset];
}

/** Drag deltas in CSS pixels to radians: about 0.4 degrees per pixel. */
const ORBIT_RATE = 0.007;

/** Dragging right moves the scene right (the eye goes left); dragging down lifts the eye. */
export function orbitBy(cam: Camera, dx: number, dy: number): void {
  cam.yaw -= dx * ORBIT_RATE;
  cam.pitch = Math.max(-HALF_PI, Math.min(HALF_PI, cam.pitch + dy * ORBIT_RATE));
}

export function zoomBy(cam: Camera, factor: number): void {
  cam.distance = Math.max(cam.minDistance, Math.min(cam.maxDistance, cam.distance * factor));
}

/** Half of the narrower field-of-view angle: the vertical one, or the horizontal one on a portrait canvas. */
function fitHalfAngle(cam: Camera, aspect: number): number {
  return Math.atan(Math.tan(cam.fov / 2) * Math.min(1, aspect));
}

/**
 * Center the camera on a bounding sphere and back off until all of it is in view, for the
 * narrower of the two field-of-view angles. Sets the zoom bounds from that distance.
 */
export function fitCamera(cam: Camera, center: Vec3, radius: number, aspect: number): void {
  cam.target = center;
  cam.distance = (radius * 1.1) / Math.sin(fitHalfAngle(cam, aspect));
  cam.minDistance = cam.distance * 0.05;
  cam.maxDistance = cam.distance * 4;
}

/**
 * The canvas changed shape after a fit (data arrived while it was 0 x 0, or the layout turned
 * portrait): move the camera by the ratio that a fresh fit would, keeping the user's zoom. It
 * changes nothing while the canvas stays at least as wide as it is tall, because the fit then
 * depends on the vertical angle alone.
 */
export function rescaleForAspect(cam: Camera, from: number, to: number): void {
  const k = Math.sin(fitHalfAngle(cam, from)) / Math.sin(fitHalfAngle(cam, to));
  cam.distance *= k;
  cam.minDistance *= k;
  cam.maxDistance *= k;
}

/** Near and far planes for a scene of the given radius around the target. */
export function nearFar(cam: Camera, radius: number): [number, number] {
  return [Math.max(0.5, cam.distance * 0.05), cam.distance + radius * 3];
}

interface Basis {
  eye: Vec3;
  right: Vec3;
  up: Vec3;
  /** Unit vector from the target to the eye (the camera looks along its negative). */
  back: Vec3;
}

function basis(cam: Camera): Basis {
  const [sy, cy, sp, cp] = [
    Math.sin(cam.yaw),
    Math.cos(cam.yaw),
    Math.sin(cam.pitch),
    Math.cos(cam.pitch),
  ];
  const back: Vec3 = [cp * cy, cp * sy, sp];
  const t = cam.target;
  const d = cam.distance;
  return {
    eye: [t[0] + d * back[0], t[1] + d * back[1], t[2] + d * back[2]],
    right: [-sy, cy, 0],
    up: [-sp * cy, -sp * sy, cp],
    back,
  };
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function viewMatrix(cam: Camera): Mat4 {
  const { eye, right: r, up: u, back: b } = basis(cam);
  return [
    r[0],
    u[0],
    b[0],
    0,
    r[1],
    u[1],
    b[1],
    0,
    r[2],
    u[2],
    b[2],
    0,
    -dot(r, eye),
    -dot(u, eye),
    -dot(b, eye),
    1,
  ];
}

export function projectionMatrix(cam: Camera, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(cam.fov / 2);
  return [
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) / (near - far),
    -1,
    0,
    0,
    (2 * far * near) / (near - far),
    0,
  ];
}

/** Multiply two column-major matrices: the result applies `b` first, then `a`. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: Mat4 = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** Apply a matrix to a point (w = 1) and divide by w when it is not 1. */
export function transformPoint(m: Mat4, p: Vec3): [number, number, number] {
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [
    (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w,
    (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w,
    (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / w,
  ];
}

/** Millimeters covered by one CSS pixel at a given depth in front of the eye. */
export function mmPerPixel(cam: Camera, depth: number, height: number): number {
  return (2 * depth * Math.tan(cam.fov / 2)) / height;
}

/** A world point to canvas CSS pixels (y down) and its depth in front of the eye, millimeters. */
export function project(
  cam: Camera,
  p: Vec3,
  width: number,
  height: number,
): [number, number, number] {
  const { eye, right, up, back } = basis(cam);
  const q: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const depth = -dot(q, back);
  const half = Math.tan(cam.fov / 2);
  const ndcX = dot(q, right) / (depth * half * (width / height));
  const ndcY = dot(q, up) / (depth * half);
  return [((ndcX + 1) * width) / 2, ((1 - ndcY) * height) / 2, depth];
}

export interface Ray {
  origin: Vec3;
  /** Unit direction. */
  dir: Vec3;
}

/** The ray from the eye through a canvas pixel (CSS pixels, origin at the top left). */
export function screenRay(cam: Camera, x: number, y: number, width: number, height: number): Ray {
  const { eye, right, up, back } = basis(cam);
  const half = Math.tan(cam.fov / 2);
  const sx = (2 * x) / width - 1;
  const sy = 1 - (2 * y) / height;
  const k = half * (width / height) * sx;
  const l = half * sy;
  const d: Vec3 = [
    -back[0] + k * right[0] + l * up[0],
    -back[1] + k * right[1] + l * up[1],
    -back[2] + k * right[2] + l * up[2],
  ];
  const n = Math.hypot(d[0], d[1], d[2]);
  return { origin: eye, dir: [d[0] / n, d[1] / n, d[2] / n] };
}
