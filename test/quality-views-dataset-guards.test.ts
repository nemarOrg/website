/**
 * The dataset document's guards (`dataset-guards.ts`) replay their share of neuroschema's verdict
 * corpus (`kinds-verdicts.v1.json`): every case of the data paper and of the root document. The
 * corpus's `dataQuality` cases are recording entries, read by the per-recording panel (phase W6),
 * and stay counted in `quality-views-guards.test.ts`. The dataset-level `dataQuality` guard has no
 * corpus case and is held to Ajv's verdicts in `quality-summary.test.ts`.
 *
 * Also: a closed object refuses a member named after an `Object.prototype` property, in every
 * guard built on `guards.ts`'s `obj` (a lookup that found the prototype's function let it pass).
 */

import { describe, expect, it } from "vitest";
import {
  dataPaperValid,
  datasetQualityValid,
  documentHeadValid,
} from "../src/lib/quality-views/dataset-guards";
import { declarationValid } from "../src/lib/quality-views/guards";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const read = (path: string) => JSON.parse(fs.readFileSync(repoPath(path), "utf8"));
const corpus = read("test/fixtures/quality-views/vectors/kinds-verdicts.v1.json") as {
  cases: { name: string; covers: string; schema: string; instance: unknown; valid: boolean }[];
};

const GUARDS = {
  "definitions/dataPaper.schema.json": dataPaperValid,
  "neuroschema.schema.json": documentHeadValid,
} as const;

describe("the dataset document's share of the verdict corpus", () => {
  const cases = corpus.cases.filter((c) => c.schema in GUARDS);

  it("has every data paper and root case", () => {
    expect(cases.filter((c) => c.schema === "definitions/dataPaper.schema.json").length).toBe(6);
    expect(cases.filter((c) => c.schema === "neuroschema.schema.json").length).toBe(5);
  });

  it.each(cases.map((c) => [`${c.schema}: ${c.name}`, c] as const))("%s", (_label, c) => {
    expect(GUARDS[c.schema as keyof typeof GUARDS](c.instance), c.covers).toBe(c.valid);
  });

  it("takes a data paper's other members as the schema has them, and nothing else", () => {
    const doi = "10.1038/s41597-019-0027-4";
    expect(
      dataPaperValid({ doi, title: null, year: 2019, venue: "Scientific Data", judge_model: null }),
    ).toBe(true);
    expect(dataPaperValid({ doi, year: 2019.5 })).toBe(false);
    expect(dataPaperValid({ doi, journal: "x" })).toBe(false);
    expect(dataPaperValid({ title: "no doi" })).toBe(false);
  });

  it("checks a dataset's data papers and identity, and a record's", () => {
    const dataset = {
      schema_version: "0.6.0",
      doc_type: "dataset",
      dataset_id: "nm099201",
      name: "n",
      source: "nemar",
      recording_modality: ["EEG"],
    };
    expect(documentHeadValid({ ...dataset, data_papers: [{ doi: "10.1234/abc" }] })).toBe(true);
    expect(documentHeadValid({ ...dataset, data_papers: [{ doi: "10.12/abc" }] })).toBe(false);
    expect(documentHeadValid({ ...dataset, recording_modality: [] })).toBe(false);
    expect(documentHeadValid({ ...dataset, source: "elsewhere" })).toBe(false);
    expect(documentHeadValid({ ...dataset, doc_type: "record" })).toBe(false);
  });
});

describe("a closed object", () => {
  const view = {
    key: "channels",
    kind: "nemar.table",
    kind_version: 1,
    caption: "Channels.",
    source: { recipe: { name: "nemar-floor", version: "1.0.0" } },
    data: [
      {
        role: "table",
        location: "sub-01/eeg/sub-01_channels.tsv",
        format: "tsv",
        size: 10,
        sha256: "a".repeat(64),
        columns: [{ name: "name", type: "string" }],
      },
    ],
  };
  const summary = read("test/fixtures/quality-summary/dataset-quality-verdicts.json").cases[0]
    .document as Record<string, unknown>;

  it.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"])(
    "refuses a member named %s",
    (name) => {
      expect(declarationValid(view)).toBe(true);
      expect(datasetQualityValid(summary)).toBe(true);
      const withMember = (o: object) =>
        Object.defineProperty({ ...o }, name, { value: 1, enumerable: true });
      expect(declarationValid(withMember(view))).toBe(false);
      expect(datasetQualityValid(withMember(summary))).toBe(false);
      expect(dataPaperValid(withMember({ doi: "10.1234/abc" }))).toBe(false);
    },
  );
});
