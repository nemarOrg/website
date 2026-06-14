import { describe, expect, it } from "vitest";
import { STANDARD_1005, lookupStandardPosition, standardMontageFor } from "./standard-montage";

describe("STANDARD_1005", () => {
  it("covers the common 10-20/10-10 landmarks as finite 3-vectors", () => {
    for (const label of ["Fp1", "Fz", "Cz", "Pz", "Oz", "T7", "T8", "P7", "P8", "TP9", "CPz"]) {
      const p = STANDARD_1005[label];
      expect(p, label).toBeDefined();
      expect(p.length).toBe(3);
      expect(p.every((n) => Number.isFinite(n))).toBe(true);
    }
  });
});

describe("lookupStandardPosition", () => {
  it("is case-insensitive (FP1 === Fp1)", () => {
    expect(lookupStandardPosition("FP1")).toEqual(STANDARD_1005.Fp1);
    expect(lookupStandardPosition("cz")).toEqual(STANDARD_1005.Cz);
    expect(lookupStandardPosition("  Oz ")).toEqual(STANDARD_1005.Oz);
  });

  it("maps legacy 10-20 names onto their modern 10-10 equivalents", () => {
    expect(lookupStandardPosition("T3")).toEqual(STANDARD_1005.T7);
    expect(lookupStandardPosition("T4")).toEqual(STANDARD_1005.T8);
    expect(lookupStandardPosition("T5")).toEqual(STANDARD_1005.P7);
    expect(lookupStandardPosition("T6")).toEqual(STANDARD_1005.P8);
  });

  it("returns null for non-standard labels", () => {
    for (const label of ["E1", "E128", "FOO", "1", "EOG", "STATUS", ""]) {
      expect(lookupStandardPosition(label), label).toBeNull();
    }
  });
});

describe("standardMontageFor", () => {
  it("resolves an electrodes.tsv-less 10-10 cap (on007137-style) keyed by original spelling", () => {
    // Real labels from nemarDatasets/on007137 (ships no electrodes.tsv).
    const labels = ["FP1", "Fz", "F3", "F7", "FC3", "C3", "C5", "TP9", "CPz", "Pz", "P3", "PO3"];
    const m = standardMontageFor(labels);
    expect(Object.keys(m).length).toBe(labels.length);
    // Keyed by the dataset's own spelling so the render lookup (topoLayout.get(ch.label)) hits.
    expect(m.FP1).toEqual(STANDARD_1005.Fp1);
    expect(m.CPz).toEqual(STANDARD_1005.CPz);
  });

  it("drops non-scalp channels so only locatable EEG labels remain", () => {
    const m = standardMontageFor(["Cz", "Fz", "Pz", "EOG", "ECG", "Status", "Trigger"]);
    expect(Object.keys(m).sort()).toEqual(["Cz", "Fz", "Pz"]);
  });

  it("does not fabricate a topomap for non-standard label sets", () => {
    // EGI numeric net -> nothing resolves (caller's >=3 gate then disables the topomap).
    expect(Object.keys(standardMontageFor(["E1", "E2", "E3", "E64"])).length).toBe(0);
    // BioSemi A1..A4 -> only the ear refs A1/A2 exist in the montage: 2 < 3, no topomap.
    expect(Object.keys(standardMontageFor(["A1", "A2", "A3", "A4"])).sort()).toEqual(["A1", "A2"]);
  });
});
