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
import type { Author, LandingPayload, NeuroschemaDataset } from "./neuroschema";
import {
  MAX_SIGNPOSTING_AUTHORS,
  type SignpostingCatalogRow,
  type SignpostingInput,
  type SignpostingLink,
  buildSignposting,
  signpostingLinkHeader,
} from "./signposting";

// Same three real captures jsonld.test.ts and use-this-data.test.ts use
// (2026-07-29, production api.nemar.org / data.nemar.org):
//  - nm000103: fully populated (concept DOI, CC-BY-NC-SA license, 8 authors
//    all carrying an ORCID, published version v2.0.0).
//  - on007753: OpenNeuro-derived, CC0, authors with NO orcid field at all.
//  - nm000154: sparse -- null license, empty authors, still a real
//    concept DOI and a published version.

function realInput(
  metadata: NeuroschemaDataset,
  landing: LandingPayload,
  catalogRow: SignpostingCatalogRow | null,
  overrides: Partial<SignpostingInput> = {},
): SignpostingInput {
  const selectedVersion = landing.latest ?? landing.versions[0]?.version ?? null;
  return {
    id: metadata.dataset_id,
    metadata,
    catalogRow,
    selectedVersion,
    dataBase: "https://data.nemar.org",
    apiBase: "https://api.nemar.org",
    ...overrides,
  };
}

const nm000103 = () =>
  realInput(
    metadataNm000103 as unknown as NeuroschemaDataset,
    landingNm000103 as LandingPayload,
    catalogNm000103 as unknown as SignpostingCatalogRow,
  );
const on007753 = () =>
  realInput(
    metadataOn007753 as unknown as NeuroschemaDataset,
    landingOn007753 as LandingPayload,
    catalogOn007753 as unknown as SignpostingCatalogRow,
  );
const nm000154 = () =>
  realInput(
    metadataNm000154 as unknown as NeuroschemaDataset,
    landingNm000154 as LandingPayload,
    catalogNm000154 as unknown as SignpostingCatalogRow,
  );

describe("buildSignposting / signpostingLinkHeader — never throws on real fixtures", () => {
  it("builds and serializes all three real fixtures without throwing", () => {
    for (const input of [nm000103(), on007753(), nm000154()]) {
      expect(() => signpostingLinkHeader(buildSignposting(input))).not.toThrow();
    }
  });

  it("nm000154 (sparse: null license, empty authors) still builds a non-empty link set", () => {
    const links = buildSignposting(nm000154());
    // describedby x2 + type x2 are unconditional, so even the sparsest real
    // fixture still yields relations.
    expect(links.length).toBeGreaterThanOrEqual(4);
  });
});

describe("buildSignposting — cite-as", () => {
  it("uses the concept DOI, not a version DOI", () => {
    const links = buildSignposting(nm000103());
    const citeAs = links.find((l) => l.rel === "cite-as");
    expect(citeAs?.href).toBe("https://doi.org/10.82901/nemar.nm000103");
    // The version DOI (what cite-as must NOT point at).
    expect(citeAs?.href).not.toBe("https://doi.org/10.82901/nemar.nm000103.v2.0.0");
  });

  it("falls back to metadata.external_links.dataset_doi when there is no catalog row", () => {
    const input = nm000103();
    const links = buildSignposting({ ...input, catalogRow: null });
    const citeAs = links.find((l) => l.rel === "cite-as");
    expect(citeAs?.href).toBe("https://doi.org/10.82901/nemar.nm000103");
  });

  it("omits cite-as entirely when there is no DOI anywhere", () => {
    const input = nm000103();
    const links = buildSignposting({
      ...input,
      catalogRow: null,
      metadata: { ...input.metadata, external_links: { dataset_doi: null, github_url: null } },
    });
    expect(links.find((l) => l.rel === "cite-as")).toBeUndefined();
  });
});

describe("buildSignposting — describedby", () => {
  it("emits both machine-readable descriptions with application/json media type", () => {
    const links = buildSignposting(nm000103());
    const described = links.filter((l) => l.rel === "describedby");
    expect(described).toHaveLength(2);
    expect(described.every((l) => l.type === "application/json")).toBe(true);
    expect(described.map((l) => l.href)).toEqual([
      "https://data.nemar.org/nm000103/metadata.json",
      "https://api.nemar.org/datasets/nm000103",
    ]);
  });

  it("strips a trailing slash from dataBase/apiBase before composing the URL", () => {
    const input = nm000103();
    const links = buildSignposting({
      ...input,
      dataBase: "https://data.nemar.org/",
      apiBase: "https://api.nemar.org/",
    });
    const described = links.filter((l) => l.rel === "describedby");
    expect(described.map((l) => l.href)).toEqual([
      "https://data.nemar.org/nm000103/metadata.json",
      "https://api.nemar.org/datasets/nm000103",
    ]);
  });
});

describe("buildSignposting — item (unpublished gating)", () => {
  it("points at the selected version's browsable root for a published dataset", () => {
    const links = buildSignposting(nm000103());
    const item = links.find((l) => l.rel === "item");
    expect(item?.href).toBe("https://data.nemar.org/nm000103/v2.0.0/");
  });

  function unpublishedInput(): SignpostingInput {
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
      dataBase: "https://data.nemar.org",
      apiBase: "https://api.nemar.org",
    };
  }

  it("omits item entirely for an unpublished dataset (selectedVersion null)", () => {
    const links = buildSignposting(unpublishedInput());
    expect(links.find((l) => l.rel === "item")).toBeUndefined();
  });

  it("still emits describedby and type for an unpublished, fully-empty dataset", () => {
    const links = buildSignposting(unpublishedInput());
    expect(links.filter((l) => l.rel === "describedby")).toHaveLength(2);
    expect(links.filter((l) => l.rel === "type")).toHaveLength(2);
  });

  it("never throws building or serializing the unpublished, fully-empty dataset", () => {
    expect(() => signpostingLinkHeader(buildSignposting(unpublishedInput()))).not.toThrow();
  });
});

describe("buildSignposting — license", () => {
  it("emits a license relation when the license string resolves to a CC URL", () => {
    const links = buildSignposting(nm000103());
    const license = links.find((l) => l.rel === "license");
    expect(license?.href).toBe("https://creativecommons.org/licenses/by-nc-sa/4.0/");
  });

  it("omits license when metadata.license is null (nm000154, real)", () => {
    const links = buildSignposting(nm000154());
    expect(links.find((l) => l.rel === "license")).toBeUndefined();
  });

  it("omits license for a free-text (non-URI) license string", () => {
    // nm000154 ships a null license; override that one field on the real
    // fixture to a free-text license string that ccLicenseUrl cannot map to
    // a URI (unlike "CC-BY-NC-SA 4.0", which does resolve).
    const input = nm000154();
    const links = buildSignposting({
      ...input,
      metadata: { ...input.metadata, license: "CDLA-Permissive-2.0" },
    });
    expect(links.find((l) => l.rel === "license")).toBeUndefined();
    // Confirm the free-text string itself never leaks out as an href.
    expect(links.some((l) => l.href.includes("CDLA"))).toBe(false);
  });
});

describe("buildSignposting — type", () => {
  it("always declares both schema.org classes, with no media type attribute", () => {
    const links = buildSignposting(nm000103());
    const types = links.filter((l) => l.rel === "type");
    expect(types.map((l) => l.href)).toEqual([
      "https://schema.org/Dataset",
      "https://schema.org/AboutPage",
    ]);
    expect(types.every((l) => l.type === undefined)).toBe(true);
  });
});

describe("buildSignposting — author (bounded)", () => {
  it("emits one author relation per ORCID-bearing author (nm000103, 8 authors)", () => {
    const links = buildSignposting(nm000103());
    const authors = links.filter((l) => l.rel === "author");
    expect(authors).toHaveLength(8);
    expect(authors[0]?.href).toBe("https://orcid.org/0000-0001-5557-259X");
  });

  it("emits zero author relations when no author carries an ORCID (on007753, real)", () => {
    const links = buildSignposting(on007753());
    expect(links.filter((l) => l.rel === "author")).toHaveLength(0);
  });

  it("caps author relations at MAX_SIGNPOSTING_AUTHORS given more authors than the bound", () => {
    const input = nm000103();
    const manyAuthors: Author[] = Array.from(
      { length: MAX_SIGNPOSTING_AUTHORS + 15 },
      (_, i): Author => ({
        name: `Consortium Member ${i}`,
        name_type: "Personal",
        orcid: `0000-0000-0000-${String(i).padStart(4, "0")}`,
        affiliations: [],
      }),
    );
    const links = buildSignposting({
      ...input,
      metadata: { ...input.metadata, authors: manyAuthors },
    });
    const authors = links.filter((l) => l.rel === "author");
    expect(authors).toHaveLength(MAX_SIGNPOSTING_AUTHORS);
    expect(authors[0]?.href).toBe("https://orcid.org/0000-0000-0000-0000");
    expect(authors[MAX_SIGNPOSTING_AUTHORS - 1]?.href).toBe(
      `https://orcid.org/0000-0000-0000-${String(MAX_SIGNPOSTING_AUTHORS - 1).padStart(4, "0")}`,
    );
  });

  it("skips authors with a null or blank orcid rather than emitting a broken link", () => {
    const input = nm000103();
    const authors: Author[] = [
      { name: "No Orcid", name_type: "Personal", orcid: null, affiliations: [] },
      { name: "Blank Orcid", name_type: "Personal", orcid: "   ", affiliations: [] },
      { name: "Real Orcid", name_type: "Personal", orcid: "0000-0001-5557-259X", affiliations: [] },
    ];
    const links = buildSignposting({ ...input, metadata: { ...input.metadata, authors } });
    const authorLinks = links.filter((l) => l.rel === "author");
    expect(authorLinks).toHaveLength(1);
    expect(authorLinks[0]?.href).toBe("https://orcid.org/0000-0001-5557-259X");
  });
});

describe("signpostingLinkHeader — RFC 8288 serialization", () => {
  it("serializes a handful of relations into one valid, correctly quoted Link field value", () => {
    const links: SignpostingLink[] = [
      { rel: "cite-as", href: "https://doi.org/10.82901/nemar.nm000103" },
      {
        rel: "describedby",
        href: "https://data.nemar.org/nm000103/metadata.json",
        type: "application/json",
      },
      { rel: "type", href: "https://schema.org/Dataset" },
    ];
    expect(signpostingLinkHeader(links)).toBe(
      '<https://doi.org/10.82901/nemar.nm000103>; rel="cite-as", ' +
        '<https://data.nemar.org/nm000103/metadata.json>; rel="describedby"; type="application/json", ' +
        '<https://schema.org/Dataset>; rel="type"',
    );
  });

  it("returns a single line with no embedded newlines for a full real dataset", () => {
    const header = signpostingLinkHeader(buildSignposting(nm000103()));
    expect(header.split("\n")).toHaveLength(1);
    expect(header.length).toBeGreaterThan(0);
  });

  it("emits exactly one comma-separated entry per link, matching rel= occurrence count", () => {
    const links = buildSignposting(nm000103());
    const header = signpostingLinkHeader(links);
    const relMatches = header.match(/rel="/g) ?? [];
    expect(relMatches).toHaveLength(links.length);
  });

  it("every entry is wrapped in angle brackets with a quoted rel", () => {
    const header = signpostingLinkHeader(buildSignposting(nm000103()));
    for (const entry of header.split(", ")) {
      expect(entry).toMatch(/^<[^<>]+>; rel="[a-z-]+"(; type="[^"]+")?$/);
    }
  });

  it("returns an empty string for an empty link list", () => {
    expect(signpostingLinkHeader([])).toBe("");
  });
});
