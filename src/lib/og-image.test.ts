import { describe, expect, it } from "vitest";
import { buildDatasetOgModel, renderDatasetOgSvg } from "./og-image";

describe("buildDatasetOgModel", () => {
  it("prefers neuroschema title/authors/modalities and uses catalog facts for subjects and size", () => {
    const model = buildDatasetOgModel({
      id: "on002578",
      metadata: {
        name: "Visual Oddball Task",
        description: "EEG recordings for a visual oddball paradigm.",
        recording_modality: ["EEG"],
        data_summary: { participant_count: 99 },
        authors: [
          {
            name: "Arnaud Delorme",
            name_type: "Personal",
            orcid: null,
            affiliations: [],
          },
        ],
      },
      catalog: {
        dataset_id: "on002578",
        id: "on002578",
        name: "Catalog fallback",
        description: null,
        authors: "Catalog Author, Second Author",
        modalities: "MEG",
        participants: 24,
        file_size: 12884901888,
        file_size_formatted: "12 GB",
      },
    });

    expect(model).toMatchObject({
      id: "on002578",
      title: "Visual Oddball Task",
      firstAuthor: "Arnaud Delorme",
      subjects: "24",
      size: "12.0 GB",
      modalities: ["EEG"],
    });
  });

  it("falls back gracefully for sparse catalog-only rows", () => {
    const model = buildDatasetOgModel({
      id: "on005262",
      catalog: {
        dataset_id: "on005262",
        id: "on005262",
        name: "Sparse OpenNeuro Mirror",
        description: "",
        authors: "",
        modalities: "",
        participants: 0,
        file_size: 0,
        file_size_formatted: "",
      },
    });

    expect(model.title).toBe("Sparse OpenNeuro Mirror");
    expect(model.firstAuthor).toBe("Unavailable");
    expect(model.subjects).toBe("Unavailable");
    expect(model.size).toBe("Unavailable");
    expect(model.modalities).toEqual([]);
  });

  it("uses backend metadata summary keys when the catalog has no subject count", () => {
    const model = buildDatasetOgModel({
      id: "on000200",
      metadata: {
        name: "Metadata Summary Dataset",
        description: null,
        recording_modality: [],
        authors: [],
        data_summary: { counts: { subject_count: 42 } },
      },
      catalog: {
        dataset_id: "on000200",
        id: "on000200",
        name: "Metadata Summary Dataset",
        description: null,
        authors: "",
        modalities: "eeg",
        participants: 0,
        file_size: 1024,
        file_size_formatted: "",
      },
    });

    expect(model.subjects).toBe("42");
  });
});

describe("renderDatasetOgSvg", () => {
  it("escapes dataset text before inserting it into SVG", () => {
    const svg = renderDatasetOgSvg(
      {
        id: "on000001",
        title: "Resting <EEG> & Attention",
        description: 'A "quoted" description with <tags>.',
        firstAuthor: "A. Researcher & Co",
        subjects: "12",
        size: "1.5 GB",
        modalities: ["EEG"],
      },
      '<svg viewBox="0 0 10 10"></svg>',
    );

    expect(svg).toContain("Resting &lt;EEG&gt; &amp; Attention");
    expect(svg).toContain("A. Researcher &amp; Co");
    expect(svg).not.toContain("Resting <EEG>");
    expect(svg).toContain('width="1200" height="800"');
  });

  it("bakes light logo colors into the embedded card logo", () => {
    const svg = renderDatasetOgSvg(
      {
        id: "on000001",
        title: "Resting EEG",
        description: "",
        firstAuthor: "A. Researcher",
        subjects: "12",
        size: "1.5 GB",
        modalities: ["EEG"],
      },
      '<svg viewBox="0 0 10 10"><g fill="var(--brand-accent, currentColor)"></g><g fill="var(--brand-electrode, currentColor)"></g></svg>',
    );

    expect(svg).toContain('style="color:#f8fafc"');
    expect(svg).toContain('fill="#5bbad5"');
    expect(svg).toContain('fill="#f4d06b"');
    expect(svg).not.toContain("var(--brand-accent");
    expect(svg).not.toContain("var(--brand-electrode");
  });

  it("renders the enlarged id pill and modality chip geometry", () => {
    const svg = renderDatasetOgSvg(
      {
        id: "nm000132",
        title: "ERP CORE",
        description: "",
        firstAuthor: "A. Researcher",
        subjects: "40",
        size: "17.5 GB",
        modalities: ["EEG"],
      },
      '<svg viewBox="0 0 10 10"></svg>',
    );
    // id pill + text, enlarged from 66/33/25px to 72/36/34px.
    expect(svg).toContain('width="280" height="72" rx="36"');
    expect(svg).toContain('font-size="34" font-weight="700" fill="#f8fafc">nm000132<');
    // modality chip, enlarged to height 60 / rx 30 / 28px text.
    expect(svg).toContain('height="60" rx="30"');
    expect(svg).toContain('font-size="28" font-weight="700" fill="#f8fafc">EEG<');
  });
});
