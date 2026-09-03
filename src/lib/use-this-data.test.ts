import { describe, expect, it } from "vitest";
import catalogNm000103 from "../../test/fixtures/jsonld-catalog-nm000103.json";
import catalogNm000154 from "../../test/fixtures/jsonld-catalog-nm000154.json";
import catalogOn007753 from "../../test/fixtures/jsonld-catalog-on007753.json";
import landingNm000103 from "../../test/fixtures/jsonld-landing-nm000103.json";
import landingNm000154 from "../../test/fixtures/jsonld-landing-nm000154.json";
import landingOn007753 from "../../test/fixtures/jsonld-landing-on007753.json";
import metadataNm000103 from "../../test/fixtures/jsonld-metadata-nm000103.json";
import metadataNm000154 from "../../test/fixtures/jsonld-metadata-nm000154.json";
import metadataOn007753 from "../../test/fixtures/jsonld-metadata-on007753.json";
import { isUnpublished } from "./data-api";
import type { LandingPayload, NeuroschemaDataset } from "./neuroschema";
import {
  type UseThisData,
  type UseThisDataCatalogRow,
  type UseThisDataInput,
  buildUseThisData,
  renderUseThisDataMarkdown,
} from "./use-this-data";

// Same three real captures jsonld.test.ts uses (2026-07-29, production
// api.nemar.org / data.nemar.org), chosen there for exactly the shapes this
// builder also has to handle:
//  - nm000103: fully populated (license, DOI, References x2, HED version).
//  - on007753: OpenNeuro-derived, CC0, related_identifiers that are ALL
//    "IsReferencedBy" (papers that cite this dataset) rather than
//    "References" (papers to cite when using it).
//  - nm000154: sparse -- null description, null license, empty authors.

function realInput(
  metadata: NeuroschemaDataset,
  landing: LandingPayload,
  catalogRow: UseThisDataCatalogRow | null,
  overrides: Partial<UseThisDataInput> = {},
): UseThisDataInput {
  const selectedVersion = landing.latest ?? landing.versions[0]?.version ?? null;
  return {
    id: metadata.dataset_id,
    metadata,
    catalogRow,
    selectedVersion,
    unpublished: isUnpublished(landing),
    dataBase: "https://data.nemar.org",
    zarrBase: "https://zarr.nemar.org",
    ...overrides,
  };
}

const nm000103 = () =>
  realInput(
    metadataNm000103 as unknown as NeuroschemaDataset,
    landingNm000103 as LandingPayload,
    catalogNm000103 as unknown as UseThisDataCatalogRow,
  );
const on007753 = () =>
  realInput(
    metadataOn007753 as unknown as NeuroschemaDataset,
    landingOn007753 as LandingPayload,
    catalogOn007753 as unknown as UseThisDataCatalogRow,
  );
const nm000154 = () =>
  realInput(
    metadataNm000154 as unknown as NeuroschemaDataset,
    landingNm000154 as LandingPayload,
    catalogNm000154 as unknown as UseThisDataCatalogRow,
  );

/** Every fact value the model carries, across every section — the flat list
 *  the parity test checks against the markdown rendering. */
function allFactValues(model: UseThisData): string[] {
  return model.sections.flatMap((s) => s.items.map((i) => i.value));
}

describe("buildUseThisData / renderUseThisDataMarkdown — parity", () => {
  // The load-bearing test: build once, render once, and mechanically check
  // that every fact the model carries survives into the markdown output —
  // rather than a hand-listed set of string assertions that rots as the
  // model grows. Covers all three real dataset shapes.
  for (const [label, input] of [
    ["nm000103 (fully populated)", nm000103()],
    ["on007753 (OpenNeuro-derived, IsReferencedBy only)", on007753()],
    ["nm000154 (sparse, null license/authors)", nm000154()],
  ] as const) {
    it(`every fact in the ${label} model appears verbatim in its markdown`, () => {
      const model = buildUseThisData(input);
      const markdown = renderUseThisDataMarkdown(model);
      for (const value of allFactValues(model)) {
        expect(markdown).toContain(value);
      }
    });
  }

  it("never throws building or rendering any of the three real fixtures", () => {
    for (const input of [nm000103(), on007753(), nm000154()]) {
      expect(() => renderUseThisDataMarkdown(buildUseThisData(input))).not.toThrow();
    }
  });
});

describe("buildUseThisData — Zarr block gating", () => {
  it("includes the Zarr section when the catalog row is ready with stores (nm000103)", () => {
    const model = buildUseThisData(nm000103());
    const zarr = model.sections.find((s) => s.id === "zarr");
    expect(zarr).toBeDefined();
    expect(zarr?.items.length).toBeGreaterThan(0);
  });

  it("omits the Zarr section when zarr_status is not ready", () => {
    const input = nm000103();
    const model = buildUseThisData({
      ...input,
      catalogRow: { ...(input.catalogRow as UseThisDataCatalogRow), zarr_status: "pending" },
    });
    expect(model.sections.find((s) => s.id === "zarr")).toBeUndefined();
  });

  it("omits the Zarr section when zarr_store_count is 0", () => {
    const input = nm000103();
    const model = buildUseThisData({
      ...input,
      catalogRow: { ...(input.catalogRow as UseThisDataCatalogRow), zarr_store_count: 0 },
    });
    expect(model.sections.find((s) => s.id === "zarr")).toBeUndefined();
  });

  it("omits the Zarr section entirely when there is no catalog row", () => {
    const model = buildUseThisData({ ...nm000103(), catalogRow: null });
    expect(model.sections.find((s) => s.id === "zarr")).toBeUndefined();
  });

  it("falls back to zarrIndexUrl(id) when the row carries no zarr_index_url", () => {
    // None of the three real fixtures carry zarr_index_url (it predates this
    // phase's addition to the wire contract) -- confirms the fallback fires
    // on real data, not just a hand-built case.
    const input = nm000103();
    expect((input.catalogRow as UseThisDataCatalogRow).zarr_index_url).toBeUndefined();
    const model = buildUseThisData(input);
    const zarr = model.sections.find((s) => s.id === "zarr");
    const step1 = zarr?.items.find((i) => i.key === "zarr-step-1");
    expect(step1?.href).toBe("https://zarr.nemar.org/nm000103/zarr/index.json");
  });

  it("prefers the row's own zarr_index_url when present", () => {
    const input = nm000103();
    const model = buildUseThisData({
      ...input,
      catalogRow: {
        ...(input.catalogRow as UseThisDataCatalogRow),
        zarr_index_url: "https://zarr.nemar.org/nm000103/zarr/index.json?v=custom",
      },
    });
    const zarr = model.sections.find((s) => s.id === "zarr");
    const step1 = zarr?.items.find((i) => i.key === "zarr-step-1");
    expect(step1?.href).toBe("https://zarr.nemar.org/nm000103/zarr/index.json?v=custom");
  });
});

describe("buildUseThisData — unpublished dataset", () => {
  function unpublishedInput(): UseThisDataInput {
    const metadata: NeuroschemaDataset = {
      schema_version: "0.3.0",
      doc_type: "dataset",
      dataset_id: "nm099998",
      name: "Registered but Unpublished",
      description: null,
      source: "nemar",
      recording_modality: [],
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
      datatypes: [],
      sessions: [],
      sessions_count: null,
      demographics: null,
      data_summary: null,
      provenance: { latest_snapshot: null, publish_date: null },
      external_links: { dataset_doi: null, github_url: null },
    };
    return {
      id: "nm099998",
      metadata,
      catalogRow: null,
      selectedVersion: null,
      unpublished: true,
      dataBase: "https://data.nemar.org",
      zarrBase: "https://zarr.nemar.org",
    };
  }

  it("never throws for an unpublished, fully-empty dataset", () => {
    expect(() => renderUseThisDataMarkdown(buildUseThisData(unpublishedInput()))).not.toThrow();
  });

  it("sets unpublished: true", () => {
    expect(buildUseThisData(unpublishedInput()).unpublished).toBe(true);
  });

  it("omits the bytes-location, download, assess, and Zarr sections", () => {
    const model = buildUseThisData(unpublishedInput());
    const ids = model.sections.map((s) => s.id);
    expect(ids).not.toContain("location");
    expect(ids).not.toContain("download");
    expect(ids).not.toContain("assess");
    expect(ids).not.toContain("zarr");
  });

  it("still includes a license section with the always-present self-citation", () => {
    const model = buildUseThisData(unpublishedInput());
    const license = model.sections.find((s) => s.id === "license");
    expect(license?.items.some((i) => i.key === "license-citation")).toBe(true);
  });

  it("markdown says the dataset is not yet published", () => {
    const markdown = renderUseThisDataMarkdown(buildUseThisData(unpublishedInput()));
    expect(markdown).toContain("no published version is available yet");
  });
});

describe("buildUseThisData — unpublished is authoritative over selectedVersion (website#291 fix 2)", () => {
  it("omits location/download/assess/zarr when unpublished even though selectedVersion resolved to a real version", () => {
    // Real captured landing payload (nm000103) with `latest` overridden to
    // null while `versions` stays non-empty -- exactly the shape
    // isUnpublished's `!landing.latest || versions.length === 0` OR exists
    // to catch, and which selectedVersion's own fallback chain
    // (`landing.latest ?? landing.versions[0]?.version`) does not defend
    // against: selectedVersion still resolves to versions[0].version here,
    // so unpublished and selectedVersion diverge unless unpublished is
    // taken as authoritative rather than re-derived from selectedVersion.
    const divergentLanding: LandingPayload = {
      ...(landingNm000103 as LandingPayload),
      latest: null,
    };
    expect(divergentLanding.versions.length).toBeGreaterThan(0);

    const input: UseThisDataInput = {
      ...nm000103(),
      selectedVersion: divergentLanding.versions[0]?.version ?? null,
      unpublished: isUnpublished(divergentLanding),
    };
    // Confirm the divergence this test exists to exercise actually holds.
    expect(input.selectedVersion).not.toBeNull();
    expect(input.unpublished).toBe(true);

    const model = buildUseThisData(input);
    const ids = model.sections.map((s) => s.id);
    expect(ids).not.toContain("location");
    expect(ids).not.toContain("download");
    expect(ids).not.toContain("assess");
    expect(ids).not.toContain("zarr");
  });
});

describe("buildUseThisData — References vs IsReferencedBy (website#286)", () => {
  it("surfaces both References DOIs from nm000103 as citable papers", () => {
    const model = buildUseThisData(nm000103());
    const license = model.sections.find((s) => s.id === "license");
    const refs = license?.items.filter((i) => i.key.startsWith("license-reference-")) ?? [];
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.value)).toContain("https://doi.org/10.1038/sdata.2017.181");
    expect(refs.map((r) => r.value)).toContain("https://doi.org/10.1038/sdata.2017.40");
  });

  it("never surfaces on007753's IsReferencedBy DOIs as citable papers", () => {
    const model = buildUseThisData(on007753());
    const license = model.sections.find((s) => s.id === "license");
    const refs = license?.items.filter((i) => i.key.startsWith("license-reference-")) ?? [];
    expect(refs).toHaveLength(0);

    const markdown = renderUseThisDataMarkdown(model);
    expect(markdown).not.toContain("10.7554/eLife.85012");
    expect(markdown).not.toContain("10.3389/fnins.2013.00267");
    expect(markdown).not.toContain("10.1007/s10579-013-9261-0");
  });
});

describe("buildUseThisData — sparse dataset with nulls (nm000154)", () => {
  it("renders without throwing despite null license and empty authors", () => {
    expect(() => renderUseThisDataMarkdown(buildUseThisData(nm000154()))).not.toThrow();
  });

  it("omits the license item when license is null", () => {
    const model = buildUseThisData(nm000154());
    const license = model.sections.find((s) => s.id === "license");
    expect(license?.items.some((i) => i.key === "license-terms")).toBe(false);
  });

  it("still emits the self-citation even with no authors and no license", () => {
    const model = buildUseThisData(nm000154());
    const license = model.sections.find((s) => s.id === "license");
    const citation = license?.items.find((i) => i.key === "license-citation");
    expect(citation?.value).toContain("on001787");
  });

  it("still surfaces overview facts the catalog row carries (HED version)", () => {
    // nm000154's metadata.json is the sparse half of this fixture (null
    // license, empty authors) but its catalog row still carries a real HED
    // version -- confirms the catalog-row fallback fires even on an
    // otherwise-sparse dataset, rather than the whole row being ignored.
    const model = buildUseThisData(nm000154());
    const overview = model.sections.find((s) => s.id === "overview");
    const hed = overview?.items.find((i) => i.key === "overview-hed-version");
    expect(hed?.value).toBe("8.4.0");
  });

  it("omits BIDS version when metadata.bids_version is null", () => {
    const model = buildUseThisData(nm000154());
    const overview = model.sections.find((s) => s.id === "overview");
    expect(overview?.items.some((i) => i.key === "overview-bids-version")).toBe(false);
  });
});

describe("buildUseThisData — never presents openneuro.org as canonical", () => {
  it("no fixture's markdown output contains openneuro.org", () => {
    for (const input of [nm000103(), on007753(), nm000154()]) {
      const markdown = renderUseThisDataMarkdown(buildUseThisData(input));
      expect(markdown.toLowerCase()).not.toContain("openneuro.org");
    }
  });
});

describe("buildUseThisData — bytes location and download (website#286)", () => {
  it("points at data.nemar.org/<id>/latest/ and the pinned version, never s3://", () => {
    const model = buildUseThisData(nm000103());
    const location = model.sections.find((s) => s.id === "location");
    const values = location?.items.map((i) => i.value) ?? [];
    expect(values).toContain("https://data.nemar.org/nm000103/latest/");
    expect(values).toContain("https://data.nemar.org/nm000103/v2.0.0/");
    for (const v of values) expect(v).not.toContain("s3://");
  });

  it("states the nemar CLI download command and the clone-fetches-no-content caveat", () => {
    const model = buildUseThisData(nm000103());
    const download = model.sections.find((s) => s.id === "download");
    const values = download?.items.map((i) => i.value) ?? [];
    expect(values).toContain("nemar dataset download nm000103");
    expect(values.some((v) => v.includes("nemar dataset clone nm000103"))).toBe(true);
    expect(values.some((v) => v.includes("no file content"))).toBe(true);
  });
});
