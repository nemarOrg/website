/**
 * `nemar.sensor-labels.v1` (`src/lib/quality-views/sensor-labels.ts`) held to neuroschema 0.6.0's
 * `views/vectors/sensor-labels.v1.json`: every case is replayed against the montage files this site
 * ships, and its result (outcome, reason, montage, counts, contenders, duplicates, reference, and
 * per channel the status, key and electrode) must be the vector's exactly; every placed channel
 * sits where the montage file puts its electrode.
 *
 * The vectors were computed with montages of listed SHA-256 digests, so the files are tied to them
 * first (and to PROVENANCE.json's), as the vocabulary drift test ties every copy to its pin: a
 * montage that drifted from the vectors' fails here before any case runs on it.
 */

import { describe, expect, it } from "vitest";
import { type Montage, MontageFileInvalid, parseMontage } from "../src/lib/quality-views/montages";
import {
  ALGORITHM,
  CAP_MODELS,
  NAME_MONTAGES,
  REASONS,
  TEMPLATE_ONLY_MONTAGES,
  capModelNets,
  countCandidates,
  foldCapModel,
  inferPositions,
  inferenceJson,
  loadNameMontages,
  sidecarInputs,
} from "../src/lib/quality-views/sensor-labels";
import type { Vec3 } from "../src/lib/quality-views/sensor-layout";
import { MONTAGE_NAMES } from "../src/lib/quality-views/sensor-names";
import { nodeFs, repoPath, sha256Hex } from "./node";
import { MONTAGES_DIR } from "./quality-views-vectors";

interface LabelsCase {
  readonly name: string;
  readonly description: string;
  readonly channels: readonly (readonly [string, string | null])[];
  readonly cap_model: string | null;
  readonly eeg_reference: string | null;
  readonly result: Record<string, unknown> & {
    readonly outcome: string;
    readonly reason: string | null;
    readonly montage: string | null;
    readonly candidates: number;
  };
}

const fs = await nodeFs();
const vectors = JSON.parse(
  fs.readFileSync(repoPath("test/fixtures/quality-views/vectors/sensor-labels.v1.json"), "utf8"),
) as { format: string; montages: Record<string, string>; cases: LabelsCase[] };
const provenance = JSON.parse(
  fs.readFileSync(repoPath(`${MONTAGES_DIR}/PROVENANCE.json`), "utf8"),
) as { montages: { name: string; sha256: string }[] };

const fileOf = (name: string) => fs.readFileSync(repoPath(`${MONTAGES_DIR}/${name}.json`));
const read = (name: string): Montage =>
  parseMontage(JSON.parse(new TextDecoder().decode(fileOf(name))), name);
const all = new Map(MONTAGE_NAMES.map((name) => [name, read(name)]));
const load = async (name: string): Promise<Montage> => {
  const held = all.get(name);
  if (!held) throw new Error(`no montage ${name}`);
  return held;
};
const montages = await loadNameMontages(load);

describe("the montages the vectors were computed with", () => {
  it("are nemar.sensor-labels.v1's", () => {
    expect(vectors.format).toBe(ALGORITHM);
  });

  it("are the fourteen montages names reach, in tie-break order", () => {
    expect(Object.keys(vectors.montages)).toEqual(NAME_MONTAGES);
    expect([...NAME_MONTAGES, ...TEMPLATE_ONLY_MONTAGES]).toEqual(MONTAGE_NAMES);
  });

  it.each(Object.entries(vectors.montages))(
    "%s is the file of the vectors' digest and PROVENANCE's",
    async (name, digest) => {
      const actual = await sha256Hex(fileOf(name));
      expect(actual).toBe(digest);
      expect(provenance.montages.find((m) => m.name === name)?.sha256).toBe(digest);
    },
  );
});

describe("every vector case", () => {
  it("covers every refusal reason", () => {
    const reasons = new Set(vectors.cases.map((c) => c.result.reason));
    for (const reason of REASONS) expect(reasons, reason).toContain(reason);
    expect(reasons).toContain(null);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const inference = inferPositions(c.channels, montages, {
      capModel: c.cap_model,
      reference: c.eeg_reference,
    });
    expect(inferenceJson(inference), c.description).toEqual(c.result);
    if (inference.outcome === "placed") {
      const montage = all.get(inference.montage!)!;
      for (const channel of inference.channels) {
        if (channel.electrode === null) {
          expect(channel.position).toBeNull();
          continue;
        }
        const at = montage.names.indexOf(channel.electrode);
        expect(channel.position).toEqual(montage.positions[at]);
      }
    } else {
      expect(inference.channels.every((ch) => ch.position === null)).toBe(true);
    }
  });
});

// The cases below pin rules whose break the vectors might not show alone, each named for the rule
// it pins; the mutation each one kills is in its title, after "kills:".

const typed = (names: readonly string[], type: string | null = "EEG") =>
  names.map((name) => [name, type] as const);
const TEN_TWENTY = [
  "Fp1",
  "Fp2",
  "F7",
  "F3",
  "Fz",
  "F4",
  "F8",
  "C3",
  "Cz",
  "C4",
  "P3",
  "Pz",
  "P4",
  "O1",
  "O2",
];

describe("the rules", () => {
  it("applies the 10-05 aliases on 10-05 only, VREF never there (kills: the HydroCel alias on every family)", () => {
    const placed = inferPositions(typed([...TEN_TWENTY, "T3", "T4"]), montages);
    expect(placed.montage).toBe("standard_1005");
    expect(placed.channels.at(-2)?.electrode).toBe("T7");
    // VREF is Cz on an EGI net, never on the 10-05 montage.
    const vref = inferPositions(typed([...TEN_TWENTY, "VREF"]), montages);
    expect(vref.montage).toBe("standard_1005");
    expect(vref.channels.at(-1)?.electrode).toBeNull();
    // On a BioSemi cap T3 names nothing: A1..A32 and T3 place on biosemi32, T3 unplaced.
    const bank = Array.from({ length: 32 }, (_, i) => `A${i + 1}`);
    const biosemi = inferPositions(typed([...bank, "T3"]), montages);
    expect(biosemi.montage).toBe("biosemi32");
    expect(biosemi.matched).toBe(32);
    expect(biosemi.channels.at(-1)?.electrode).toBeNull();
  });

  it("applies the 10-05 aliases on no other family, even a montage with 10-20 names (kills: the 10-05 aliases on every family)", () => {
    // MNE-Python's biosemi64 names its electrodes by the 10-20 system (PROVENANCE.json's
    // bank_labels give each bank label its 10-20 name): the same positions under those names, still
    // family BioSemi. On it T7 is an electrode, and T3 must not be read as T7.
    const biosemi = all.get("biosemi64")!;
    const rows = (
      provenance.montages.find((m) => m.name === "biosemi64") as unknown as {
        bank_labels: { rows: [string, string][] };
      }
    ).bank_labels.rows;
    const tenTwenty = new Map(rows);
    const renamed: Montage = {
      ...biosemi,
      name: "biosemi64-10-20",
      names: biosemi.names.map((label) => tenTwenty.get(label)!),
    };
    expect(renamed.names).toContain("T7");
    const names = renamed.names.filter((n) => !["T7", "T8", "P7", "P8"].includes(n));
    const legacy = inferPositions(typed([...names, "T3", "T4", "T5", "T6"]), [renamed]);
    expect(legacy.montage).toBe("biosemi64-10-20");
    expect(legacy.matched).toBe(60);
    expect(legacy.channels.slice(-4).map((c) => c.electrode)).toEqual([null, null, null, null]);
  });

  it("needs 8 matched names: 8 place, 7 refuse (kills: MIN_MATCHED off by one)", () => {
    const eight = inferPositions(typed(TEN_TWENTY.slice(0, 8)), montages);
    expect(eight.outcome).toBe("placed");
    expect(eight.matched).toBe(8);
    const seven = inferPositions(typed([...TEN_TWENTY.slice(0, 7), "X1"]), montages);
    expect(seven.reason).toBe("too_few_matched");
    expect(seven.matched).toBe(7);
    const sevenOfSeven = inferPositions(typed(TEN_TWENTY.slice(0, 7)), montages);
    expect(sevenOfSeven.reason).toBe("too_few_channels");
  });

  it("refuses a share under 80% though 8 match, and places at exactly 80% (kills: the share check dropped or off by one)", () => {
    const unknown = (n: number) => Array.from({ length: n }, (_, i) => `X${i + 1}`);
    const atShare = inferPositions(typed([...TEN_TWENTY.slice(0, 12), ...unknown(3)]), montages);
    expect(atShare.outcome).toBe("placed");
    const below = inferPositions(typed([...TEN_TWENTY.slice(0, 12), ...unknown(4)]), montages);
    expect(below.reason).toBe("share_too_low");
    expect(below.matched).toBe(12);
  });

  it("refuses a tie between montages that place the names apart (kills: montage_ambiguous dropped)", () => {
    // C1..C6 and A1, A2 are 10-05 names and BioSemi bank labels on unrelated positions.
    const tie = inferPositions(
      typed(["A1", "A2", "C1", "C2", "C3", "C4", "C5", "C6", "A3"]),
      montages,
    );
    // With A3, only BioSemi caps hold all nine; the smallest that does is the 128 cap, of which
    // nine names cover too little.
    expect([tie.reason, tie.contenders]).toEqual(["net_coverage_low", ["biosemi128"]]);
    const pure = inferPositions(typed(["A1", "A2", "C1", "C2", "C3", "C4", "C5", "C6"]), montages);
    expect([pure.reason, pure.contenders]).toEqual([
      "montage_ambiguous",
      ["standard_1005", "biosemi128"],
    ]);
  });

  it("strips a reference suffix and keeps a bipolar pair unplaced (kills: a reference suffix kept)", () => {
    const ref = inferPositions(typed(TEN_TWENTY.map((n) => `EEG ${n}-REF`)), montages);
    expect(ref.montage).toBe("standard_1005");
    expect(ref.channels[0].key).toBe("fp1");
    expect(ref.channels[0].electrode).toBe("Fp1");
    const common = inferPositions(typed(TEN_TWENTY.map((n) => `${n}-Xq`)), montages);
    expect(common.channels[0].key).toBe("fp1");
    expect(common.outcome).toBe("placed");
    const pairs = inferPositions(
      typed(["Fp1-F7", "F7-T7", "T7-P7", "P7-O1", "Fp2-F8", "F8-T8", "T8-P8", "P8-O2"]),
      montages,
    );
    expect(pairs.reason).toBe("bipolar_labels");
    expect(pairs.channels.every((c) => c.status === "bipolar")).toBe(true);
  });

  it("never matches or chooses a template-only montage, even when given one (kills: template-only montages matched)", () => {
    const egi = Array.from({ length: 128 }, (_, i) => `E${i + 1}`);
    const older = TEMPLATE_ONLY_MONTAGES.map((name) => all.get(name)!);
    const result = inferPositions(typed([...egi, "Cz"]), [...older], {
      capModel: "GSN129",
    });
    expect(result.reason).toBe("labels_unrecognized");
    expect(result.matched).toBe(0);
  });

  it("places an EGI net only when the cap model names it (kills: the cap model check dropped)", () => {
    const egi = typed([...Array.from({ length: 128 }, (_, i) => `E${i + 1}`), "Cz"]);
    expect(inferPositions(egi, montages).reason).toBe("cap_model_unknown");
    const named = inferPositions(egi, montages, { capModel: "HydroCel GSN 128 1.0" });
    expect(named.montage).toBe("GSN-HydroCel-129");
    expect(inferPositions(egi, montages, { capModel: "GSN 200 v2.1" }).reason).toBe(
      "cap_model_unknown",
    );
  });

  it("refuses a montage file whose labels share a key (kills: the key uniqueness check dropped)", () => {
    const standard = all.get("standard_1005")!;
    const broken: Montage = {
      ...standard,
      names: ["Cz", "CZ", ...standard.names.slice(2)],
    };
    expect(() => inferPositions(typed(TEN_TWENTY), [broken])).toThrow(MontageFileInvalid);
  });
});

describe("the cap model and the coincidence tolerance (neuroschema's own tests, ported)", () => {
  const HYDROCEL = NAME_MONTAGES.filter((n) => n.startsWith("GSN-HydroCel-"));
  const SIZED: Record<string, string[]> = {
    "32": ["GSN-HydroCel-32"],
    "64": ["GSN-HydroCel-64_1.0", "GSN-HydroCel-65_1.0"],
    "128": ["GSN-HydroCel-128", "GSN-HydroCel-129"],
    "256": ["GSN-HydroCel-256", "GSN-HydroCel-257"],
  };
  // The spec's table (docs/views/sensor-labels.md, The cap model), written out here, not read
  // from the module.
  const SPEC_CAP_MODELS: Record<string, string[]> = {
    "hydrocel geodesic sensor net": HYDROCEL,
    "hydrocel geodisic sensor net": HYDROCEL,
    "hydrocel gsn": HYDROCEL,
    ...Object.fromEntries(
      Object.entries(SIZED).flatMap(([size, nets]) => [
        [`hydrocel geodesic sensor net ${size}`, nets],
        [`hydrocel gsn ${size}`, nets],
        [`hydrocel gsn ${size} 1.0`, nets],
      ]),
    ),
    "gsn-hydrocel-32": SIZED["32"],
    "gsn-hydrocel-64_1.0": SIZED["64"],
    "gsn-hydrocel-65_1.0": SIZED["64"],
    "gsn-hydrocel-128": SIZED["128"],
    "gsn-hydrocel-129": SIZED["128"],
    "gsn-hydrocel-256": SIZED["256"],
    "gsn-hydrocel-257": SIZED["256"],
  };
  /** Every channel name of a whole EGI net, its vertex reference as Cz. */
  const fullNet = (net: string): string[] => {
    const montage = all.get(net)!;
    const names = montage.names.map((_, i) => `E${i + 1}`);
    if (montage.names.includes("Cz")) names[names.length - 1] = "Cz";
    return names;
  };

  it("lists exactly the spec's cap models, each naming the spec's nets", () => {
    expect([...CAP_MODELS.keys()].sort()).toEqual(Object.keys(SPEC_CAP_MODELS).sort());
    for (const [model, nets] of Object.entries(SPEC_CAP_MODELS)) {
      expect([...(CAP_MODELS.get(model) ?? [])].sort(), model).toEqual([...nets].sort());
    }
  });

  it.each(Object.keys(SPEC_CAP_MODELS).sort())(
    "%s places a full net of each size it names (kills: a cap model dropped or misnamed)",
    (model) => {
      for (const net of HYDROCEL) {
        if (net === "GSN-HydroCel-32") continue; // never placed: its names are also BioSemi 160's E bank
        const result = inferPositions(typed(fullNet(net)), montages, { capModel: model });
        if (SPEC_CAP_MODELS[model].includes(net)) {
          expect([result.outcome, result.montage], `${model} ${net}`).toEqual(["placed", net]);
        } else if (result.outcome === "placed") {
          // The same names are a whole net the model does name.
          expect(SPEC_CAP_MODELS[model], `${model} ${net}`).toContain(result.montage);
        } else {
          expect(["cap_model_unknown", "net_coverage_low"], `${model} ${net}`).toContain(
            result.reason,
          );
        }
      }
    },
  );

  /** The real montages, with one electrode of `name` moved `dx` meters along x. */
  const moved = (name: string, label: string, dx: number): Montage[] =>
    montages.map((m) => {
      if (m.name !== name) return m;
      const at = m.names.indexOf(label);
      const positions = m.positions.map((p, i): Vec3 => (i === at ? [p[0] + dx, p[1], p[2]] : p));
      return { ...m, positions };
    });

  it.each([
    [0.5e-9, "placed"],
    [2e-9, "refused"],
  ] as const)(
    "E1 to E128 and Cz with E7 of the 128 net moved %s m is %s (kills: the 1e-9 m tolerance changed)",
    (dx, outcome) => {
      const names = [...Array.from({ length: 128 }, (_, i) => `E${i + 1}`), "Cz"];
      const result = inferPositions(typed(names), moved("GSN-HydroCel-128", "E7", dx), {
        capModel: "HydroCel GSN",
      });
      expect(result.outcome).toBe(outcome);
      if (outcome === "refused") {
        expect([result.reason, result.contenders]).toEqual([
          "montage_ambiguous",
          ["GSN-HydroCel-128", "GSN-HydroCel-129"],
        ]);
      }
    },
  );
});

describe("countCandidates", () => {
  it("counts candidates and bipolar names with no montage, as the algorithm does", () => {
    for (const c of vectors.cases) {
      expect(countCandidates(c.channels), c.name).toBe(c.result.candidates);
    }
  });
});

describe("the sidecar and the cap model", () => {
  it("reads CapManufacturersModelName and EEGReference, strings only", () => {
    expect(
      sidecarInputs({ CapManufacturersModelName: "HydroCel GSN 128 1.0", EEGReference: 3 }),
    ).toEqual({ capModel: "HydroCel GSN 128 1.0", reference: null });
  });

  it("folds whitespace and A to Z only", () => {
    expect(foldCapModel("  HydroCel\tGSN   128 ")).toBe("hydrocel gsn 128");
    expect(capModelNets("HydroCel GSN 128")).toEqual([]);
    expect(capModelNets(null)).toEqual([]);
  });
});

describe("the refusal sentences", () => {
  it("are one per reason, in one copy, shown by the quality views and the viewer alike", async () => {
    const { LABELS_SENTENCES, asClause } = await import(
      "../src/lib/quality-views/sensor-labels-copy"
    );
    const { MAP_SENTENCES } = await import("../src/lib/quality-views/render/words");
    const { SCALP_MAP_SENTENCES } = await import("../src/lib/eeg-viewer/scalp-map");
    expect(Object.keys(LABELS_SENTENCES).sort()).toEqual([...REASONS].sort());
    for (const reason of REASONS) {
      const text = LABELS_SENTENCES[reason];
      // The first word is capitalized only as a sentence's first word, so it reads after a colon.
      expect(text, reason).toMatch(/^[A-Z][a-z]+ /);
      expect(MAP_SENTENCES[reason]).toBe(text);
      expect(SCALP_MAP_SENTENCES[reason]).toBe(`No scalp map: ${asClause(text)}`);
    }
    expect(Object.keys(MAP_SENTENCES)).not.toContain("labels_pending");
  });
});
