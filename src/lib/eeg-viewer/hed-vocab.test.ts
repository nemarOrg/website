import { describe, expect, it } from "vitest";
import {
  type HedVocab,
  type HedVocabEntry,
  artifactQuickPicks,
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
    // The original curated budget was ~300 KB raw; Yahya then asked for the
    // WHOLE of both schemas to be searchable (2026-09-01), which costs
    // ~341 KB raw / ~68 KB gzipped. Cap at 500 KB so accidental bloat (a
    // schema bump doubling descriptions, a serializer regression) still
    // fails loudly while the full vocabulary fits.
    expect(JSON.stringify(vocab).length).toBeLessThan(500 * 1024);
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

describe("artifactQuickPicks", () => {
  const groups = artifactQuickPicks(vocab);

  it("offers only artifact terms, in resolvable groups", () => {
    const byPath = entriesByPath(vocab);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.paths.length).toBeGreaterThan(0);
      for (const path of group.paths) {
        expect(byPath.get(path)).toBeDefined();
        expect(path.toLowerCase()).toContain("artifact");
      }
    }
  });

  it("carries the noise a channel actually gets marked for", () => {
    const tags = new Set(
      groups.flatMap((g) => g.paths).map((p) => vocab.entries.find((e) => e.path === p)?.tag ?? ""),
    );
    for (const tag of [
      "Line-noise-artifact",
      "Electrode-pops-artifact",
      "EMG-artifact",
      "Eye-blink-artifact",
      "Sweat-artifact",
    ]) {
      expect(tags.has(tag)).toBe(true);
    }
  });

  it("splits biological from non-biological and keeps the SCORE terms last", () => {
    expect(groups.map((g) => g.group)).toEqual([
      "Artifact",
      "Biological",
      "Non-biological",
      "Effect on the recording",
    ]);
    const biological = groups.find((g) => g.group === "Biological");
    const nonBiological = groups.find((g) => g.group === "Non-biological");
    const score = groups.find((g) => g.group === "Effect on the recording");
    expect(biological?.paths.every((p) => p.includes("/Biological-artifact"))).toBe(true);
    expect(nonBiological?.paths.every((p) => p.includes("/Nonbiological-artifact"))).toBe(true);
    expect(score?.paths.every((p) => p.startsWith("sc:"))).toBe(true);
  });

  it("leaves out the general clinical picks a channel mark has no use for", () => {
    const paths = new Set(groups.flatMap((g) => g.paths));
    expect(paths.has("sc:Episode/Epileptic-seizure")).toBe(false);
    expect(paths.has("sc:Sleep-and-drowsiness/Sleep-spindles")).toBe(false);
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

describe("whole-schema coverage (website#255 QA: search must reach ALL of HED)", () => {
  it("carries the full base schema, not just the artifact subtrees", () => {
    const tags = new Set(vocab.entries.map((e) => e.tag));
    // Spot-checks from parts of base HED the old curated bundle excluded.
    expect(tags.has("Building")).toBe(true);
    expect(tags.has("Left-side-of")).toBe(true);
    expect(tags.has("Right-side-of")).toBe(true);
  });

  it("finds every sleep-carrying tag across both schemas", () => {
    const hits = searchVocab(vocab.entries, "sleep", 100);
    const all = vocab.entries.filter(
      (e) =>
        e.tag.toLowerCase().includes("sleep") ||
        e.path.toLowerCase().includes("sleep") ||
        e.description.toLowerCase().includes("sleep"),
    );
    expect(hits.length).toBe(Math.min(all.length, 100));
    expect(hits.some((h) => h.entry.schema === "HED8.4.0")).toBe(true);
    expect(hits.some((h) => h.entry.schema === "SCORE2.1.0")).toBe(true);
  });

  it("ships no deprecated tags", () => {
    expect(vocab.entries.length).toBeGreaterThan(1400);
  });
});
