import { describe, expect, it } from "vitest";
import { BIOSEMI_128, BIOSEMI_256, GSN_HYDROCEL_129, GSN_HYDROCEL_257 } from "./net-montages";
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

  it("does not fabricate a topomap for unrecognizable label sets", () => {
    // Purely numeric / instrumentation labels match no standard or named net.
    expect(Object.keys(standardMontageFor(["1", "2", "3", "4"])).length).toBe(0);
    expect(Object.keys(standardMontageFor(["EOG", "ECG", "Status", "Trigger"])).length).toBe(0);
  });
});

describe("standardMontageFor named-net fallback (#855)", () => {
  it("resolves an EGI GSN-HydroCel-129 cap (HBN E1..E128 + Cz) keyed by spelling", () => {
    const labels = [...Array.from({ length: 128 }, (_, i) => `E${i + 1}`), "Cz"];
    const m = standardMontageFor(labels);
    expect(Object.keys(m).length).toBe(129);
    expect(m.E1).toEqual(GSN_HYDROCEL_129.E1);
    expect(m.Cz).toEqual(GSN_HYDROCEL_129.Cz);
  });

  it("picks the 257-net when an electrode number exceeds 128", () => {
    const labels = ["E1", "E2", "E200", "E256", "Cz"];
    const m = standardMontageFor(labels);
    expect(m.E256).toEqual(GSN_HYDROCEL_257.E256);
    // E1 must come from the 257-net, not the 129-net (positions differ per net).
    expect(m.E1).toEqual(GSN_HYDROCEL_257.E1);
    expect(m.E1).not.toEqual(GSN_HYDROCEL_129.E1);
  });

  it("resolves a BioSemi-128 cap (A1..D32, banks A-D only)", () => {
    const labels = ["A1", "A17", "B5", "C20", "D32"];
    const m = standardMontageFor(labels);
    expect(m.A1).toEqual(BIOSEMI_128.A1);
    expect(m.D32).toEqual(BIOSEMI_128.D32);
  });

  it("picks BioSemi-256 when banks run past D, routing the E* overlap to BioSemi", () => {
    const labels = ["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H32"];
    const m = standardMontageFor(labels);
    expect(m.H32).toEqual(BIOSEMI_256.H32);
    expect(m.A1).toEqual(BIOSEMI_256.A1);
    // E1 here is BioSemi bank E (A-bank present), NOT the EGI geodesic E1.
    expect(m.E1).toEqual(BIOSEMI_256.E1);
    expect(m.E1).not.toEqual(GSN_HYDROCEL_129.E1);
  });

  it("ignores case and still resolves the EGI net", () => {
    const m = standardMontageFor(["e1", "e2", "e3", "cz"]);
    expect(m.e1).toEqual(GSN_HYDROCEL_129.E1);
    expect(m.cz).toEqual(GSN_HYDROCEL_129.Cz);
  });

  it("resolves a plain 10-10 set to STANDARD_1005 (no named net matches)", () => {
    // No A-bank and no E-numbered labels, so namedNetIndex returns null and the
    // standard montage is used.
    const labels = ["Fp1", "Fz", "Cz", "Pz", "Oz"];
    const m = standardMontageFor(labels);
    expect(m.Cz).toEqual(STANDARD_1005.Cz);
  });
});
