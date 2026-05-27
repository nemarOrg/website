import { describe, expect, it } from "vitest";
import { buildTree, buildTreeFromPaths, classifyFile } from "./bids-tree";
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
    expect(tree.files.map((f) => f.path).sort()).toEqual(["README.md", "dataset_description.json"]);
    expect(tree.children.map((c) => c.name)).toEqual(["sub-01", "sub-02"]);
    expect(tree.children[0]!.totalSize).toBe(150_000);
    expect(tree.totalSize).toBe(1000 + 200 + 50_000 + 100_000 + 60_000);
  });

  it("sorts numerically (sub-2 before sub-10)", () => {
    const tree = buildTree([entry("sub-10/x.txt"), entry("sub-2/x.txt"), entry("sub-1/x.txt")]);
    expect(tree.children.map((c) => c.name)).toEqual(["sub-1", "sub-2", "sub-10"]);
  });

  it("aggregates sizes deep", () => {
    const tree = buildTree([
      entry("a/b/c/d.txt", 1),
      entry("a/b/c/e.txt", 2),
      entry("a/b/f.txt", 4),
    ]);
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

describe("buildTreeFromPaths", () => {
  it("builds a tree from a path list", () => {
    const tree = buildTreeFromPaths([
      "README.md",
      "dataset_description.json",
      "sub-01/eeg/sub-01_task-rest_eeg.set",
      "sub-02/eeg/sub-02_task-rest_eeg.set",
    ]);
    expect(tree.files.map((f) => f.path).sort()).toEqual(["README.md", "dataset_description.json"]);
    expect(tree.children.map((c) => c.name)).toEqual(["sub-01", "sub-02"]);
  });

  it("sets size to 0 and url to empty string for all entries", () => {
    const tree = buildTreeFromPaths(["sub-01/eeg/x.set"]);
    const file = tree.children[0]!.children[0]!.files[0]!;
    expect(file.size).toBe(0);
    expect(file.url).toBe("");
  });

  it("handles empty path list", () => {
    const tree = buildTreeFromPaths([]);
    expect(tree.children).toEqual([]);
    expect(tree.files).toEqual([]);
    expect(tree.totalSize).toBe(0);
  });

  it("sorts numerically like buildTree", () => {
    const tree = buildTreeFromPaths(["sub-10/x.txt", "sub-2/x.txt", "sub-1/x.txt"]);
    expect(tree.children.map((c) => c.name)).toEqual(["sub-1", "sub-2", "sub-10"]);
  });

  it("handles malformed segments without throwing", () => {
    // Empty + slash-only paths are dropped (filter(Boolean) in buildTree
    // discards zero-length segments). A trailing-slash path like "sub-01/"
    // currently degrades to a one-segment file named "sub-01" at the root —
    // not ideal, but locking in current behavior so a refactor doesn't
    // silently change it. Real data from data.nemar.org/summary.json never
    // contains these shapes; this test exists to pin the defensive contract.
    expect(() => buildTreeFromPaths(["", "/", "sub-01/", "sub-01/eeg/x.set"])).not.toThrow();
    const tree = buildTreeFromPaths(["", "/", "sub-01/", "sub-01/eeg/x.set"]);
    expect(tree.children.map((c) => c.name)).toEqual(["sub-01"]);
    expect(tree.children[0]!.children.map((c) => c.name)).toEqual(["eeg"]);
  });

  it("overlays rootTotalSize when provided (used for summary.totals.bytes)", () => {
    // summary.json carries authoritative totals even though per-entry sizes
    // are absent. Caller passes summary.totals.bytes to make the rendered
    // panel header report a real number rather than 0 B. Issue #74. The
    // 168_778_508_210 literal is on005512's actual byte count (~157 GB).
    const tree = buildTreeFromPaths(["sub-01/x.set", "sub-02/x.set"], 168_778_508_210);
    expect(tree.totalSize).toBe(168_778_508_210);
    // Children stay at zero — only the root override applies. Per-file
    // sizes wait on schema 1.2 (nemar-cli#635 / nemarOrg/website#73).
    expect(tree.children[0]!.totalSize).toBe(0);
  });

  it("leaves root.totalSize at the synthesized 0 when no override is given (back-compat)", () => {
    const tree = buildTreeFromPaths(["sub-01/x.set"]);
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
