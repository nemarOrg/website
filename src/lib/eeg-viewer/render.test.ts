import { describe, expect, it } from "vitest";
import { niceTimeStep, traceLayout } from "./render";

describe("traceLayout", () => {
  it("stacks N evenly spaced slots with centered baselines", () => {
    const slots = traceLayout(4, 0, 400);
    expect(slots).toHaveLength(4);
    expect(slots[0].halfHeight).toBe(50);
    expect(slots[0].baseline).toBe(50);
    expect(slots[1].baseline).toBe(150);
    expect(slots[3].baseline).toBe(350);
  });
  it("offsets by plotTop", () => {
    const slots = traceLayout(2, 10, 200);
    expect(slots[0].baseline).toBe(60);
    expect(slots[1].baseline).toBe(160);
  });
  it("returns empty for no channels", () => {
    expect(traceLayout(0, 0, 100)).toEqual([]);
  });
});

describe("niceTimeStep", () => {
  it("returns 1/2/5 x 10^n aiming for ~6 ticks", () => {
    expect(niceTimeStep(10)).toBe(1); // 10/6 ~ 1.67 -> 1
    expect(niceTimeStep(30)).toBe(5); // 30/6 = 5
    expect(niceTimeStep(60)).toBe(10);
    expect(niceTimeStep(2)).toBeCloseTo(0.2, 6); // 2/6 ~ 0.33 -> 0.2
  });
  it("guards non-positive spans", () => {
    expect(niceTimeStep(0)).toBe(1);
  });
});
