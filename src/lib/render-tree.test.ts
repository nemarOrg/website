import { describe, expect, it } from "vitest";
import { buildTree } from "./bids-tree";
import type { ManifestEntry } from "./neuroschema";
import { isSubjectDir, renderBidsSubtree, renderBidsTree } from "./render-tree";

function entry(path: string, size = 100): ManifestEntry {
  return { path, size, checksum_algorithm: "md5", checksum: "x", url: "" };
}

const BASE = "https://data.nemar.org/nm000103/v1.0.0";

describe("isSubjectDir", () => {
  it("matches BIDS sub-XYZ labels", () => {
    expect(isSubjectDir("sub-01")).toBe(true);
    expect(isSubjectDir("sub-NDARAC904DMU")).toBe(true);
    expect(isSubjectDir("sub-A")).toBe(true);
  });

  it("rejects values that aren't BIDS subject labels", () => {
    expect(isSubjectDir("subject")).toBe(false);
    expect(isSubjectDir("sub_01")).toBe(false);
    expect(isSubjectDir("sub-")).toBe(false);
    expect(isSubjectDir("Sub-01")).toBe(false);
    expect(isSubjectDir("")).toBe(false);
  });

  it("rejects values with embedded path separators (traversal guard)", () => {
    expect(isSubjectDir("sub-01/eeg")).toBe(false);
    expect(isSubjectDir("../sub-01")).toBe(false);
    expect(isSubjectDir("sub-01/../../etc")).toBe(false);
  });
});

describe("renderBidsTree skeleton behavior", () => {
  it("renders subject children as collapsed details with a lazy-load slot", () => {
    const root = buildTree([
      entry("README.md", 100),
      entry("sub-01/eeg/sub-01_task-rest_eeg.set", 50_000),
      entry("sub-02/eeg/sub-02_task-rest_eeg.set", 60_000),
    ]);
    const html = renderBidsTree(root, BASE);

    // Each subject directory is a closed <details data-subject="sub-NN">
    expect(html).toContain(`<details class="tree__dir" data-subject="sub-01">`);
    expect(html).toContain(`<details class="tree__dir" data-subject="sub-02">`);
    // Empty lazy-load placeholder is present for each subject
    expect(html).toContain(`<div class="tree__lazy" data-subject-target></div>`);
    // Inline file rows for subject contents must NOT be present in the skeleton
    expect(html).not.toContain("sub-01_task-rest_eeg.set");
    expect(html).not.toContain("sub-02_task-rest_eeg.set");
    // Counts are still honest about what's hidden
    expect(html).toContain("1 dirs · 1 files");
  });

  it("renders non-subject top-level directories with the full subtree inline", () => {
    const root = buildTree([
      entry("code/run.py", 1000),
      entry("code/utils.py", 500),
      entry("derivatives/pipeline/out.json", 200),
    ]);
    const html = renderBidsTree(root, BASE);

    // No subject placeholders for a non-subject tree
    expect(html).not.toContain("data-subject=");
    expect(html).not.toContain("data-subject-target");
    // Inline file rows DO appear because non-subject dirs are not deferred
    expect(html).toContain("run.py");
    expect(html).toContain("utils.py");
    expect(html).toContain("out.json");
  });

  it("renders a mixed tree: subjects collapsed, code/ expanded", () => {
    const root = buildTree([
      entry("code/run.py", 1000),
      entry("sub-01/eeg/sub-01_task-rest_eeg.set", 50_000),
    ]);
    const html = renderBidsTree(root, BASE);

    // sub-01 collapsed
    expect(html).toContain(`data-subject="sub-01"`);
    expect(html).toContain("data-subject-target");
    expect(html).not.toContain("sub-01_task-rest_eeg.set");
    // code/ expanded
    expect(html).toContain("run.py");
  });
});

describe("renderBidsSubtree", () => {
  it("returns the inner subtree fragment without a section wrapper", () => {
    const root = buildTree([
      entry("sub-01/eeg/sub-01_task-rest_eeg.set", 50_000),
      entry("sub-01/eeg/sub-01_task-rest_eeg.fdt", 100_000),
    ]);
    const subject = root.children.find((c) => c.name === "sub-01");
    expect(subject).toBeDefined();
    if (!subject) return;

    const html = renderBidsSubtree(subject, BASE);

    // Fragment begins with the children ul (no <section>, no header)
    expect(html.startsWith(`<ul class="tree__children"`)).toBe(true);
    expect(html).not.toContain("<section");
    expect(html).not.toContain("tree__head");
    // Files appear in the rendered subtree
    expect(html).toContain("sub-01_task-rest_eeg.set");
    expect(html).toContain("sub-01_task-rest_eeg.fdt");
  });

  it("renders an empty subject (no files) as an empty children ul", () => {
    const root = buildTree([entry("sub-01/", 0)]);
    const subject = root.children.find((c) => c.name === "sub-01");
    if (!subject) return;
    const html = renderBidsSubtree(subject, BASE);
    expect(html).toContain(`<ul class="tree__children"`);
  });
});
