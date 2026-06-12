import { describe, expect, it } from "vitest";
import { aggregateOverview, parseChannels } from "./store";

describe("parseChannels", () => {
  it("falls back scale to 1 when scale is null", () => {
    const [ch] = parseChannels([{ label: "Fz", unit: "uV", scale: null }]);
    expect(ch.scale).toBe(1);
  });

  it("falls back scale to 1 when scale is a string (e.g. '0.5e-6')", () => {
    const [ch] = parseChannels([{ label: "Fz", unit: "uV", scale: "0.5e-6" }]);
    expect(ch.scale).toBe(1);
  });

  it("uses scale when it is a finite number", () => {
    const [ch] = parseChannels([{ label: "Fz", unit: "uV", scale: 0.5e-6 }]);
    expect(ch.scale).toBeCloseTo(0.5e-6, 15);
  });

  it("defaults unit to 'uV' and siFactor to 1e-6 when unit is missing", () => {
    const [ch] = parseChannels([{ label: "Cz" }]);
    expect(ch.unit).toBe("uV");
    expect(ch.siFactor).toBeCloseTo(1e-6, 12);
  });

  it("preserves row_index: 0 as 0 (not a falsy fallback)", () => {
    const [ch] = parseChannels([{ label: "Fp1", row_index: 0 }]);
    expect(ch.rowIndex).toBe(0);
  });

  it("usable_for_inference: false -> false", () => {
    const [ch] = parseChannels([{ label: "x", usable_for_inference: false }]);
    expect(ch.usableForInference).toBe(false);
  });

  it("usable_for_inference: missing -> true", () => {
    const [ch] = parseChannels([{ label: "x" }]);
    expect(ch.usableForInference).toBe(true);
  });

  it("usable_for_inference: 0 -> true (only explicit false disables)", () => {
    const [ch] = parseChannels([{ label: "x", usable_for_inference: 0 }]);
    expect(ch.usableForInference).toBe(true);
  });

  it('usable_for_inference: "false" (string) -> true', () => {
    const [ch] = parseChannels([{ label: "x", usable_for_inference: "false" }]);
    expect(ch.usableForInference).toBe(true);
  });

  it("defaults channel_type to 'OTHER'", () => {
    const [ch] = parseChannels([{ label: "x" }]);
    expect(ch.channelType).toBe("OTHER");
  });

  it("defaults modality to 'MISC'", () => {
    const [ch] = parseChannels([{ label: "x" }]);
    expect(ch.modality).toBe("MISC");
  });

  it("defaults label to ch<index>", () => {
    const [ch] = parseChannels([{}]);
    expect(ch.label).toBe("ch0");
  });

  it("returns empty array for non-array input", () => {
    expect(parseChannels(null)).toHaveLength(0);
    expect(parseChannels("bad")).toHaveLength(0);
    expect(parseChannels({})).toHaveLength(0);
  });
});

describe("aggregateOverview", () => {
  const identity = { scale: 1, offset: 0, siFactor: 1 };

  it("returns max |max-min| across channels for each column", () => {
    // 2 channels, 2 time columns: layout [2, nCh=2, nTime=2]
    // data[row=0,ch=0,t=0]=10, [row=0,ch=0,t=1]=20 (min row)
    // data[row=1,ch=0,t=0]=30, [row=1,ch=0,t=1]=40 (max row)
    // data[row=0,ch=1,t=0]=0,  [row=0,ch=1,t=1]=5
    // data[row=1,ch=1,t=0]=5,  [row=1,ch=1,t=1]=5
    // ch0 range t=0: |30-10|=20, t=1: |40-20|=20
    // ch1 range t=0: |5-0|=5,   t=1: |5-5|=0
    // max per col: [20, 20]
    const nCh = 2;
    const nTime = 2;
    // flat index: (row * nCh + ch) * nTime + t
    const data = new Int16Array([
      10,
      20, // row=0, ch=0
      0,
      5, // row=0, ch=1
      30,
      40, // row=1, ch=0
      5,
      5, // row=1, ch=1
    ]);
    const out = aggregateOverview(data, nCh, nTime, [identity, identity]);
    expect(out[0]).toBeCloseTo(20, 6);
    expect(out[1]).toBeCloseTo(20, 6);
  });

  it("applies scale and siFactor correctly", () => {
    // 1 channel, 1 time col: min=0, max=100, scale=0.5e-6, offset=0, siFactor=1
    const data = new Int16Array([0, 100]); // [min-row, max-row]
    const ch = { scale: 0.5e-6, offset: 0, siFactor: 1 };
    const out = aggregateOverview(data, 1, 1, [ch]);
    expect(out[0]).toBeCloseTo(50e-6, 9);
  });

  it("applies a non-unity siFactor (uV stored -> SI volts out)", () => {
    // 100 uV stored raw (scale=1) must come out as 100e-6 V via siFactor=1e-6.
    const data = new Int16Array([0, 100]);
    const ch = { scale: 1, offset: 0, siFactor: 1e-6 };
    const out = aggregateOverview(data, 1, 1, [ch]);
    expect(out[0]).toBeCloseTo(100e-6, 9);
  });

  it("cancels a non-zero offset in the min/max range", () => {
    // offset must apply to both rows so it cancels: (100+1000)-(0+1000) = 100.
    const data = new Int16Array([0, 100]);
    const ch = { scale: 1, offset: 1000, siFactor: 1 };
    const out = aggregateOverview(data, 1, 1, [ch]);
    expect(out[0]).toBeCloseTo(100, 6);
  });

  it("returns zeros when min equals max (flat signal)", () => {
    const data = new Int16Array([5, 5]); // min=max
    const out = aggregateOverview(data, 1, 1, [identity]);
    expect(out[0]).toBe(0);
  });

  it("returns empty array when nTime=0", () => {
    const out = aggregateOverview(new Int16Array([]), 0, 0, []);
    expect(out).toHaveLength(0);
  });
});
