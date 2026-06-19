import { describe, expect, it } from "vitest";
import { datasetCitation } from "./cite";

describe("datasetCitation", () => {
  const base = {
    authors: ["Seyed Yahya Shirazi"],
    name: "Research Skills",
    version: "1.0.0",
    date: "2026-06-18T00:00:00Z",
    doi: "10.82901/nemar.on006545",
    id: "on006545",
  };

  it("formats APA with family + initials, version, and DOI url", () => {
    const { apa } = datasetCitation(base);
    expect(apa).toBe(
      "Shirazi, S. Y. (2026). Research Skills (Version 1.0.0) [Data set]. NEMAR. https://doi.org/10.82901/nemar.on006545",
    );
  });

  it("formats BibTeX with a stable key and bare doi", () => {
    const { bibtex } = datasetCitation(base);
    expect(bibtex).toContain("@misc{nemar_on006545,");
    expect(bibtex).toContain("author = {Seyed Yahya Shirazi}");
    expect(bibtex).toContain("version = {1.0.0}");
    expect(bibtex).toContain("doi = {10.82901/nemar.on006545}");
    expect(bibtex).toContain("publisher = {NEMAR}");
  });

  it("joins multiple authors (APA & before last, BibTeX 'and')", () => {
    const c = datasetCitation({ ...base, authors: ["Jane A Smith", "Bo Li"] });
    expect(c.apa).toContain("Smith, J. A., & Li, B. (2026).");
    expect(c.bibtex).toContain("author = {Jane A Smith and Bo Li}");
  });

  it("keeps family-first 'Family, Initials' order (does not reverse it)", () => {
    const c = datasetCitation({ ...base, authors: ["Wakeman, DG", "Henson, RN"] });
    expect(c.apa).toContain("Wakeman, D. G., & Henson, R. N. (2026).");
    expect(c.bibtex).toContain("author = {Wakeman, D. G. and Henson, R. N.}");
  });

  it("handles family-first initials with no comma ('Wakeman DG')", () => {
    const c = datasetCitation({ ...base, authors: ["Wakeman DG"] });
    expect(c.apa).toContain("Wakeman, D. G. (2026).");
    expect(c.bibtex).toContain("author = {Wakeman, D. G.}");
  });

  it("handles a single-token author, no version, no doi, no date", () => {
    const { apa, bibtex } = datasetCitation({
      authors: ["OpenNeuro"],
      name: "Some Dataset",
      version: null,
      date: null,
      doi: null,
      id: "ds000001",
    });
    expect(apa).toBe("OpenNeuro (n.d.). Some Dataset [Data set]. NEMAR.");
    expect(bibtex).not.toContain("version =");
    expect(bibtex).not.toContain("doi =");
  });

  it("strips a doi.org url / doi: prefix to the bare DOI", () => {
    const { apa } = datasetCitation({ ...base, doi: "https://doi.org/10.1/x" });
    expect(apa).toContain("https://doi.org/10.1/x");
    expect(apa).not.toContain("doi.org/https");
  });
});
