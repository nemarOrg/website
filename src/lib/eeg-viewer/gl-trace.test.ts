import { describe, expect, it } from "vitest";
import { buildTraceVertices, hexToRgb } from "./gl-trace";
import type { RenderOptions, ViewerFrame } from "./render";

const OPTS: RenderOptions = {
  width: 800,
  height: 300,
  gutter: 72,
  axisHeight: 22,
  gain: 1,
  clip: 1.5,
  background: "#ffffff",
  foreground: "#000000",
  grid: "#cccccc",
  butterfly: false,
};

// Derived plot geometry for the OPTS above (mirrors render.ts):
//   plotLeft=72, plotTop=4, plotWidth=800-72-8=720, plotHeight=300-22-4=274
//   one channel: slot baseline=141, halfHeight=137; pxPerPhys=137/physPerDiv
const PLOT_LEFT = 72;
const PLOT_RIGHT = 792; // 72 + 720
const BASELINE_1CH = 141;

function frame(channels: ViewerFrame["channels"], nCols: number): ViewerFrame {
  return {
    channels,
    nCols,
    windowStartS: 0,
    windowEndS: 10,
    events: [],
    physPerDiv: 100,
    unitBase: "V",
  };
}

describe("hexToRgb", () => {
  it("parses #rrggbb to 0-1 RGB", () => {
    expect(hexToRgb("#ff0000")).toEqual([1, 0, 0]);
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    const [r, g, b] = hexToRgb("#0072B2");
    expect(r).toBeCloseTo(0, 2);
    expect(g).toBeCloseTo(0x72 / 255, 4);
    expect(b).toBeCloseTo(0xb2 / 255, 4);
  });
  it("falls back to mid-grey on a bad string", () => {
    expect(hexToRgb("nope")).toEqual([0.5, 0.5, 0.5]);
    expect(hexToRgb("#fff")).toEqual([0.5, 0.5, 0.5]);
  });
});

describe("buildTraceVertices", () => {
  it("maps a line channel to baseline-relative pixels with edge x", () => {
    const line = new Float32Array([0, 100, -100]); // 0, +physPerDiv, -physPerDiv
    const { verts, runs } = buildTraceVertices(
      frame([{ label: "Cz", color: "#ff0000", kind: "line", line }], 3),
      OPTS,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ offset: 0, count: 3, alpha: 1 });
    expect(runs[0].color).toEqual([1, 0, 0]);
    // x: first at plotLeft, last at plotRight, middle halfway
    expect(verts[0]).toBeCloseTo(PLOT_LEFT, 5);
    expect(verts[2]).toBeCloseTo((PLOT_LEFT + PLOT_RIGHT) / 2, 5);
    expect(verts[4]).toBeCloseTo(PLOT_RIGHT, 5);
    // y: value 0 -> baseline; +physPerDiv -> baseline-halfHeight; -physPerDiv -> +halfHeight
    expect(verts[1]).toBeCloseTo(BASELINE_1CH, 5);
    expect(verts[3]).toBeCloseTo(BASELINE_1CH - 137, 5);
    expect(verts[5]).toBeCloseTo(BASELINE_1CH + 137, 5);
  });

  it("clamps a hot sample to the clip envelope (baseline +/- clip*halfHeight)", () => {
    const line = new Float32Array([1000]); // 10*physPerDiv, way past the slot
    const { verts } = buildTraceVertices(
      frame([{ label: "x", color: "#000000", kind: "line", line }], 1),
      OPTS,
    );
    // clipPx = 137 * 1.5 = 205.5 -> lo = 141 - 205.5
    expect(verts[1]).toBeCloseTo(BASELINE_1CH - 205.5, 4);
  });

  it("emits a max/min zigzag for a band channel (2 verts per column)", () => {
    const max = new Float32Array([100, 100]);
    const min = new Float32Array([-100, -100]);
    const { verts, runs } = buildTraceVertices(
      frame([{ label: "b", color: "#00ff00", kind: "band", min, max }], 2),
      OPTS,
    );
    expect(runs[0].count).toBe(4); // 2 columns * (max,min)
    // col0: (plotLeft, baseline-137) then (plotLeft, baseline+137)
    expect(verts[0]).toBeCloseTo(PLOT_LEFT, 5);
    expect(verts[1]).toBeCloseTo(BASELINE_1CH - 137, 5);
    expect(verts[2]).toBeCloseTo(PLOT_LEFT, 5);
    expect(verts[3]).toBeCloseTo(BASELINE_1CH + 137, 5);
  });

  it("dim channels carry a reduced alpha (0.3 stacked, 0.15 butterfly)", () => {
    const line = new Float32Array([0, 0]);
    const stacked = buildTraceVertices(
      frame([{ label: "d", color: "#111111", kind: "line", line, dim: true }], 2),
      OPTS,
    );
    expect(stacked.runs[0].alpha).toBeCloseTo(0.3, 5);
    const bf = buildTraceVertices(
      frame([{ label: "d", color: "#111111", kind: "line", line, dim: true }], 2),
      { ...OPTS, butterfly: true },
    );
    expect(bf.runs[0].alpha).toBeCloseTo(0.15, 5);
  });

  it("butterfly overlays every channel on the same full-height baseline", () => {
    const a = new Float32Array([0]);
    const b = new Float32Array([0]);
    const { verts, runs } = buildTraceVertices(
      frame(
        [
          { label: "a", color: "#ff0000", kind: "line", line: a },
          { label: "b", color: "#00ff00", kind: "line", line: b },
        ],
        1,
      ),
      { ...OPTS, butterfly: true },
    );
    expect(runs).toHaveLength(2);
    expect(runs[0].alpha).toBeCloseTo(0.75, 5); // non-dim butterfly
    // Both channels' value-0 sample sits on the shared center baseline (141).
    expect(verts[runs[0].offset * 2 + 1]).toBeCloseTo(BASELINE_1CH, 5);
    expect(verts[runs[1].offset * 2 + 1]).toBeCloseTo(BASELINE_1CH, 5);
  });

  it("returns empty geometry for a frame with no channels", () => {
    const { verts, runs } = buildTraceVertices(frame([], 0), OPTS);
    expect(runs).toHaveLength(0);
    expect(verts).toHaveLength(0);
  });
});
