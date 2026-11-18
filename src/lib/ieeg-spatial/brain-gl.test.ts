import { describe, expect, it } from "vitest";
import {
  MAX_CONTACTS,
  MIN_PICK_PX,
  contactRadius,
  packContacts,
  parseColor,
  pickNearest,
  translucentOrder,
} from "./brain-gl";
import {
  type Camera,
  type Vec3,
  createCamera,
  fitCamera,
  mmPerPixel,
  project,
  setPreset,
  viewMatrix,
} from "./camera";
import { icosphere } from "./mesh-format";

const W = 800;
const H = 600;

function view(preset?: Parameters<typeof setPreset>[1]): Camera {
  const cam = createCamera();
  fitCamera(cam, [0, 0, 0], 70, W / H);
  cam.distance = 400;
  if (preset) setPreset(cam, preset);
  return cam;
}

const contactsAt = (points: ArrayLike<number>, size?: number | null) => {
  const out = [];
  for (let i = 0; i < points.length; i += 3) {
    out.push({ position: [points[i], points[i + 1], points[i + 2]] as const, size });
  }
  return out;
};

describe("contactRadius", () => {
  it("is the radius of a disc with the BIDS size (square millimeters), clamped to 0.5-3 mm", () => {
    expect(contactRadius(4 * Math.PI)).toBeCloseTo(2, 9);
    expect(contactRadius(0.01)).toBe(0.5);
    expect(contactRadius(1000)).toBe(3);
  });

  it("is 1.5 mm when the size is n/a, missing or not a positive number", () => {
    for (const size of [null, undefined, Number.NaN, 0, -2]) expect(contactRadius(size)).toBe(1.5);
  });
});

describe("packContacts", () => {
  it("packs x, y, z and the radius of each contact", () => {
    const packed = packContacts([
      { position: [1, 2, 3], size: 4 * Math.PI },
      { position: [-4, 5, -6] },
    ]);
    expect([...packed]).toEqual([1, 2, 3, 2, -4, 5, -6, 1.5]);
  });

  it("accepts 2,000 contacts and refuses 2,001", () => {
    const make = (n: number) => Array.from({ length: n }, () => ({ position: [0, 0, 0] as const }));
    expect(packContacts(make(MAX_CONTACTS)).length).toBe(MAX_CONTACTS * 4);
    expect(() => packContacts(make(MAX_CONTACTS + 1))).toThrow(RangeError);
  });

  it("refuses a contact without a finite position, null included", () => {
    expect(() => packContacts([{ position: [0, Number.NaN, 0] }])).toThrow(RangeError);
    expect(() => packContacts([{ position: [0, Number.NaN, 0] }])).toThrow(/finite/);
    // Unlocated contacts (a null position upstream) are the caller's to filter out.
    const unlocated = { position: null as unknown as Vec3 };
    expect(() => packContacts([unlocated])).toThrow(RangeError);
    expect(() => packContacts([unlocated])).toThrow(/contact 0 has no finite position/);
  });
});

describe("parseColor", () => {
  it("reads hex and rgb() the way a token value or a computed style spells them", () => {
    expect(parseColor("#ff8000")).toEqual([1, expect.closeTo(128 / 255, 9), 0]);
    expect(parseColor("#0f0")).toEqual([0, 1, 0]);
    expect(parseColor("rgb(255, 0, 51)")).toEqual([1, 0, expect.closeTo(0.2, 9)]);
    expect(parseColor("rgba(0 0 255 / 0.5)")).toEqual([0, 0, 1]);
  });

  it("falls back to mid-gray for a value it cannot read", () => {
    expect(parseColor("color-mix(in srgb, red, blue)")).toEqual([0.5, 0.5, 0.5]);
  });
});

describe("pickNearest", () => {
  it("returns the contact whose projected center is under the pixel, for 20 real positions", () => {
    // The first 20 vertices of a 70 mm icosphere stand in for electrode positions (the real
    // fixture of card IS-C1 is not on this branch yet).
    const sphere = icosphere(1, 70);
    const points = sphere.positions.slice(0, 60);
    const contacts = contactsAt(points);
    const spheres = packContacts(contacts);
    const cam = view();
    cam.yaw = 4.3;
    cam.pitch = -0.1;

    // The view must separate every pair by more than the pick slop, or the test says nothing.
    const px = contacts.map((c) => project(cam, c.position, W, H));
    for (let i = 0; i < px.length; i++) {
      for (let j = i + 1; j < px.length; j++) {
        expect(Math.hypot(px[i][0] - px[j][0], px[i][1] - px[j][1])).toBeGreaterThan(12);
      }
    }
    for (let i = 0; i < contacts.length; i++) {
      expect(pickNearest(cam, px[i][0], px[i][1], W, H, spheres)).toBe(i);
    }
  });

  it("returns the nearer contact when two sit on the same ray, whatever their order", () => {
    const cam = view("right"); // eye on +x
    const [cx, cy] = project(cam, [0, 0, 0], W, H);
    const farFirst = packContacts(contactsAt([-50, 0, 0, 50, 0, 0]));
    const nearFirst = packContacts(contactsAt([50, 0, 0, -50, 0, 0]));
    expect(pickNearest(cam, cx, cy, W, H, farFirst)).toBe(1);
    expect(pickNearest(cam, cx, cy, W, H, nearFirst)).toBe(0);
  });

  it("between two overlapping contacts at one depth, returns the one nearer the ray", () => {
    const cam = view("front"); // screen right is -x
    const spheres = packContacts(contactsAt([-1.5, 0, 0, 1.5, 0, 0], 4 * Math.PI * 2.25)); // r = 3
    const toward = (x: number) => project(cam, [x, 0, 0], W, H);
    expect(pickNearest(cam, toward(0.4)[0], toward(0.4)[1], W, H, spheres)).toBe(1);
    expect(pickNearest(cam, toward(-0.4)[0], toward(-0.4)[1], W, H, spheres)).toBe(0);
  });

  it("gives a contact smaller than a few pixels a pick area of MIN_PICK_PX", () => {
    const cam = view("right");
    const spheres = packContacts(contactsAt([0, 0, 0], 0.01)); // 0.5 mm radius, about 1.4 px
    const [cx, cy] = project(cam, [0, 0, 0], W, H);
    expect(MIN_PICK_PX).toBe(4);
    expect(pickNearest(cam, cx + 3, cy, W, H, spheres)).toBe(0);
    expect(pickNearest(cam, cx + 5, cy, W, H, spheres)).toBeNull();
  });

  it("hits a contact bigger than the floor exactly to its edge", () => {
    const cam = view("right");
    const spheres = packContacts(contactsAt([0, 0, 0], 100)); // clamped to 3 mm, about 8.4 px
    const [cx, cy] = project(cam, [0, 0, 0], W, H);
    expect(pickNearest(cam, cx + 7, cy, W, H, spheres)).toBe(0);
    expect(pickNearest(cam, cx + 10, cy, W, H, spheres)).toBeNull();
  });

  it("skips a contact whose alpha is zero and takes the one behind it", () => {
    const cam = view("right");
    const [cx, cy] = project(cam, [0, 0, 0], W, H);
    const spheres = packContacts(contactsAt([50, 0, 0, -50, 0, 0]));
    const colors = new Uint8Array([255, 0, 0, 0, 0, 255, 0, 255]);
    expect(pickNearest(cam, cx, cy, W, H, spheres, colors)).toBe(1);
  });

  it("does not pick a contact behind the eye, and misses empty space", () => {
    const cam = view("right"); // the eye is at x = 400
    const [cx, cy] = project(cam, [0, 0, 0], W, H);
    const behind = packContacts(contactsAt([1000, 0, 0]));
    expect(pickNearest(cam, cx, cy, W, H, behind)).toBeNull();
    const ahead = packContacts(contactsAt([0, 0, 0]));
    expect(pickNearest(cam, 5, 5, W, H, ahead)).toBeNull();
  });

  it("prefers a contact under the pointer over a nearer one that only the pick floor reaches", () => {
    const cam = view("right"); // eye on +x; screen right is +y
    const [cx, cy] = project(cam, [0, 0, 0], W, H);
    const nearMm = mmPerPixel(cam, 350, H);
    // Far contact dead center; near tiny contact 3 px to the side (floor-only, exact radius 1.4 px).
    const spheres = packContacts([
      { position: [50, 3 * nearMm, 0], size: 0.01 },
      { position: [-50, 0, 0] },
    ]);
    expect(pickNearest(cam, cx, cy, W, H, spheres)).toBe(1);
  });

  it("among floor-only hits, takes the one whose center is closest to the pointer, in any order", () => {
    const cam = view("right");
    const [cx, cy] = project(cam, [0, 0, 0], W, H);
    const nearMm = mmPerPixel(cam, 350, H);
    const farMm = mmPerPixel(cam, 450, H);
    const closer = { position: [-50, 2 * farMm, 0] as const, size: 0.01 }; // farther in depth, 2 px away (its disc is 1.2 px)
    const nearer = { position: [50, 3 * nearMm, 0] as const, size: 0.01 }; // nearer in depth, 3 px away
    // Closest first and closest last, so neither "first floor hit wins" nor "last wins" passes.
    expect(pickNearest(cam, cx, cy, W, H, packContacts([closer, nearer]))).toBe(0);
    expect(pickNearest(cam, cx, cy, W, H, packContacts([nearer, closer]))).toBe(1);
  });

  it("takes a larger pick floor for coarse pointers", () => {
    const cam = view("right");
    const spheres = packContacts(contactsAt([0, 0, 0], 0.01));
    const [cx, cy] = project(cam, [0, 0, 0], W, H);
    expect(pickNearest(cam, cx + 9, cy, W, H, spheres)).toBeNull();
    expect(pickNearest(cam, cx + 9, cy, W, H, spheres, undefined, 12)).toBe(0);
  });
});

describe("translucentOrder", () => {
  it("lists only contacts with 0 < alpha < 1, farthest first, so blending composes back to front", () => {
    const cam = view("right"); // eye on +x, so larger x is nearer
    const spheres = packContacts(contactsAt([0, 0, 0, 50, 0, 0, -50, 0, 0, 20, 0, 0, -20, 0, 0]));
    const colors = new Uint8Array([
      0,
      0,
      0,
      128, // translucent, depth 400
      0,
      0,
      0,
      128, // translucent, nearest
      0,
      0,
      0,
      128, // translucent, farthest
      0,
      0,
      0,
      255, // opaque: not in the second pass
      0,
      0,
      0,
      0, // hidden: not drawn at all
    ]);
    expect(translucentOrder(spheres, colors, viewMatrix(cam))).toEqual([2, 0, 1]);
  });

  it("is empty when every contact is opaque", () => {
    const cam = view("right");
    const spheres = packContacts(contactsAt([0, 0, 0, 10, 0, 0]));
    const colors = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(translucentOrder(spheres, colors, viewMatrix(cam))).toEqual([]);
  });
});
