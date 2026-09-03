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
import {
  type DatasetJsonLdInput,
  type JsonLdCatalogRow,
  buildDatasetJsonLd,
  datasetJsonLdScript,
  escapeJsonLdForScript,
} from "./jsonld";
import type { LandingPayload, NeuroschemaDataset } from "./neuroschema";
import { detectProvenance } from "./provenance";

// The three real captures below (2026-07-29, production api.nemar.org /
// data.nemar.org) cover the dataset shapes this builder has to handle:
//  - nm000103: NEMAR-native, fully populated (license, DOI, 8 authors with
//    ORCID, keywords, References + IsIdenticalTo related identifiers).
//  - on007753: OpenNeuro-derived (IsDerivedFrom -> isBasedOn), CC0, and
//    related_identifiers that are ALL "IsReferencedBy" (papers that cite
//    this dataset) rather than "References" (papers to cite when using
//    it) -- exercises the deliberate exclusion documented in jsonld.ts.
//  - nm000154: the sparse real-world case -- null description, null
//    license, empty authors/keywords/related_identifiers. As of this
//    capture every legacy OpenNeuro pointer in the catalog has already
//    been mirrored to an on* id with an EZID concept DOI minted at
//    creation, so no live ds*-only (no-mirror, no-DOI) dataset page
//    currently exists to capture -- see the PR description. This fixture
//    is the closest real analogue to the "ds*/unsynced on*" null-safety
//    contract AGENTS.md describes, and covers "missing license" for free.

function realInput(
  metadata: NeuroschemaDataset,
  landing: LandingPayload,
  catalogRow: JsonLdCatalogRow | null,
  overrides: Partial<DatasetJsonLdInput> = {},
): DatasetJsonLdInput {
  const selectedVersion = landing.latest ?? landing.versions[0]?.version ?? null;
  return {
    id: metadata.dataset_id,
    metadata,
    catalogRow,
    selectedVersion,
    provenance: detectProvenance(metadata, landing),
    pageUrl: `https://nemar.org/dataset/${metadata.dataset_id}`,
    dataBase: "https://data.nemar.org",
    ...overrides,
  };
}

// `as unknown as NeuroschemaDataset`: real captured payloads don't fully
// satisfy the declared type (two confirmed drifts, see PR description) --
// `keywords` ships as `{term}[]` objects, not `string[]` as declared (the
// same drift DetailRail.astro already works around with a runtime check),
// and `authors[].orcid`/`.affiliations` are sometimes absent entirely
// rather than present-and-null. The builder's own field access is already
// defensive against both; the cast just lets the fixture stand in for the
// type without rewriting the (shared, other-code-depended-on) declaration.
const nm000103 = () =>
  realInput(
    metadataNm000103 as unknown as NeuroschemaDataset,
    landingNm000103 as LandingPayload,
    catalogNm000103 as unknown as JsonLdCatalogRow,
  );
const on007753 = () =>
  realInput(
    metadataOn007753 as unknown as NeuroschemaDataset,
    landingOn007753 as LandingPayload,
    catalogOn007753 as unknown as JsonLdCatalogRow,
  );
const nm000154 = () =>
  realInput(
    metadataNm000154 as unknown as NeuroschemaDataset,
    landingNm000154 as LandingPayload,
    catalogNm000154 as unknown as JsonLdCatalogRow,
  );

describe("buildDatasetJsonLd — fully-populated nm* dataset (nm000103)", () => {
  const jsonld = buildDatasetJsonLd(nm000103());

  it("sets the required schema.org envelope", () => {
    expect(jsonld["@context"]).toBe("https://schema.org");
    expect(jsonld["@type"]).toBe("Dataset");
    expect(jsonld.name).toBe("Healthy Brain Network EEG - Not for Commercial Use");
    expect(jsonld.alternateName).toBe("nm000103");
    expect(jsonld.url).toBe("https://nemar.org/dataset/nm000103");
  });

  it("uses the NEMAR-minted concept DOI as identifier", () => {
    expect(jsonld.identifier).toBe("https://doi.org/10.82901/nemar.nm000103");
  });

  it("maps the free-text license to a canonical CC URL and flags non-commercial access", () => {
    expect(jsonld.license).toBe("https://creativecommons.org/licenses/by-nc-sa/4.0/");
    expect(jsonld.conditionsOfAccess).toBe("Non-commercial use only (CC-BY-NC-SA 4.0).");
  });

  it("lists every author as a Person with an ORCID sameAs", () => {
    const creators = jsonld.creator as Array<{ "@type": string; name: string; sameAs?: string }>;
    expect(creators).toHaveLength(8);
    expect(creators[0]).toEqual({
      "@type": "Person",
      name: "Seyed Yahya Shirazi",
      sameAs: "https://orcid.org/0000-0001-5557-259X",
    });
  });

  it("citation includes the self-citation plus the two Data Descriptor DOIs", () => {
    const citations = jsonld.citation as string[];
    expect(citations).toHaveLength(3);
    expect(citations[0]).toContain("Healthy Brain Network EEG");
    expect(citations).toContain("https://doi.org/10.1038/sdata.2017.181");
    expect(citations).toContain("https://doi.org/10.1038/sdata.2017.40");
  });

  it("maps recording_modality to a single measurementTechnique string", () => {
    expect(jsonld.measurementTechnique).toBe("Electroencephalography (EEG)");
  });

  it("carries every keyword term", () => {
    expect(jsonld.keywords).toEqual([
      "EEG",
      "child and adolescent mental health",
      "neurodevelopment",
      "behavioral assessment",
      "hierarchical event descriptors",
      "internalizing and externalizing behaviors",
      "HED",
      "Healthy Brain Network",
    ]);
  });

  it("always sets includedInDataCatalog to NEMAR at the marketing origin", () => {
    expect(jsonld.includedInDataCatalog).toEqual({
      "@type": "DataCatalog",
      name: "NEMAR",
      url: "https://nemar.org",
    });
  });

  it("omits isBasedOn for a NEMAR-native dataset", () => {
    expect(jsonld.isBasedOn).toBeUndefined();
  });

  it("surfaces the IsIdenticalTo Zenodo DOI as sameAs", () => {
    expect(jsonld.sameAs).toEqual(["https://doi.org/10.5281/zenodo.17306881"]);
  });

  it("builds a distribution routed through data.nemar.org/<id>/<version>/", () => {
    const dist = (jsonld.distribution as Array<Record<string, unknown>>)[0];
    expect(dist["@type"]).toBe("DataDownload");
    expect(dist.contentUrl).toBe("https://data.nemar.org/nm000103/v2.0.0/");
    expect(dist.encodingFormat).toBe("https://bids.neuroimaging.io");
    expect(dist.contentSize).toBe("250 GB");
    expect(dist.description).toContain("nemar dataset download nm000103");
    expect(dist.description).toContain("nemar dataset clone nm000103");
  });

  it("sets version and datePublished", () => {
    expect(jsonld.version).toBe("v2.0.0");
    expect(jsonld.datePublished).toBe(new Date("2026-02-23T07:49:00").toISOString());
  });

  it("produces JSON that parses back to the same object", () => {
    const script = datasetJsonLdScript(nm000103());
    expect(JSON.parse(script)).toEqual(jsonld);
  });
});

describe("buildDatasetJsonLd — OpenNeuro-derived on* dataset (on007753)", () => {
  const jsonld = buildDatasetJsonLd(on007753());

  it("resolves isBasedOn to the specific OpenNeuro source dataset, not a generic homepage link", () => {
    expect(jsonld.isBasedOn).toBe("https://openneuro.org/datasets/ds007753");
  });

  it("maps CC0 to the public-domain URL with no conditionsOfAccess", () => {
    expect(jsonld.license).toBe("https://creativecommons.org/publicdomain/zero/1.0/");
    expect(jsonld.conditionsOfAccess).toBeUndefined();
  });

  it("does NOT surface IsReferencedBy DOIs as citation (they cite the dataset, not the other way around)", () => {
    const citations = jsonld.citation as string[];
    expect(citations).toHaveLength(1); // self-citation only
    expect(citations.join(" ")).not.toContain("10.7554/eLife.85012");
    expect(citations.join(" ")).not.toContain("10.3389/fnins.2013.00267");
  });

  it("omits sameAs when there is no IsIdenticalTo related identifier", () => {
    expect(jsonld.sameAs).toBeUndefined();
  });

  it("still builds creators from metadata.authors even without an orcid field on each entry", () => {
    const creators = jsonld.creator as Array<{ name: string; sameAs?: string }>;
    expect(creators).toHaveLength(6);
    expect(creators[0]).toEqual({ "@type": "Person", name: "Yushi Sugimoto" });
    expect(creators[0].sameAs).toBeUndefined();
  });
});

describe("buildDatasetJsonLd — sparse real dataset with nulls (nm000154)", () => {
  const jsonld = buildDatasetJsonLd(nm000154());

  it("never throws and still emits the required envelope", () => {
    expect(jsonld["@context"]).toBe("https://schema.org");
    expect(jsonld["@type"]).toBe("Dataset");
    expect(jsonld.name).toBe("on001787");
  });

  it("omits description when metadata.description is null", () => {
    expect(jsonld.description).toBeUndefined();
  });

  it("omits license and conditionsOfAccess when license is null", () => {
    expect(jsonld.license).toBeUndefined();
    expect(jsonld.conditionsOfAccess).toBeUndefined();
  });

  it("falls back to the catalog row's authors when metadata.authors is empty", () => {
    // metadata.json ships authors: [], and the catalog row's authors string
    // is also null for this dataset -- both empty, so creator is omitted
    // entirely rather than emitted as [].
    expect(jsonld.creator).toBeUndefined();
  });

  it("omits keywords, citation extras, and sameAs when the arrays are empty", () => {
    expect(jsonld.keywords).toBeUndefined();
    expect(jsonld.sameAs).toBeUndefined();
  });

  it("still emits identifier + citation from the DOI catalog rows always carry", () => {
    expect(jsonld.identifier).toBe("https://doi.org/10.82901/nemar.nm000154");
    expect(jsonld.citation).toEqual([
      expect.stringContaining("on001787"), // self-citation, author-less APA form
    ]);
  });

  it("still emits distribution from data_summary.size_human", () => {
    const dist = (jsonld.distribution as Array<Record<string, unknown>>)[0];
    expect(dist.contentUrl).toBe("https://data.nemar.org/nm000154/v1.0.0/");
    expect(dist.contentSize).toBe("5.69 GB");
  });

  it("round-trips through JSON.stringify + escaping without throwing", () => {
    expect(() => datasetJsonLdScript(nm000154())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Synthetic edge cases the current production catalog has no live example
// of. As of this capture (2026-07-29) every legacy `ds*` pointer has been
// mirrored to an `on*` id with a concept DOI minted by EZID at creation
// time, so "no DOI at all" cannot currently be captured from a real
// response. These inputs are hand-built against the documented
// NeuroschemaDataset contract (optional/nullable fields per lib/neuroschema.ts
// and AGENTS.md's null-safety guarantees), the same way provenance.test.ts's
// `meta()` helper and cite.test.ts's `ds000001`/no-doi case already do.
// ---------------------------------------------------------------------------

function minimalMetadata(over: Partial<NeuroschemaDataset> = {}): NeuroschemaDataset {
  return {
    schema_version: "0.3.0",
    doc_type: "dataset",
    dataset_id: "ds000001",
    name: "Minimal Dataset",
    description: null,
    source: "openneuro",
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
    ...over,
  };
}

function minimalInput(overrides: Partial<DatasetJsonLdInput> = {}): DatasetJsonLdInput {
  return {
    id: "ds000001",
    metadata: minimalMetadata(),
    catalogRow: null,
    selectedVersion: null,
    provenance: { kind: "native" },
    pageUrl: "https://nemar.org/dataset/ds000001",
    dataBase: "https://data.nemar.org",
    ...overrides,
  };
}

describe("buildDatasetJsonLd — missing DOI", () => {
  it("omits identifier entirely rather than emitting null or an empty string", () => {
    const jsonld = buildDatasetJsonLd(minimalInput());
    expect(jsonld.identifier).toBeUndefined();
    expect("identifier" in jsonld).toBe(false);
  });

  it("still emits a self-citation with no DOI url appended", () => {
    // No authors and no doi -> datasetCitation's "no authors, no doi, no
    // date" branch (mirrors cite.test.ts's OpenNeuro/ds000001 case).
    const jsonld = buildDatasetJsonLd(minimalInput());
    const citations = jsonld.citation as string[];
    expect(citations).toEqual(["(n.d.). Minimal Dataset [Data set]. NEMAR."]);
  });

  it("omits version and distribution when unpublished (no selectedVersion)", () => {
    const jsonld = buildDatasetJsonLd(minimalInput());
    expect(jsonld.version).toBeUndefined();
    expect(jsonld.distribution).toBeUndefined();
  });

  it("never throws for a fully-empty dataset", () => {
    expect(() => buildDatasetJsonLd(minimalInput())).not.toThrow();
    expect(() => datasetJsonLdScript(minimalInput())).not.toThrow();
  });
});

// website#209: conditionsOfAccess only branched on "noncommercial" and
// "noderiv", silently dropping the note for a pure share-alike license
// (CC-BY-SA) even though licenseTier (./tags.ts) already classifies it as
// its own "sharealike" tier. One case per tier licenseTier recognizes,
// covering both the combined-clause ordering (most restrictive marker wins,
// per licenseTier's own doc comment) and the two tiers that carry no
// conditionsOfAccess note at all.
describe("conditionsOfAccess by license tier (website#209)", () => {
  const withLicense = (license: string) =>
    buildDatasetJsonLd(minimalInput({ metadata: minimalMetadata({ license }) }));

  it("CC-BY: attribution tier, no conditionsOfAccess note", () => {
    const jsonld = withLicense("CC-BY 4.0");
    expect(jsonld.conditionsOfAccess).toBeUndefined();
  });

  it("CC-BY-SA: sharealike tier, notes derivatives must keep the same license", () => {
    const jsonld = withLicense("CC-BY-SA 4.0");
    expect(jsonld.license).toBe("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(jsonld.conditionsOfAccess).toBe(
      "Derivatives must be shared under the same license (CC-BY-SA 4.0).",
    );
  });

  it("CC-BY-NC: noncommercial tier", () => {
    const jsonld = withLicense("CC-BY-NC 4.0");
    expect(jsonld.license).toBe("https://creativecommons.org/licenses/by-nc/4.0/");
    expect(jsonld.conditionsOfAccess).toBe("Non-commercial use only (CC-BY-NC 4.0).");
  });

  it("CC-BY-NC-SA: the noncommercial marker wins over share-alike (most restrictive first)", () => {
    const jsonld = withLicense("CC-BY-NC-SA 4.0");
    expect(jsonld.license).toBe("https://creativecommons.org/licenses/by-nc-sa/4.0/");
    expect(jsonld.conditionsOfAccess).toBe("Non-commercial use only (CC-BY-NC-SA 4.0).");
  });

  it("CC-BY-ND: noderiv tier", () => {
    const jsonld = withLicense("CC-BY-ND 4.0");
    expect(jsonld.license).toBe("https://creativecommons.org/licenses/by-nd/4.0/");
    expect(jsonld.conditionsOfAccess).toBe("No derivative works permitted (CC-BY-ND 4.0).");
  });

  it("CC-BY-NC-ND: the noderiv marker wins over noncommercial (most restrictive first)", () => {
    const jsonld = withLicense("CC-BY-NC-ND 4.0");
    expect(jsonld.license).toBe("https://creativecommons.org/licenses/by-nc-nd/4.0/");
    expect(jsonld.conditionsOfAccess).toBe("No derivative works permitted (CC-BY-NC-ND 4.0).");
  });

  it("CC0 / PDDL: public-domain tier, no conditionsOfAccess note", () => {
    const cc0 = withLicense("CC0 1.0");
    expect(cc0.license).toBe("https://creativecommons.org/publicdomain/zero/1.0/");
    expect(cc0.conditionsOfAccess).toBeUndefined();

    const pddl = withLicense("PDDL 1.0");
    expect(pddl.conditionsOfAccess).toBeUndefined();
  });
});

describe("escapeJsonLdForScript — </script> and HTML breakout", () => {
  it("escapes < so </script> cannot appear in the output", () => {
    const hostile = "</script><script>alert(document.cookie)</script>";
    const escaped = escapeJsonLdForScript(JSON.stringify({ name: hostile }));
    expect(escaped.toLowerCase()).not.toContain("</script");
    expect(escaped).not.toContain("<");
  });

  it("escapes a lone < with no closing tag", () => {
    const escaped = escapeJsonLdForScript(JSON.stringify({ name: "5 < 10" }));
    expect(escaped).not.toContain("<");
    expect(escaped).toContain("\\u003c");
  });

  it("escapes >, &, U+2028, and U+2029 as defense in depth", () => {
    const escaped = escapeJsonLdForScript(JSON.stringify({ name: "a > b & c d e" }));
    expect(escaped).not.toContain(">");
    expect(escaped).not.toContain("&");
    expect(escaped).not.toContain(" ");
    expect(escaped).not.toContain(" ");
  });

  it("round-trips through JSON.parse back to the exact original string", () => {
    const hostile = 'Weird "</script><script>alert(1)</script>" Name <b>bold</b> & Co';
    const escaped = escapeJsonLdForScript(JSON.stringify({ name: hostile }));
    const parsed = JSON.parse(escaped) as { name: string };
    expect(parsed.name).toBe(hostile);
  });

  it("leaves ordinary text untouched", () => {
    const escaped = escapeJsonLdForScript(JSON.stringify({ name: "Plain EEG dataset" }));
    expect(escaped).toBe('{"name":"Plain EEG dataset"}');
  });
});

describe("datasetJsonLdScript — end-to-end escaping with a hostile dataset name", () => {
  it("a dataset name/description containing </script> cannot break out when embedded", () => {
    const input = minimalInput({
      metadata: minimalMetadata({
        name: "Evil</script><script>alert(1)</script>Dataset",
        description: "Contains a < sign and a </script> sequence and an & ampersand",
      }),
    });
    const script = datasetJsonLdScript(input);

    // Simulate embedding: this is exactly what Base.astro's `set:html` does.
    const html = `<script type="application/ld+json">${script}</script>`;
    // The only "</script>" substring in the whole embedded HTML must be the
    // one real closing tag our test harness added at the very end.
    const occurrences = html.toLowerCase().split("</script>").length - 1;
    expect(occurrences).toBe(1);

    // And the payload still parses back to the real hostile strings.
    const parsed = JSON.parse(script) as { name: string; description: string };
    expect(parsed.name).toBe("Evil</script><script>alert(1)</script>Dataset");
    expect(parsed.description).toBe(
      "Contains a < sign and a </script> sequence and an & ampersand",
    );
  });
});
