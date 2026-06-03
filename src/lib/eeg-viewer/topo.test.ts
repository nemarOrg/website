import { describe, expect, it } from "vitest";
import { ELECTRODE_RAD, type Vec3, alsToRas, evalTPS, fitSphere, projectPositions, projectUnit, solveTPS, viridisColor } from "./topo";

describe("alsToRas", () => {
  it("rotates EEGLAB ALS into RAS+ ((x,y,z) -> (-y,x,z))", () => {
    expect(alsToRas("EEGLAB", [1, 2, 3])).toEqual([-2, 1, 3]);
  });
  it("passes through non-ALS systems unchanged", () => {
    expect(alsToRas("RAS", [1, 2, 3])).toEqual([1, 2, 3]);
    expect(alsToRas("", [1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("fitSphere", () => {
  const card: Vec3[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  it("recovers an origin-centered unit sphere", () => {
    const { center, radius } = fitSphere(card.map(([x, y, z]) => [x * 85, y * 85, z * 85]));
    expect(center[0]).toBeCloseTo(0, 2);
    expect(center[1]).toBeCloseTo(0, 2);
    expect(center[2]).toBeCloseTo(0, 2);
    expect(radius).toBeCloseTo(85, 2);
  });
  it("recovers an offset sphere center", () => {
    const o = [10, -5, 20];
    const { center, radius } = fitSphere(card.map(([x, y, z]) => [x * 50 + o[0], y * 50 + o[1], z * 50 + o[2]]));
    expect(center[0]).toBeCloseTo(10, 1);
    expect(center[1]).toBeCloseTo(-5, 1);
    expect(center[2]).toBeCloseTo(20, 1);
    expect(radius).toBeCloseTo(50, 1);
  });
});

describe("projectUnit", () => {
  it("places the vertex (+uz) at the disc center", () => {
    const [x, y] = projectUnit(0, 0, 1);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
  });
  it("places nasion (+uy) at the top and +ux to the right", () => {
    const front = projectUnit(0, 1, 0);
    expect(front[0]).toBeCloseTo(0, 6);
    expect(front[1]).toBeCloseTo(-1, 6); // top = negative y
    const right = projectUnit(1, 0, 0);
    expect(right[0]).toBeCloseTo(1, 6);
    expect(right[1]).toBeCloseTo(0, 6);
  });
});

describe("projectPositions (EEGLAB cardinal electrodes)", () => {
  // Synthetic EEGLAB ALS coords (mm): +X anterior, +Y left, +Z up.
  const R = 85;
  const pos: Record<string, Vec3> = {
    Cz: [0, 0, R],
    Fpz: [R, 0, 0],
    Oz: [-R, 0, 0],
    T7: [0, R, 0],
    T8: [0, -R, 0],
  };
  const m = projectPositions(pos, "EEGLAB");
  const near = (label: string, ex: number, ey: number) => {
    const p = m.get(label);
    expect(p?.[0]).toBeCloseTo(ex, 2);
    expect(p?.[1]).toBeCloseTo(ey, 2);
  };
  it("maps vertex/nose/inion/ears to the disc, outer electrodes scaled to ELECTRODE_RAD", () => {
    near("Cz", 0, 0);
    near("Fpz", 0, -ELECTRODE_RAD); // anterior -> top, just inside the rim
    near("Oz", 0, ELECTRODE_RAD); // posterior -> bottom
    near("T7", -ELECTRODE_RAD, 0); // left -> left
    near("T8", ELECTRODE_RAD, 0); // right -> right
  });
});

describe("thin-plate spline", () => {
  it("reproduces the sample values at the electrode sites", () => {
    const px = [-1, 1, 0, 0];
    const py = [0, 0, -1, 1];
    const vals = [3, -2, 5, 1];
    const m = solveTPS(px, py, vals);
    expect(m).not.toBeNull();
    for (let i = 0; i < px.length; i++) {
      expect(evalTPS(m as NonNullable<typeof m>, px[i], py[i])).toBeCloseTo(vals[i], 2);
    }
  });
  it("returns null with fewer than 3 sites", () => {
    expect(solveTPS([0, 1], [0, 0], [1, 2])).toBeNull();
  });
});

describe("viridisColor", () => {
  it("maps -1 to dark purple and +1 to yellow", () => {
    expect(viridisColor(-1)).toEqual([68, 1, 84]);
    expect(viridisColor(1)).toEqual([253, 231, 37]);
  });
  it("maps 0 to the green/teal middle (green dominant)", () => {
    const c = viridisColor(0);
    expect(c[1]).toBeGreaterThan(c[0]);
    expect(c[1]).toBeGreaterThan(c[2]);
  });
  it("clamps values outside [-1,1]", () => {
    expect(viridisColor(-5)).toEqual([68, 1, 84]);
    expect(viridisColor(5)).toEqual([253, 231, 37]);
  });
});
