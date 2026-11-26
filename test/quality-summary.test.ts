/**
 * The dataset quality summary (`dataset-summary.ts`, drawn by DatasetQualitySummary.astro), over
 * fixtures captured from nemar-cli's real metadata route and checks
 * (`scripts/capture-quality-summary-fixtures.mjs`):
 *
 * - the guard reproduces Ajv's verdict and the backend's writer rule on every captured document;
 * - a summary shows only for a dataset the backend serves one for, and the page's own gate holds
 *   when a document does not say it is not anonymous;
 * - a summary refused by a check draws nothing, and says why in one sentence;
 * - every number printed is a stored value's text, and the counts are the stored counts;
 * - each histogram's text alternative names every bar, and the tree is accessible.
 */

import { describe, expect, it } from "vitest";
import {
  type DatasetRecipeSummary,
  datasetQualityValid,
  writerRuleBroken,
} from "../src/lib/quality-views/dataset-guards";
import {
  type QualitySummary,
  SUMMARY_SENTENCES,
  metricLabel,
  readQualitySummary,
  summaryTree,
} from "../src/lib/quality-views/dataset-summary";
import { numberText } from "../src/lib/quality-views/read";
import { type Child, type Element, textOf, toHtml, walk } from "../src/lib/quality-views/tree";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const read = (path: string) => JSON.parse(fs.readFileSync(repoPath(path), "utf8"));
const DIR = "test/fixtures/quality-summary";

interface Captured {
  _provenance: { route: string };
  status: number;
  text: string;
}
const captured = (name: string): Captured => read(`${DIR}/metadata-${name}.json`);
const idOf = (c: Captured) => /GET \/([a-z]{2}[0-9]+)\//.exec(c._provenance.route)![1];
// biome-ignore lint/suspicious/noExplicitAny: documents are read member by member
type Loose = Record<string, any>;
const documentOf = (name: string): Loose => JSON.parse(captured(name).text);

function summaryOf(name: string): QualitySummary {
  const c = captured(name);
  return readQualitySummary(JSON.parse(c.text), idOf(c));
}

/** The text a tree shows and its text alternatives: what a reader sees or hears. */
function spoken(node: Child): string[] {
  const out: string[] = [];
  for (const el of walk(node)) {
    if (el.attrs["aria-label"]) out.push(el.attrs["aria-label"]);
    for (const child of el.children) if (typeof child === "string") out.push(child);
  }
  return out;
}
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;
const numbers = (texts: readonly string[]): string[] => texts.flatMap((t) => t.match(NUMBER) ?? []);

describe("the guard against Ajv and the backend's writer rules", () => {
  const verdicts = read(`${DIR}/dataset-quality-verdicts.json`) as {
    format: string;
    cases: {
      name: string;
      covers: string;
      document: unknown;
      valid: boolean;
      writer_rule: string | null;
    }[];
  };

  it("has the captured cases, valid and refused", () => {
    expect(verdicts.format).toBe("nemar.website-dataset-quality-verdicts.v1");
    expect(verdicts.cases.filter((c) => c.valid).length).toBeGreaterThanOrEqual(15);
    expect(verdicts.cases.filter((c) => !c.valid).length).toBeGreaterThanOrEqual(35);
  });

  it.each(verdicts.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(datasetQualityValid(c.document), c.covers).toBe(c.valid);
    if (!c.valid) return;
    const entries = Object.values(
      (c.document as { recipes: Record<string, DatasetRecipeSummary> }).recipes,
    );
    const first = entries.map((e) => writerRuleBroken(e)).find((w) => w !== null) ?? null;
    expect(first, c.covers).toBe(c.writer_rule);
  });

  it.each(verdicts.cases.map((c) => [c.name, c] as const))(
    "the page draws %s only when every check passes",
    (_name, c) => {
      const doc = documentOf("shown");
      doc.extensions.dataQuality = c.document;
      const summary = readQualitySummary(doc, doc.dataset_id);
      if (!c.valid)
        expect(summary).toEqual({
          kind: "refused",
          word: "summary_invalid",
          sentence: SUMMARY_SENTENCES.summary_invalid,
        });
      else if (c.writer_rule)
        expect(summary.kind === "refused" && summary.word).toBe(c.writer_rule);
      else
        expect(summary.kind).toBe(
          Object.keys((c.document as Loose).recipes).length > 0 ? "shown" : "none",
        );
    },
  );
});

describe("which datasets show a summary", () => {
  it.each(["shown", "spread", "published"])(
    "%s: the backend serves one and the page shows it",
    (name) => {
      expect(captured(name).status).toBe(200);
      expect(documentOf(name).extensions.dataQuality).toBeDefined();
      expect(summaryOf(name).kind).toBe("shown");
    },
  );

  it.each(["canary-only", "concealed", "withdrawn", "tombstoned", "never-published"])(
    "%s: nothing at all",
    (name) => {
      const c = captured(name);
      expect(c.status).toBe(200);
      expect(documentOf(name).extensions).not.toHaveProperty("dataQuality");
      const summary = summaryOf(name);
      expect(summary).toEqual({ kind: "none" });
      expect(summaryTree(summary, "q")).toBeNull();
    },
  );

  it("private: the document is not served, so there is no page", () => {
    expect(captured("private").status).toBe(404);
  });

  it("a document that does not say it is not anonymous shows nothing, whatever it carries", () => {
    for (const anonymous of [true, undefined, null, "false", 0]) {
      const doc = documentOf("shown");
      // JSON drops a member set to undefined, as a document without the member reads.
      doc.anonymous = anonymous;
      if (anonymous === undefined)
        expect(JSON.parse(JSON.stringify(doc))).not.toHaveProperty("anonymous");
      expect(readQualitySummary(doc, doc.dataset_id), String(anonymous)).toEqual({ kind: "none" });
    }
  });

  it("a document of another dataset, or not a dataset document, is refused with its sentence", () => {
    const doc = documentOf("shown");
    const other = readQualitySummary(doc, "nm099299");
    expect(other.kind === "refused" && other.word).toBe("document_other_dataset");
    for (const change of [
      (d: Loose) => {
        d.doc_type = "record";
      },
      (d: Loose) => {
        d.schema_version = "0.6";
      },
      (d: Loose) => {
        d.dataset_id = "NM099201";
      },
    ]) {
      const d = documentOf("shown");
      change(d);
      const summary = readQualitySummary(d, d.dataset_id);
      expect(summary.kind === "refused" && summary.word).toBe("document_invalid");
    }
  });
});

describe("a refused summary", () => {
  const ica = (d: Loose) => d.extensions.dataQuality.recipes["nemar-ica"];
  const refusals: [string, string, (d: Loose) => void][] = [
    [
      "schema",
      "summary_invalid",
      (d) => {
        ica(d).views = [];
      },
    ],
    [
      "record digest",
      "summary_invalid",
      (d) => {
        ica(d).record_sha256 = "A".repeat(64);
      },
    ],
    [
      "writer rule",
      "counts_unbalanced",
      (d) => {
        ica(d).counts.total = 7;
      },
    ],
    [
      "histogram",
      "histogram_unreadable",
      (d) => {
        // Edges that rise by the smallest subnormal: a bin's density is past binary64.
        ica(d).distributions.icaRank.histogram.edges = [
          0, 5e-324, 1e-323, 1.5e-323, 2e-323, 2.5e-323, 3e-323, 3.5e-323, 4e-323,
        ];
      },
    ],
  ];

  it.each(refusals)("%s: draws nothing and says why in one sentence", (_name, word, change) => {
    const doc = documentOf("spread");
    change(doc);
    const summary = readQualitySummary(doc, doc.dataset_id);
    expect(summary.kind === "refused" && summary.word).toBe(word);
    const tree = summaryTree(summary, "q")!;
    const elements = [...walk(tree)];
    expect(elements.map((e) => e.tag)).toEqual(["div", "p"]);
    const sentence = textOf(tree);
    expect(sentence).toBe(summary.kind === "refused" ? summary.sentence : "");
    expect(sentence).toMatch(
      /^The quality summary NEMAR published for this dataset is not shown: .+\.$/,
    );
    // Not one of the summary's numbers is printed.
    expect(numbers([sentence])).toEqual([]);
  });

  it("has a sentence for every word, none claiming authenticity", () => {
    for (const sentence of Object.values(SUMMARY_SENTENCES)) {
      expect(sentence.split(". ").length, sentence).toBe(1);
      expect(sentence).not.toMatch(/authentic|verified|trusted|genuine/i);
    }
  });
});

describe("a shown summary", () => {
  const doc = documentOf("spread");
  const served = captured("spread").text;
  const summary = summaryOf("spread");
  const tree = summaryTree(summary, "q")!;
  const entry = doc.extensions.dataQuality.recipes["nemar-ica"] as DatasetRecipeSummary;
  if (summary.kind !== "shown") throw new Error("the spread fixture must show");

  it("prints the stored counts, as stored", () => {
    // The counts object as served (a histogram's counts are an array, never an object).
    const block = /"counts":(\{[^}]*\})/.exec(served)![1];
    const text = (key: string) => new RegExp(`"${key}":(-?[0-9][^,}]*)`).exec(block)![1];
    const [failed, passed, skipped, total] = ["failed", "passed", "skipped", "total"].map(text);
    expect([failed, passed, skipped, total]).toEqual(["2", "3", "1", "6"]);
    const table = [...walk(tree)].find(
      (e) => e.tag === "table" && textOf(e.children[0]) === "Recordings",
    )!;
    const cells = [...walk(table)].filter((e) => e.tag === "td").map(textOf);
    expect(cells).toEqual([total, passed, failed, skipped]);
    const header = [...walk(table)].filter((e) => e.tag === "th").map(textOf);
    expect(header).toEqual(["discovered", "succeeded", "failed", "skipped"]);
  });

  it("lists the recordings not processed, and how many more were left out", () => {
    const details = [...walk(tree)].find((e) => e.attrs.class === "qs-not-processed")!;
    expect(textOf(details.children[0])).toBe(
      `Not processed: ${entry.counts.failed} failed, ${entry.counts.skipped} skipped`,
    );
    const rows = [...walk(details)]
      .filter((e) => e.tag === "tr")
      .slice(1)
      .map((r) => r.children.map(textOf));
    expect(rows).toEqual(entry.not_processed.map((r) => [r.path, r.status, r.code]));
    expect(textOf(details)).toContain(`${entry.not_processed_truncated} more not listed.`);
  });

  it("says a run with nothing left out processed every recording, with no count of its own", () => {
    const shown = summaryTree(summaryOf("shown"), "q")!;
    expect(textOf(shown)).toContain("Every recording discovered was processed.");
    expect([...walk(shown)].some((e) => e.attrs.class === "qs-not-processed")).toBe(false);
  });

  it("names the recipe, its version, the dataset version and the copy read", () => {
    const text = textOf(tree);
    expect(text).toContain(`nemar-ica, version ${entry.recipe_version}`);
    expect(text).toContain(
      `Computed on dataset version ${entry.dataset_version}, read from the archived copy (BIDS).`,
    );
  });

  const figures = [...walk(tree)].filter((e) => e.tag === "figure");
  const names = Object.keys(entry.distributions).sort();

  it("draws one figure per metric, in name order", () => {
    expect(figures.map((f) => textOf(f.children[0]).replace(/ \(.*\)$/, ""))).toEqual(names);
  });

  it.each(names.map((name, k) => [name, k] as const))(
    "%s: every number printed is the stored text of this metric's values",
    (name, k) => {
      const d = entry.distributions[name];
      const own = JSON.stringify(d);
      // The served bytes hold this distribution exactly as written here.
      expect(served).toContain(`${JSON.stringify(name)}:${own}`);
      const allowed = new Set([
        ...numbers([own, name, JSON.stringify(entry.observed_range[name])]),
      ]);
      for (const n of numbers(spoken(figures[k]))) expect(allowed, `${name}: ${n}`).toContain(n);
      // The values printed are the stored ones.
      const stats = [...walk(figures[k])].filter((e) => e.tag === "dd").map(textOf);
      const range = entry.observed_range[name];
      const text = (v: number | null) => (v === null ? "none" : numberText(v));
      expect(stats.slice(0, 3)).toEqual([
        String(d.n),
        text(d.median),
        `${text(range.min)} to ${text(range.max)}`,
      ]);
    },
  );

  it.each(names.map((name, k) => [name, k] as const))(
    "%s: the text alternative names every bar, the ends and the missing count",
    (name, k) => {
      const metric = summary.recipes[0].metrics[k];
      const label = metricLabel(metric);
      const drawing = [...walk(figures[k])].find((e) => e.attrs.role === "img")!;
      expect(drawing.attrs["aria-label"]).toBe(label);
      const d = entry.distributions[name];
      const { edges, counts, underflow, overflow, missing } = d.histogram;
      counts.forEach((count, i) => {
        const close = i === counts.length - 1 ? "]" : ")";
        expect(label).toContain(
          `[${numberText(edges[i])}, ${numberText(edges[i + 1])}${close}: ${count}`,
        );
      });
      expect(label).toContain(`< ${numberText(edges[0])}: ${underflow}`);
      expect(label).toContain(`> ${numberText(edges[edges.length - 1])}: ${overflow}`);
      if (missing !== undefined) expect(label).toContain(`missing: ${missing}`);
      expect(label.split("; ").length).toBe(counts.length + 2 + (missing === undefined ? 0 : 1));
    },
  );

  it("draws bins of unequal width by density, and prints no density", () => {
    const k = names.indexOf("asrBurstFraction");
    const metric = summary.recipes[0].metrics[k];
    expect(metric.model.heights).toBe("density");
    const ticks = [...walk(figures[k])].filter((e) => e.attrs.class === "qv-tick").map(textOf);
    expect(ticks).not.toContain(numberText(metric.model.max_density!));
    expect(metricLabel(metric)).toContain("its count per unit width");
    const table = [...walk(figures[k])].find((e) => e.tag === "table")!;
    expect([...walk(table)].filter((e) => e.tag === "th").map(textOf)).toEqual(["bin", "count"]);
  });

  it("is accessible: labelled figures and sections, unique ids, captioned tables, a hidden drawing", () => {
    const elements = [...walk(tree)];
    const ids = elements.map((e) => e.attrs.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    const byId = new Map(elements.filter((e) => e.attrs.id).map((e) => [e.attrs.id, e] as const));
    for (const e of elements.filter((x) => x.attrs["aria-labelledby"])) {
      const target = byId.get(e.attrs["aria-labelledby"]);
      expect(target, e.attrs["aria-labelledby"]).toBeDefined();
      expect(textOf(target as Element).length).toBeGreaterThan(0);
    }
    for (const f of figures) {
      expect(f.children[0]).toMatchObject({ tag: "figcaption" });
      const img = [...walk(f)].find((e) => e.attrs.role === "img")!;
      expect(img.attrs["aria-label"].length).toBeGreaterThan(20);
      const svg = [...walk(img)].find((e) => e.tag === "svg")!;
      expect(svg.attrs["aria-hidden"]).toBe("true");
      expect(svg.attrs.focusable).toBe("false");
    }
    for (const table of elements.filter((e) => e.tag === "table")) {
      expect(table.children[0]).toMatchObject({ tag: "caption" });
      for (const th of [...walk(table)].filter((e) => e.tag === "th"))
        expect(th.attrs.scope).toBe("col");
    }
    for (const details of elements.filter((e) => e.tag === "details")) {
      expect(details.children[0]).toMatchObject({ tag: "summary" });
    }
    expect(elements.filter((e) => e.tag === "h4").length).toBe(summary.recipes.length);
  });

  it("escapes every stored text", () => {
    const d = documentOf("spread");
    d.extensions.dataQuality.recipes["nemar-ica"].distributions.icaRank.description =
      '<img src=x onerror="alert(1)">';
    const html = toHtml(summaryTree(readQualitySummary(d, d.dataset_id), "q")!);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
  });
});
