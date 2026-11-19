import { describe, expect, it } from "vitest";
import {
  type Camera,
  type ViewPreset,
  createCamera,
  fitCamera,
  mmPerPixel,
  multiply,
  nearFar,
  orbitBy,
  project,
  projectionMatrix,
  rescaleForAspect,
  screenRay,
  setPreset,
  transformPoint,
  viewMatrix,
  zoomBy,
} from "./camera";

const A = [0, 0, 100] as const; // 100 mm superior of the origin
const B = [60, 0, 0] as const; // 60 mm toward the subject's right

function cameraFor(preset: ViewPreset): Camera {
  const cam = createCamera();
  cam.target = [0, 0, 0];
  cam.distance = 400;
  setPreset(cam, preset);
  return cam;
}

/** View space: +x is screen right, +y is screen up, more negative z is farther from the eye. */
function viewOf(cam: Camera, p: readonly [number, number, number]) {
  const [x, y, z] = transformPoint(viewMatrix(cam), p);
  return { x, y, z };
}

describe("view presets", () => {
  // Expected view-space coordinates of A = (0, 0, 100) and B = (60, 0, 0), derived by hand from
  // anatomy for an eye 400 mm from the origin (right-anterior-superior, RAS, millimeters).
  const table: Record<ViewPreset, { a: number[]; b: number[]; why: string }> = {
    left: {
      a: [0, 100, -400],
      b: [0, 0, -460],
      why: "eye on the left; the right side (+x) is farther away; anterior is screen left",
    },
    right: {
      a: [0, 100, -400],
      b: [0, 0, -340],
      why: "eye on the right; +x is nearer to the viewer",
    },
    front: {
      a: [0, 100, -400],
      b: [-60, 0, -400],
      why: "facing the subject: the subject's right (+x) is on the viewer's left",
    },
    back: {
      a: [0, 100, -400],
      b: [60, 0, -400],
      why: "behind the subject: +x is on the viewer's right",
    },
    top: {
      a: [0, 0, -300],
      b: [60, 0, -400],
      why: "from above, nose up the screen: +x is screen right, the vertex is nearest",
    },
    bottom: {
      a: [0, 0, -500],
      b: [-60, 0, -400],
      why: "from below, nose up the screen: +x is screen left, the vertex is farthest",
    },
  };

  for (const preset of Object.keys(table) as ViewPreset[]) {
    it(`${preset}: (0, 0, 100) and (60, 0, 0) land on the expected side (${table[preset].why})`, () => {
      const cam = cameraFor(preset);
      const a = viewOf(cam, A);
      const b = viewOf(cam, B);
      expect([a.x, a.y, a.z]).toEqual(table[preset].a.map((v) => expect.closeTo(v, 6)));
      expect([b.x, b.y, b.z]).toEqual(table[preset].b.map((v) => expect.closeTo(v, 6)));
    });
  }

  it("the left preset puts +x away from the viewer and the right preset toward it", () => {
    const origin = [0, 0, 0] as const;
    const left = cameraFor("left");
    const right = cameraFor("right");
    expect(viewOf(left, B).z).toBeLessThan(viewOf(left, origin).z);
    expect(viewOf(right, B).z).toBeGreaterThan(viewOf(right, origin).z);
  });

  it("every preset looks at the target: the target sits at the screen center", () => {
    for (const preset of Object.keys(table) as ViewPreset[]) {
      const cam = cameraFor(preset);
      cam.target = [3, -7, 11];
      const v = viewOf(cam, [3, -7, 11]);
      expect(v.x).toBeCloseTo(0, 6);
      expect(v.y).toBeCloseTo(0, 6);
      expect(v.z).toBeCloseTo(-400, 6);
    }
  });
});

describe("orbit and zoom", () => {
  it("dragging right carries the near surface to the right on screen", () => {
    const cam = cameraFor("right");
    const near = [50, 0, 0] as const;
    const before = project(cam, near, 800, 600);
    orbitBy(cam, 100, 0);
    const after = project(cam, near, 800, 600);
    expect(before[0]).toBeCloseTo(400, 6);
    expect(after[0]).toBeGreaterThan(before[0] + 1);
  });

  it("dragging down carries the top surface down on screen", () => {
    const cam = cameraFor("right");
    const top = [0, 0, 50] as const;
    const before = project(cam, top, 800, 600);
    orbitBy(cam, 0, 100);
    const after = project(cam, top, 800, 600);
    expect(after[1]).toBeGreaterThan(before[1] + 1);
  });

  it("pitch stops at the poles however far the drag goes", () => {
    const cam = cameraFor("right");
    orbitBy(cam, 0, 1e6);
    expect(cam.pitch).toBeCloseTo(Math.PI / 2, 9);
    orbitBy(cam, 0, -1e6);
    expect(cam.pitch).toBeCloseTo(-Math.PI / 2, 9);
  });

  it("zoom scales the distance and stops at the bounds set by the fit", () => {
    const cam = createCamera();
    fitCamera(cam, [0, 0, 0], 90, 4 / 3);
    const fitted = cam.distance;
    zoomBy(cam, 0.5);
    expect(cam.distance).toBeCloseTo(fitted * 0.5, 9);
    zoomBy(cam, 1e-9);
    expect(cam.distance).toBeCloseTo(cam.minDistance, 9);
    expect(cam.minDistance).toBeLessThan(fitted);
    zoomBy(cam, 1e9);
    expect(cam.distance).toBeCloseTo(cam.maxDistance, 9);
    expect(cam.maxDistance).toBeGreaterThan(fitted);
  });
});

describe("projection and rays", () => {
  const W = 800;
  const H = 600;

  it("the target projects to the middle of the canvas", () => {
    const cam = cameraFor("left");
    cam.target = [10, 20, 30];
    const [x, y, depth] = project(cam, [10, 20, 30], W, H);
    expect(x).toBeCloseTo(W / 2, 6);
    expect(y).toBeCloseTo(H / 2, 6);
    expect(depth).toBeCloseTo(400, 6);
  });

  it("a ray through a point's projected pixel passes through that point", () => {
    const cam = cameraFor("front");
    orbitBy(cam, 60, -25);
    for (const p of [
      [10, -30, 45],
      [-55, 20, -5],
      [0, 0, 100],
    ] as const) {
      const [x, y] = project(cam, p, W, H);
      const ray = screenRay(cam, x, y, W, H);
      const t =
        (p[0] - ray.origin[0]) * ray.dir[0] +
        (p[1] - ray.origin[1]) * ray.dir[1] +
        (p[2] - ray.origin[2]) * ray.dir[2];
      expect(t).toBeGreaterThan(0);
      for (let k = 0; k < 3; k++) {
        expect(ray.origin[k] + t * ray.dir[k]).toBeCloseTo(p[k], 4);
      }
    }
  });

  it("the matrices that draw agree with the projection that picks", () => {
    const cam = cameraFor("front");
    orbitBy(cam, 45, -20);
    const [near, far] = nearFar(cam, 90);
    const vp = multiply(projectionMatrix(cam, W / H, near, far), viewMatrix(cam));
    for (const p of [
      [10, -30, 45],
      [-55, 20, -5],
      [0, 0, 0],
    ] as const) {
      const [ndcX, ndcY] = transformPoint(vp, p);
      const [x, y] = project(cam, p, W, H);
      expect(((ndcX + 1) * W) / 2).toBeCloseTo(x, 6);
      expect(((1 - ndcY) * H) / 2).toBeCloseTo(y, 6);
    }
  });

  it("mmPerPixel is the world distance one pixel spans at a depth", () => {
    const cam = cameraFor("right");
    const mm = mmPerPixel(cam, 400, H);
    // The right preset's screen-right axis is +y.
    const [x0, y0] = project(cam, [0, 0, 0], W, H);
    const [x1, y1] = project(cam, [0, 7 * mm, 0], W, H);
    expect(x1 - x0).toBeCloseTo(7, 6);
    expect(y1 - y0).toBeCloseTo(0, 6);
  });

  it("the projection matrix maps the near plane to -1 and the far plane to +1", () => {
    const cam = cameraFor("right");
    const [near, far] = [10, 900];
    const m = projectionMatrix(cam, W / H, near, far);
    const clip = (depth: number) => {
      const v = [0, 0, -depth, 1];
      const out = [0, 0, 0, 0];
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[r] += m[c * 4 + r] * v[c];
      return out[2] / out[3];
    };
    expect(clip(near)).toBeCloseTo(-1, 6);
    expect(clip(far)).toBeCloseTo(1, 6);
  });

  it("nearFar keeps the target between the planes even when zoomed far in", () => {
    const cam = cameraFor("right");
    cam.distance = 5;
    const [near, far] = nearFar(cam, 90);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(cam.distance);
    expect(far).toBeGreaterThan(cam.distance + 90);
  });
});

describe("fitCamera", () => {
  it("keeps the whole bounding sphere on screen for landscape and portrait canvases", () => {
    for (const [w, h] of [
      [800, 600],
      [300, 600],
    ]) {
      const cam = createCamera();
      const center = [5, -10, 20] as const;
      const radius = 90;
      fitCamera(cam, center, radius, w / h);
      setPreset(cam, "front");
      for (const d of [
        [radius, 0, 0],
        [-radius, 0, 0],
        [0, 0, radius],
        [0, 0, -radius],
      ]) {
        const [x, y] = project(cam, [center[0] + d[0], center[1] + d[1], center[2] + d[2]], w, h);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(w);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(h);
      }
    }
  });
});

describe("rescaleForAspect", () => {
  const center = [5, -10, 20] as const;
  const radius = 90;
  const onScreen = (cam: Camera, w: number, h: number) => {
    setPreset(cam, "front");
    return [
      [radius, 0, 0],
      [-radius, 0, 0],
      [0, 0, radius],
      [0, 0, -radius],
    ].every((d) => {
      const [x, y] = project(cam, [center[0] + d[0], center[1] + d[1], center[2] + d[2]], w, h);
      return x >= 0 && x <= w && y >= 0 && y <= h;
    });
  };

  it("keeps the sphere on screen when a landscape fit meets a portrait canvas", () => {
    // The data arrived while the canvas was square (or 0 x 0, which counts as aspect 1).
    const cam = createCamera();
    fitCamera(cam, center, radius, 1);
    expect(onScreen(cam, 300, 600)).toBe(false); // clipped before the rescale: the bug
    rescaleForAspect(cam, 1, 300 / 600);
    expect(onScreen(cam, 300, 600)).toBe(true);
  });

  it("keeps the user's zoom and the zoom bounds in proportion", () => {
    const cam = createCamera();
    fitCamera(cam, center, radius, 4 / 3);
    const fitted = cam.distance;
    zoomBy(cam, 0.5);
    const [min, max] = [cam.minDistance, cam.maxDistance];
    rescaleForAspect(cam, 4 / 3, 1 / 2);
    const k = cam.maxDistance / max;
    expect(k).toBeGreaterThan(1);
    expect(cam.distance).toBeCloseTo(fitted * 0.5 * k, 9);
    expect(cam.minDistance).toBeCloseTo(min * k, 9);
    expect(cam.distance / cam.maxDistance).toBeCloseTo((fitted * 0.5) / max, 9);
  });

  it("does nothing while the canvas stays at least as wide as it is tall", () => {
    const cam = createCamera();
    fitCamera(cam, center, radius, 1);
    const before = [cam.distance, cam.minDistance, cam.maxDistance];
    rescaleForAspect(cam, 1, 2.5);
    expect([cam.distance, cam.minDistance, cam.maxDistance]).toEqual(before);
  });

  it("is undone by the opposite change, and agrees with a fresh fit", () => {
    const cam = createCamera();
    fitCamera(cam, center, radius, 4 / 3);
    const fitted = cam.distance;
    rescaleForAspect(cam, 4 / 3, 1 / 3);
    const fresh = createCamera();
    fitCamera(fresh, center, radius, 1 / 3);
    expect(cam.distance).toBeCloseTo(fresh.distance, 9);
    rescaleForAspect(cam, 1 / 3, 4 / 3);
    expect(cam.distance).toBeCloseTo(fitted, 9);
  });
});
