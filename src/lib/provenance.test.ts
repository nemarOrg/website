import { describe, expect, it } from "vitest";
import landingOn007753 from "../../test/fixtures/jsonld-landing-on007753.json";
import landingNm000200 from "../../test/fixtures/landing-mirror-flag-nm000200.json";
import landingOn000001Unexamined from "../../test/fixtures/landing-mirror-flag-on000001-unexamined.json";
import landingOn000001 from "../../test/fixtures/landing-mirror-flag-on000001.json";
import type { LandingPayload, LandingVersion, NeuroschemaDataset } from "./neuroschema";
import {
  type DerivedProvenance,
  compareVersionTag,
  detectProvenance,
  findReferencePaperDoi,
  listMirrorVersions,
  pickMirrorVersion,
} from "./provenance";

function meta(over: Partial<NeuroschemaDataset> = {}): NeuroschemaDataset {
  return {
    schema_version: "0.3.0",
    doc_type: "dataset",
    dataset_id: "nm000103",
    name: "Test",
    description: null,
    source: "nemar",
    recording_modality: ["EEG"],
    bids_version: null,
    license: null,
    authors: [],
    keywords: [],
    related_identifiers: [],
    contributors: [],
    dates: [],
    rights: [],
    language: null,
    funding: [],
    tasks: [],
    datatypes: ["eeg"],
    sessions: [],
    sessions_count: null,
    demographics: null,
    data_summary: null,
    provenance: { latest_snapshot: "v1.0.0", publish_date: null },
    external_links: { dataset_doi: null, github_url: null },
    ...over,
  };
}

/** A version entry as a backend that predates the mirror flag sends it: no `mirror` key. */
function versionEntry(v: string): LandingVersion {
  return {
    version: v,
    doi: null,
    created_at: "2026-01-01",
    manifest_url: `/x/${v}/manifest.json`,
    browse_url: `/x/${v}/`,
  };
}

function landing(versions: string[]): LandingPayload {
  return {
    dataset_id: "x",
    latest: versions[0] ?? null,
    metadata_url: "/x/metadata.json",
    versions: versions.map(versionEntry),
  };
}

/** A landing as a backend that sends the flag shapes it: `mirror` on every version. */
function flaggedLanding(flags: Array<[version: string, mirror: boolean | null]>): LandingPayload {
  return {
    ...landing(flags.map(([version]) => version)),
    versions: flags.map(([version, mirror]) => ({ ...versionEntry(version), mirror })),
  };
}

// The mirror flag (website#478; nemar-cli ADR 0111, decision 5). Four landing payloads, none typed
// by hand, drive the main flag cases below:
//  - landing-mirror-flag-on000001.json: an OpenNeuro mirror with every value of the flag. Newest
//    first it reads v4.0.0 true, v3.0.0 null, v2.0.0 null, v1.0.1 false, v1.0.0 true.
//  - landing-mirror-flag-on000001-unexamined.json: the same dataset with no snapshot recorded on
//    any version, which is what a mirror reads as before NEMAR has examined it. Newest first it
//    reads v2.0.0 null, v1.0.0 null: no true and no false, only null. Most mirrors have nothing
//    but N.0.0 versions, so this is the common shape.
//  - landing-mirror-flag-nm000200.json: a NEMAR dataset, whose v2.0.0 and v1.0.0 are both false.
//  - jsonld-landing-on007753.json: a real capture of production (2026-07-29), made before the flag
//    existed, so no version carries the key.
// The first three are recordings of nemar-cli's real data-plane route (`GET /<id>` as JSON) over a
// real SQLite database built from its migrations, seeded the way nemar-cli's
// backend/test/landing-mirror-flag.test.ts seeds it. They were recorded at commit 1abf9286 of the
// branch for nemarOrg/nemar-cli#1046, and they are not captures of production. The one seed that
// differs is a DOI, which reads `...v4.0.0` for the stored-`v4.0.0` row where that test builds
// `...vv4.0.0`.
// A few cases need a shape no recording holds (a mixed list, a null version that is the newest, a
// scrambled order, an entry without the key, a single version). They build their payloads by hand
// with `flaggedLanding` and `versionEntry`.
const mirrorLanding = landingOn000001 as LandingPayload;
const unexaminedLanding = landingOn000001Unexamined as LandingPayload;
const nemarLanding = landingNm000200 as LandingPayload;
const preFlagLanding = landingOn007753 as LandingPayload;

describe("detectProvenance", () => {
  it("returns native for nm* datasets", () => {
    const p = detectProvenance(meta({ dataset_id: "nm000103" }), null);
    expect(p.kind).toBe("native");
  });

  it("detects derived on* with DOI-shaped related identifier", () => {
    const p = detectProvenance(
      meta({
        dataset_id: "on005262",
        related_identifiers: [
          {
            identifier: "10.18112/openneuro.ds005262.v1.0.0",
            identifier_type: "DOI",
            relation_type: "IsDerivedFrom",
          },
        ],
      }),
      landing(["v2.0.0", "v1.0.1", "v1.0.0"]),
    );
    expect(p.kind).toBe("derived");
    if (p.kind === "derived") {
      expect(p.originalDatasetId).toBe("ds005262");
      expect(p.originalDoi).toBe("10.18112/openneuro.ds005262.v1.0.0");
      expect(p.originalUrl).toBe("https://openneuro.org/datasets/ds005262");
      expect(p.mirrorVersion).toBe("v2.0.0");
      expect(p.allMirrorVersions).toEqual(["v2.0.0", "v1.0.0"]);
    }
  });

  it("detects derived via URL-shaped related identifier", () => {
    const p = detectProvenance(
      meta({
        dataset_id: "on000117",
        related_identifiers: [
          {
            identifier: "https://openneuro.org/datasets/ds000117",
            identifier_type: "URL",
            relation_type: "IsVariantFormOf",
          },
        ],
      }),
      null,
    );
    expect(p.kind).toBe("derived");
    if (p.kind === "derived") {
      expect(p.originalDatasetId).toBe("ds000117");
      expect(p.originalUrl).toBe("https://openneuro.org/datasets/ds000117");
    }
  });

  it("prefers canonical ds when multiple IsDerivedFrom entries exist", () => {
    // Re-released datasets carry both the original and the canonical id as
    // IsDerivedFrom. on002718 was originally ds000117 on OpenNeuro, then
    // re-released as ds002718; the canonical (ds002718) must win the pick.
    const p = detectProvenance(
      meta({
        dataset_id: "on002718",
        related_identifiers: [
          {
            identifier: "10.18112/openneuro.ds000117",
            identifier_type: "DOI",
            relation_type: "IsDerivedFrom",
          },
          {
            identifier: "10.18112/openneuro.ds002718.v1.1.0",
            identifier_type: "DOI",
            relation_type: "IsDerivedFrom",
          },
        ],
      }),
      null,
    );
    expect(p.kind).toBe("derived");
    if (p.kind === "derived") {
      expect(p.originalDatasetId).toBe("ds002718");
      expect(p.originalDoi).toBe("10.18112/openneuro.ds002718.v1.1.0");
      expect(p.originalUrl).toBe("https://openneuro.org/datasets/ds002718");
    }
  });

  it("falls back to first IsDerivedFrom when canonical is absent", () => {
    // Some datasets list only the older id (no canonical entry). Use it
    // rather than silently dropping the provenance signal.
    const p = detectProvenance(
      meta({
        dataset_id: "on999999",
        related_identifiers: [
          {
            identifier: "10.18112/openneuro.ds000117",
            identifier_type: "DOI",
            relation_type: "IsDerivedFrom",
          },
        ],
      }),
      null,
    );
    expect(p.kind).toBe("derived");
    if (p.kind === "derived") {
      expect(p.originalDatasetId).toBe("ds000117");
    }
  });

  it("falls back to id prefix swap when no related_identifiers", () => {
    const p = detectProvenance(meta({ dataset_id: "on005262", related_identifiers: [] }), null);
    expect(p.kind).toBe("derived");
    if (p.kind === "derived") {
      expect(p.originalDatasetId).toBe("ds005262");
      expect(p.originalUrl).toBe("https://openneuro.org/datasets/ds005262");
      expect(p.originalDoi).toBeNull();
    }
  });
});

describe("listMirrorVersions without the mirror flag (the fallback)", () => {
  it("returns vN.0.0 only, newest-first", () => {
    expect(listMirrorVersions(landing(["v3.0.0", "v2.0.1", "v2.0.0", "v1.1.0", "v1.0.0"]))).toEqual(
      ["v3.0.0", "v2.0.0", "v1.0.0"],
    );
  });
  it("returns empty for null", () => {
    expect(listMirrorVersions(null)).toEqual([]);
  });
  it("accepts versions without v prefix", () => {
    expect(listMirrorVersions(landing(["2.0.0", "1.0.0"]))).toEqual(["2.0.0", "1.0.0"]);
  });
  it("keeps the vN.0.0 rule on a payload recorded before the flag existed", () => {
    // The fixture is the evidence, so check it is what it claims: were it ever re-recorded with
    // the flag, this test would be exercising the other path.
    expect(preFlagLanding.versions.every((v) => !("mirror" in v))).toBe(true);
    expect(listMirrorVersions(preFlagLanding)).toEqual(["v1.0.0"]);
  });
});

describe("listMirrorVersions with the mirror flag", () => {
  it("lists only the versions flagged true, newest-first", () => {
    expect(listMirrorVersions(mirrorLanding)).toEqual(["v4.0.0", "v1.0.0"]);
  });

  it("answers from the flag when the key is there and from the number when it is not", () => {
    // The same recorded payload twice. With the key, v3.0.0 and v2.0.0 are null and left out.
    // With the key stripped they look like any other N.0.0, and the old rule lists them.
    const withoutKey: LandingPayload = {
      ...mirrorLanding,
      versions: mirrorLanding.versions.map(({ mirror: _flag, ...entry }) => entry),
    };
    expect(listMirrorVersions(withoutKey)).toEqual(["v4.0.0", "v3.0.0", "v2.0.0", "v1.0.0"]);
    expect(listMirrorVersions(mirrorLanding)).toEqual(["v4.0.0", "v1.0.0"]);
  });

  it("lists nothing while every N.0.0 is null, and does not fall back to the number", () => {
    // Null is a value the key can hold, not an absent key: a payload of nothing but null still
    // has the flag.
    expect(listMirrorVersions(unexaminedLanding)).toEqual([]);
  });

  it("lists nothing when the N.0.0 versions are null and a correction is false", () => {
    const noneTrue = flaggedLanding([
      ["v2.0.0", null],
      ["v1.0.1", false],
      ["v1.0.0", null],
    ]);
    expect(listMirrorVersions(noneTrue)).toEqual([]);
  });

  it("lists nothing for a NEMAR dataset, whose N.0.0 versions are false", () => {
    expect(listMirrorVersions(nemarLanding)).toEqual([]);
  });

  it("lists a mixed list by the flag: 2.0.0 true, 2.0.1 false, 1.0.0 null gives 2.0.0", () => {
    const mixed = flaggedLanding([
      ["v2.0.0", true],
      ["v2.0.1", false],
      ["v1.0.0", null],
    ]);
    expect(listMirrorVersions(mixed)).toEqual(["v2.0.0"]);
  });

  it("does not fall back for an entry that lacks the key in a payload that has it", () => {
    // Whether the bare entry comes first or last, one key anywhere turns the number rule off.
    const bareFirst: LandingPayload = {
      ...landing(["v2.0.0", "v1.0.0"]),
      versions: [versionEntry("v2.0.0"), { ...versionEntry("v1.0.0"), mirror: true }],
    };
    const bareLast: LandingPayload = {
      ...landing(["v2.0.0", "v1.0.0"]),
      versions: [{ ...versionEntry("v2.0.0"), mirror: true }, versionEntry("v1.0.0")],
    };
    expect(listMirrorVersions(bareFirst)).toEqual(["v1.0.0"]);
    expect(listMirrorVersions(bareLast)).toEqual(["v2.0.0"]);
  });

  it("sorts by version number, not by the order the API sends", () => {
    const scrambled = flaggedLanding([
      ["v1.0.0", true],
      ["v10.0.0", true],
      ["v9.0.0", true],
    ]);
    expect(listMirrorVersions(scrambled)).toEqual(["v10.0.0", "v9.0.0", "v1.0.0"]);
  });
});

describe("pickMirrorVersion without the mirror flag (the fallback)", () => {
  it("returns null on single-version datasets", () => {
    expect(pickMirrorVersion(landing(["v1.0.0"]))).toBeNull();
  });
  it("returns the highest vN.0.0", () => {
    expect(pickMirrorVersion(landing(["v2.0.0", "v1.0.1", "v1.0.0"]))).toBe("v2.0.0");
  });
  it("returns null on a real single-version payload recorded before the flag", () => {
    expect(pickMirrorVersion(preFlagLanding)).toBeNull();
  });
});

describe("pickMirrorVersion with the mirror flag", () => {
  it("returns null on a single-version dataset, whatever its flag", () => {
    for (const flag of [true, false, null]) {
      expect(pickMirrorVersion(flaggedLanding([["v1.0.0", flag]]))).toBeNull();
    }
  });
  it("returns the newest version flagged true", () => {
    expect(pickMirrorVersion(mirrorLanding)).toBe("v4.0.0");
    const mixed = flaggedLanding([
      ["v2.0.0", true],
      ["v2.0.1", false],
      ["v1.0.0", null],
    ]);
    expect(pickMirrorVersion(mixed)).toBe("v2.0.0");
  });
  it("returns null while no version is flagged true", () => {
    expect(pickMirrorVersion(unexaminedLanding)).toBeNull();
    expect(pickMirrorVersion(nemarLanding)).toBeNull();
  });
});

describe("detectProvenance with the mirror flag: what the switcher and the toggle receive", () => {
  // The dataset page hands `allMirrorVersions` to VersionSwitcher, which draws a chip on exactly
  // those versions, and `mirrorVersion` to ProvenanceToggle, which offers it as "View as-imported
  // mirror". Neither component derives anything from the version number.
  const derivedOf = (...args: Parameters<typeof detectProvenance>): DerivedProvenance => {
    const p = detectProvenance(...args);
    if (p.kind !== "derived") throw new Error(`expected a derived provenance, got ${p.kind}`);
    return p;
  };
  const onMeta = () => meta({ dataset_id: "on000001" });

  it("gives a chip to each true version and offers the newest of them as the mirror", () => {
    const p = derivedOf(onMeta(), mirrorLanding);
    expect(p.allMirrorVersions).toEqual(["v4.0.0", "v1.0.0"]);
    expect(p.mirrorVersion).toBe("v4.0.0");
  });

  it("gives no chip and no mirror while every N.0.0 is null, and still names the source", () => {
    const p = derivedOf(onMeta(), unexaminedLanding);
    expect(p.allMirrorVersions).toEqual([]);
    expect(p.mirrorVersion).toBeNull();
    expect(p.originalDatasetId).toBe("ds000001");
  });

  it("does not offer a null N.0.0 as the mirror even when it is the newest", () => {
    const newestUnknown = flaggedLanding([
      ["v3.0.0", null],
      ["v2.0.0", true],
      ["v1.0.0", true],
    ]);
    const p = derivedOf(onMeta(), newestUnknown);
    expect(p.allMirrorVersions).toEqual(["v2.0.0", "v1.0.0"]);
    expect(p.mirrorVersion).toBe("v2.0.0");
  });

  it("treats a NEMAR dataset as native, so the switcher gets no mirror versions", () => {
    expect(detectProvenance(meta({ dataset_id: "nm000200" }), nemarLanding).kind).toBe("native");
  });
});

describe("the recorded landing fixtures", () => {
  it("carry the six keys nemar-cli's landing has on each version, mirror among them", () => {
    for (const fixture of [mirrorLanding, unexaminedLanding, nemarLanding]) {
      for (const v of fixture.versions) {
        expect(Object.keys(v).sort()).toEqual([
          "browse_url",
          "created_at",
          "doi",
          "manifest_url",
          "mirror",
          "version",
        ]);
      }
    }
  });
});

describe("compareVersionTag", () => {
  it("orders semver", () => {
    expect(compareVersionTag("v1.0.0", "v2.0.0")).toBeLessThan(0);
    expect(compareVersionTag("v2.1.0", "v2.0.5")).toBeGreaterThan(0);
    expect(compareVersionTag("v1.0.0", "v1.0.0")).toBe(0);
  });
});

describe("findReferencePaperDoi", () => {
  it("returns the first non-dataset References DOI", () => {
    expect(
      findReferencePaperDoi([
        {
          identifier: "10.18112/openneuro.ds005262.v1.0.0",
          identifier_type: "DOI",
          relation_type: "IsDerivedFrom",
        },
        {
          identifier: "10.1038/sdata.2017.181",
          identifier_type: "DOI",
          relation_type: "References",
        },
      ]),
    ).toBe("10.1038/sdata.2017.181");
  });
  it("returns null when only dataset DOIs are present", () => {
    expect(
      findReferencePaperDoi([
        {
          identifier: "10.18112/openneuro.ds005262.v1.0.0",
          identifier_type: "DOI",
          relation_type: "References",
        },
      ]),
    ).toBeNull();
  });
});
