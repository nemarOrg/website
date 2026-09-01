import { describe, expect, it } from "vitest";
import {
  type HedVocab,
  type HedVocabEntry,
  entriesByPath,
  hedVersionSpec,
  loadHedVocab,
  scoreVocabEntry,
  searchVocab,
} from "./hed-vocab";

/**
 * The real generated bundle, not a fixture. It is committed, so loading it
 * here is exactly what the browser loads — and these tests double as a guard
 * that `scripts/extract-hed-vocab.mjs` produced something usable.
 */
const vocab: HedVocab = await loadHedVocab();

describe("the generated bundle", () => {
  it("carries both schemas with the SCORE library prefix", () => {
    expect(vocab.schemas.map((s) => s.id).sort()).toEqual(["HED8.4.0", "SCORE2.1.0"]);
    expect(vocab.schemas.find((s) => s.id === "SCORE2.1.0")?.prefix).toBe("sc");
    expect(vocab.schemas.find((s) => s.id === "HED8.4.0")?.prefix).toBe("");
  });

  it("stays small enough to ship as a lazy chunk", () => {
    // The issue's budget is "well under ~300 KB" raw.
    expect(JSON.stringify(vocab).length).toBeLessThan(300 * 1024);
  });

  it("carries a usable number of tags from each schema", () => {
    const score = vocab.entries.filter((e) => e.schema === "SCORE2.1.0");
    const base = vocab.entries.filter((e) => e.schema === "HED8.4.0");
    expect(score.length).toBeGreaterThan(300);
    expect(base.length).toBeGreaterThan(50);
  });

  it("prefixes every SCORE path and no base-HED path", () => {
    for (const entry of vocab.entries) {
      if (entry.schema === "SCORE2.1.0") expect(entry.path.startsWith("sc:")).toBe(true);
      else expect(entry.path.startsWith("sc:")).toBe(false);
    }
  });

  it("has no duplicate paths", () => {
    expect(new Set(vocab.entries.map((e) => e.path)).size).toBe(vocab.entries.length);
  });

  it("never carries the hedxml value placeholder as a tag", () => {
    expect(vocab.entries.some((e) => e.tag === "#")).toBe(false);
  });

  it("ends every path with its own short tag", () => {
    for (const entry of vocab.entries) {
      expect(entry.path.endsWith(entry.tag)).toBe(true);
    }
  });

  it("includes the clinical terms an EEG annotator reaches for first", () => {
    const tags = new Set(vocab.entries.map((e) => e.tag));
    for (const tag of [
      "Epileptic-seizure",
      "Electroencephalographic-seizure",
      "Spike",
      "Sharp-wave",
      "Sleep-spindles",
      "K-complex",
      "Posterior-dominant-rhythm",
      "Eye-blink-artifact",
      "Line-noise-artifact",
      "EMG-artifact",
    ]) {
      expect(tags.has(tag)).toBe(true);
    }
  });

  it("resolves every quick pick against the entry list", () => {
    const byPath = entriesByPath(vocab);
    expect(vocab.quickPicks.length).toBeGreaterThan(0);
    for (const group of vocab.quickPicks) {
      expect(group.paths.length).toBeGreaterThan(0);
      for (const path of group.paths) expect(byPath.get(path)).toBeDefined();
    }
  });

  it("memoizes the load rather than re-fetching", async () => {
    expect(await loadHedVocab()).toBe(vocab);
  });
});

describe("hedVersionSpec", () => {
  it("produces the HEDVersion entries a sidecar needs", () => {
    expect(hedVersionSpec(vocab)).toEqual(["8.4.0", "sc:score_2.1.0"]);
  });
});

function entry(tag: string, path = `Root/${tag}`, description = ""): HedVocabEntry {
  return { tag, path, description, schema: "HED8.4.0" };
}

describe("scoreVocabEntry", () => {
  it("ranks an exact tag above a prefix above a word boundary above a substring", () => {
    const exact = scoreVocabEntry(entry("Spike"), "spike");
    const prefix = scoreVocabEntry(entry("Spike-and-slow-wave"), "spike");
    const word = scoreVocabEntry(entry("Runs-of-rapid-spike"), "spike");
    const substring = scoreVocabEntry(entry("Polyspikes"), "spike");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(substring);
  });

  it("ranks a path match below any tag match", () => {
    const inTag = scoreVocabEntry(entry("Artifact-thing"), "artifact");
    const inPath = scoreVocabEntry(entry("Sweat", "Property/Data-artifact/Sweat"), "artifact");
    expect(inTag).toBeGreaterThan(inPath);
    expect(inPath).toBeGreaterThan(0);
  });

  it("ranks a description-only match lowest but still finds it", () => {
    const found = scoreVocabEntry(
      entry("Wicket-spikes", "Root/Wicket-spikes", "A benign temporal variant in drowsiness."),
      "drowsiness",
    );
    expect(found).toBeGreaterThan(0);
    expect(found).toBeLessThan(scoreVocabEntry(entry("Drowsy"), "drowsy"));
  });

  it("returns 0 for a term that appears nowhere", () => {
    expect(scoreVocabEntry(entry("Spike"), "magnetometer")).toBe(0);
  });

  it("returns 0 for an empty query", () => {
    expect(scoreVocabEntry(entry("Spike"), "")).toBe(0);
  });

  it("prefers the shorter of two tags matching the same way", () => {
    const short = scoreVocabEntry(entry("Spike-wave"), "spike");
    const long = scoreVocabEntry(entry("Spike-and-slow-wave-complex-thing"), "spike");
    expect(short).toBeGreaterThan(long);
  });
});

describe("searchVocab", () => {
  it("puts the exact tag first", () => {
    const hits = searchVocab(vocab.entries, "spike");
    expect(hits[0].entry.tag).toBe("Spike");
  });

  it("finds a SCORE clinical term by a plain word", () => {
    const hits = searchVocab(vocab.entries, "seizure");
    expect(hits.length).toBeGreaterThan(3);
    expect(hits.every((h) => h.score > 0)).toBe(true);
    expect(hits.some((h) => h.entry.tag === "Epileptic-seizure")).toBe(true);
  });

  it("finds an artifact term from base HED", () => {
    const hits = searchVocab(vocab.entries, "blink");
    expect(hits.some((h) => h.entry.tag === "Eye-blink-artifact")).toBe(true);
  });

  it("treats multiple words as a conjunction", () => {
    const both = searchVocab(vocab.entries, "eye artifact");
    expect(both.length).toBeGreaterThan(0);
    for (const hit of both) {
      const haystack = `${hit.entry.tag} ${hit.entry.path} ${hit.entry.description}`.toLowerCase();
      expect(haystack.includes("eye")).toBe(true);
      expect(haystack.includes("artifact")).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(searchVocab(vocab.entries, "SEIZURE")[0].entry.tag).toBe(
      searchVocab(vocab.entries, "seizure")[0].entry.tag,
    );
  });

  it("returns nothing for an empty or whitespace query", () => {
    expect(searchVocab(vocab.entries, "")).toEqual([]);
    expect(searchVocab(vocab.entries, "   ")).toEqual([]);
  });

  it("returns nothing for a term the vocabulary does not contain", () => {
    expect(searchVocab(vocab.entries, "zzzznotaterm")).toEqual([]);
  });

  it("honours the result limit", () => {
    expect(searchVocab(vocab.entries, "a", 5)).toHaveLength(5);
  });

  it("is deterministic across calls", () => {
    const a = searchVocab(vocab.entries, "sleep").map((h) => h.entry.path);
    const b = searchVocab(vocab.entries, "sleep").map((h) => h.entry.path);
    expect(a).toEqual(b);
  });
});

describe("entriesByPath", () => {
  it("indexes every entry", () => {
    expect(entriesByPath(vocab).size).toBe(vocab.entries.length);
  });

  it("round-trips a known SCORE path to its short tag", () => {
    const found = entriesByPath(vocab).get("sc:Episode/Epileptic-seizure");
    expect(found?.tag).toBe("Epileptic-seizure");
    expect(found?.schema).toBe("SCORE2.1.0");
  });
});
