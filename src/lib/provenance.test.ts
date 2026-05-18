import { describe, expect, it } from "vitest";
import {
  compareVersionTag,
  detectProvenance,
  findReferencePaperDoi,
  listMirrorVersions,
  pickMirrorVersion,
} from "./provenance";
import type { LandingPayload, NeuroschemaDataset } from "./neuroschema";

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

function landing(versions: string[]): LandingPayload {
  return {
    dataset_id: "x",
    latest: versions[0] ?? null,
    metadata_url: "/x/metadata.json",
    versions: versions.map((v) => ({
      version: v,
      doi: null,
      created_at: "2026-01-01",
      manifest_url: `/x/${v}/manifest.json`,
      browse_url: `/x/${v}/`,
    })),
  };
}

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

describe("listMirrorVersions", () => {
  it("returns vN.0.0 only, newest-first", () => {
    expect(listMirrorVersions(landing(["v3.0.0", "v2.0.1", "v2.0.0", "v1.1.0", "v1.0.0"]))).toEqual([
      "v3.0.0",
      "v2.0.0",
      "v1.0.0",
    ]);
  });
  it("returns empty for null", () => {
    expect(listMirrorVersions(null)).toEqual([]);
  });
  it("accepts versions without v prefix", () => {
    expect(listMirrorVersions(landing(["2.0.0", "1.0.0"]))).toEqual(["2.0.0", "1.0.0"]);
  });
});

describe("pickMirrorVersion", () => {
  it("returns null on single-version datasets", () => {
    expect(pickMirrorVersion(landing(["v1.0.0"]))).toBeNull();
  });
  it("returns the highest vN.0.0", () => {
    expect(pickMirrorVersion(landing(["v2.0.0", "v1.0.1", "v1.0.0"]))).toBe("v2.0.0");
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
        { identifier: "10.18112/openneuro.ds005262.v1.0.0", identifier_type: "DOI", relation_type: "IsDerivedFrom" },
        { identifier: "10.1038/sdata.2017.181", identifier_type: "DOI", relation_type: "References" },
      ]),
    ).toBe("10.1038/sdata.2017.181");
  });
  it("returns null when only dataset DOIs are present", () => {
    expect(
      findReferencePaperDoi([
        { identifier: "10.18112/openneuro.ds005262.v1.0.0", identifier_type: "DOI", relation_type: "References" },
      ]),
    ).toBeNull();
  });
});
