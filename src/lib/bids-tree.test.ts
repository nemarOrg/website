import { describe, expect, it } from "vitest";
import { buildTree, classifyFile } from "./bids-tree";
import type { ManifestEntry } from "./neuroschema";

function entry(path: string, size = 100): ManifestEntry {
  return { path, size, checksum_algorithm: "md5", checksum: "x", url: "" };
}

describe("buildTree", () => {
  it("builds a tree from manifest entries", () => {
    const tree = buildTree([
      entry("README.md", 1000),
      entry("dataset_description.json", 200),
      entry("sub-01/eeg/sub-01_task-rest_eeg.set", 50_000),
      entry("sub-01/eeg/sub-01_task-rest_eeg.fdt", 100_000),
      entry("sub-02/eeg/sub-02_task-rest_eeg.set", 60_000),
    ]);
    expect(tree.files.map((f) => f.path).sort()).toEqual([
      "README.md",
      "dataset_description.json",
    ]);
    expect(tree.children.map((c) => c.name)).toEqual(["sub-01", "sub-02"]);
    expect(tree.children[0]!.totalSize).toBe(150_000);
    expect(tree.totalSize).toBe(1000 + 200 + 50_000 + 100_000 + 60_000);
  });

  it("sorts numerically (sub-2 before sub-10)", () => {
    const tree = buildTree([entry("sub-10/x.txt"), entry("sub-2/x.txt"), entry("sub-1/x.txt")]);
    expect(tree.children.map((c) => c.name)).toEqual(["sub-1", "sub-2", "sub-10"]);
  });

  it("aggregates sizes deep", () => {
    const tree = buildTree([entry("a/b/c/d.txt", 1), entry("a/b/c/e.txt", 2), entry("a/b/f.txt", 4)]);
    expect(tree.totalSize).toBe(7);
    expect(tree.children[0]!.totalSize).toBe(7);
    expect(tree.children[0]!.children[0]!.totalSize).toBe(7);
  });

  it("handles empty manifest", () => {
    const tree = buildTree([]);
    expect(tree.children).toEqual([]);
    expect(tree.files).toEqual([]);
    expect(tree.totalSize).toBe(0);
  });
});

describe("classifyFile", () => {
  it("flags EEG raw formats", () => {
    expect(classifyFile("foo.set").isEEG).toBe(true);
    expect(classifyFile("foo.edf").isEEG).toBe(true);
    expect(classifyFile("foo.bdf").isEEG).toBe(true);
    expect(classifyFile("foo.txt").isEEG).toBe(false);
  });
  it("flags tsv and json", () => {
    expect(classifyFile("participants.tsv").isTSV).toBe(true);
    expect(classifyFile("dataset_description.json").isJSON).toBe(true);
  });
  it("flags readme variants", () => {
    expect(classifyFile("README").isReadme).toBe(true);
    expect(classifyFile("README.md").isReadme).toBe(true);
    expect(classifyFile("readme.txt").isReadme).toBe(true);
    expect(classifyFile("foo.md").isReadme).toBe(false);
  });
});
