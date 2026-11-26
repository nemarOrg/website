import { describe, expect, it } from "vitest";
import { loadMontage } from "../quality-views/montage-loader";
import { candidateMontages, matchLabels, namedCap } from "./name-placement";

/** The position `label` has in the montage `name`'s own file. */
async function positionIn(name: string, label: string) {
  const montage = await loadMontage(name);
  return montage.positions[montage.names.indexOf(label)];
}

describe("namedCap and candidateMontages", () => {
  it("tries an EGI net first, by its highest number", () => {
    const hbn = [...Array.from({ length: 128 }, (_, i) => `E${i + 1}`), "Cz"];
    expect(namedCap(hbn)).toBe("GSN-HydroCel-129");
    expect(namedCap(["E1", "E2", "E200", "E256", "Cz"])).toBe("GSN-HydroCel-257");
    expect(candidateMontages(hbn)).toEqual(["GSN-HydroCel-129", "standard_1005"]);
  });

  it("tries a BioSemi cap when bank labels dominate, by its highest bank", () => {
    expect(namedCap(["A1", "A17", "B5", "C20", "D32"])).toBe("biosemi128");
    expect(namedCap(["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H32"])).toBe("biosemi256");
  });

  it("does not take a 10-20 cap with an A2 ear reference for BioSemi (nm000109)", () => {
    const labels = "Fp1 Fp2 F3 F4 F7 F8 T3 T4 C3 C4 T5 T6 P3 P4 O1 O2 Fz Cz Pz A2".split(" ");
    expect(namedCap(labels)).toBeNull();
    expect(candidateMontages(labels)).toEqual(["standard_1005"]);
  });
});

describe("matchLabels against neuroschema's montage files", () => {
  it("keeps the dataset's spelling, ignores case, and takes positions from the file", async () => {
    const montage = await loadMontage("standard_1005");
    const matched = matchLabels(["FP1", "cz", "  Oz ", "EOG", "1"], montage);
    expect(matched.map((m) => m.label)).toEqual(["FP1", "cz", "  Oz "]);
    expect(matched[0].position).toEqual(await positionIn("standard_1005", "Fp1"));
    expect(matched[1].position).toEqual(await positionIn("standard_1005", "Cz"));
  });

  it("reads the 10-20 aliases on the 10-05 montage only", async () => {
    const standard = await loadMontage("standard_1005");
    const aliased = matchLabels(["T3", "T4", "T5", "T6"], standard);
    expect(aliased.map((m) => m.position)).toEqual(
      await Promise.all(["T7", "T8", "P7", "P8"].map((l) => positionIn("standard_1005", l))),
    );
    const biosemi = await loadMontage("biosemi64");
    expect(matchLabels(["T3"], biosemi)).toEqual([]);
  });

  it("places an EGI net's own numbering, not the 10-05 montage's", async () => {
    const net = await loadMontage("GSN-HydroCel-257");
    const matched = matchLabels(["e1", "E256", "Cz"], net);
    expect(matched).toHaveLength(3);
    expect(matched[0].position).toEqual(await positionIn("GSN-HydroCel-257", "E1"));
    expect(matched[0].position).not.toEqual(await positionIn("GSN-HydroCel-129", "E1"));
  });
});
