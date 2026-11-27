import { describe, expect, it } from "vitest";
import { type ViewerFrame, niceTimeStep, shadedRects, traceLayout } from "./render";

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

describe("shadedRects (the floor's bad segments, website W6)", () => {
  const frame = (shaded: ViewerFrame["shaded"]): ViewerFrame => ({
    channels: [],
    nCols: 100,
    windowStartS: 10,
    windowEndS: 20,
    events: [],
    physPerDiv: 1,
    unitBase: "V",
    shaded,
  });
  it("places each span in the window on the plot, clipped to it", () => {
    const rects = shadedRects(
      frame([
        { startS: 12, endS: 14, label: "bad_window" },
        { startS: 5, endS: 11, label: "edge" },
        { startS: 19, endS: 30, label: "late" },
      ]),
      0,
      100,
    );
    expect(rects.map((r) => r.label)).toEqual(["bad_window", "edge", "late"]);
    expect(rects[0].x).toBeCloseTo(20);
    expect(rects[0].width).toBeCloseTo(20);
    expect(rects[1].x).toBe(0);
    expect(rects[2].x + rects[2].width).toBe(100);
  });
  it("leaves out spans outside the window, and never draws a span narrower than a pixel", () => {
    const rects = shadedRects(
      frame([
        { startS: 0, endS: 10, label: "before" },
        { startS: 20, endS: 25, label: "after" },
        { startS: 15, endS: 15.0001, label: "burst" },
      ]),
      0,
      100,
    );
    expect(rects.map((r) => r.label)).toEqual(["burst"]);
    expect(rects[0].width).toBeGreaterThanOrEqual(1);
  });
  it("shades nothing without spans", () => {
    expect(shadedRects(frame(undefined), 0, 100)).toEqual([]);
  });
});
