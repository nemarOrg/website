/**
 * The name rules `nemar.sensor-layout.v1` reads from `nemar.sensor-labels.v1`
 * (`src/lib/quality-views/sensor-names.ts`), held to neuroschema 0.6.0's
 * `views/vectors/sensor-labels.v1.json`.
 *
 * Each vector channel carries its status and normalized key. The parts these rules decide alone are
 * checked on every channel: a channel typed other than EEG is `excluded_type`; an untyped one whose
 * cleaned name starts with a non-EEG prefix is `excluded_name`; and for a channel with no hyphen
 * (the split at a hyphen is W2b's), the key is `finish(clean(name))` and it is a `fiducial` exactly
 * when that key is one.
 */

import { describe, expect, it } from "vitest";
import {
  FIDUCIALS,
  MONTAGE_NAMES,
  clean,
  excludedByName,
  finish,
  fold,
  typeClass,
} from "../src/lib/quality-views/sensor-names";
import { nodeFs, repoPath } from "./node";

interface LabelsVectors {
  readonly montages: Readonly<Record<string, string>>;
  readonly cases: readonly {
    readonly name: string;
    readonly channels: readonly (readonly [string, string | null])[];
    readonly result: {
      readonly channels: readonly { readonly status: string; readonly key: string | null }[];
    };
  }[];
}

const fs = await nodeFs();
const vectors = JSON.parse(
  fs.readFileSync(repoPath("test/fixtures/quality-views/vectors/sensor-labels.v1.json"), "utf8"),
) as LabelsVectors;

const channels = vectors.cases.flatMap((vectorCase) =>
  vectorCase.channels.map(([name, type], i) => ({
    where: `${vectorCase.name}[${i}] ${JSON.stringify(name)}`,
    name,
    type,
    ...vectorCase.result.channels[i],
  })),
);

describe("the sensor-labels vectors", () => {
  it("list the twenty montage files by the names this site compares exactly", () => {
    // The vectors list the fourteen montages names reach; the six older EGI nets are template-only.
    for (const name of Object.keys(vectors.montages)) expect(MONTAGE_NAMES).toContain(name);
    expect(MONTAGE_NAMES.slice(-6)).toEqual([
      "GSN64v2_0",
      "GSN65v2_0",
      "GSN128",
      "GSN129",
      "GSN256",
      "GSN257",
    ]);
  });

  it("hold every status these rules decide", () => {
    const statuses = new Set(channels.map((c) => c.status));
    for (const status of ["excluded_type", "excluded_name", "fiducial", "candidate"]) {
      expect(statuses.has(status), status).toBe(true);
    }
  });
});

describe("the name rules against every vector channel", () => {
  it("exclude a channel by its type exactly when the vector does", () => {
    const wrong = channels.filter(
      (c) => (typeClass(c.type) === "other") !== (c.status === "excluded_type"),
    );
    expect(wrong.map((c) => c.where)).toEqual([]);
  });

  it("exclude an untyped channel by its name exactly when the vector does", () => {
    const wrong = channels.filter(
      (c) =>
        typeClass(c.type) !== "other" &&
        (typeClass(c.type) === "untyped" && excludedByName(clean(c.name))) !==
          (c.status === "excluded_name"),
    );
    expect(wrong.map((c) => c.where)).toEqual([]);
  });

  it("give an unhyphenated name the vector's key, and call it a fiducial when the vector does", () => {
    const unhyphenated = channels.filter(
      (c) =>
        c.status !== "excluded_type" &&
        c.status !== "excluded_name" &&
        !clean(c.name).includes("-"),
    );
    expect(unhyphenated.length).toBeGreaterThan(5000);
    const wrongKey = unhyphenated.filter((c) => finish(clean(c.name)) !== c.key);
    expect(wrongKey.map((c) => `${c.where}: ${finish(clean(c.name))} != ${c.key}`)).toEqual([]);
    const wrongFiducial = unhyphenated.filter(
      (c) => FIDUCIALS.has(c.key!) !== (c.status === "fiducial"),
    );
    expect(wrongFiducial.map((c) => c.where)).toEqual([]);
  });
});

describe("the name rules, case by case", () => {
  it("fold full-width ASCII and the compatibility spaces, and nothing else", () => {
    expect(fold("Ｆｐ１")).toBe("Fp1");
    expect(fold("C 3　x")).toBe("C 3 x");
    expect(fold("Ｆ́")).toBe("F́");
  });

  it("clean trims, collapses whitespace and drops one type prefix", () => {
    expect(clean("  EEG Fp1-REF ")).toBe("Fp1-REF");
    expect(clean("eeg:\tCz")).toBe("Cz");
    expect(clean("POL  C3")).toBe("C3");
    expect(clean("EEGFp1")).toBe("EEGFp1");
    expect(clean("A\t\n B")).toBe("A B");
  });

  it("finish strips dots, quotes and spaces, lowercases A to Z, and drops leading zeros", () => {
    expect(finish(" 'E001.' ")).toBe("e1");
    expect(finish("A01")).toBe("a1");
    expect(finish("E100")).toBe("e100");
    expect(finish("E0")).toBe("e0");
    expect(finish("E00")).toBe("e0");
    expect(finish("Ä1")).toBe("Ä1");
  });

  it("type a channel by its trimmed, folded BIDS type", () => {
    expect(typeClass(null)).toBe("untyped");
    expect(typeClass(" N/A ")).toBe("untyped");
    expect(typeClass("")).toBe("untyped");
    expect(typeClass("\teEg\n")).toBe("eeg");
    expect(typeClass("SEEG")).toBe("other");
    expect(typeClass("EOG")).toBe("other");
  });
});
