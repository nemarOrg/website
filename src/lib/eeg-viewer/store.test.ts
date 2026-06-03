import { describe, expect, it } from "vitest";
import { parseChannels } from "./store";

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
