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

  it("accepts hyphenated labels (BIDS 2.0 + real OpenNeuro datasets)", () => {
    expect(isSubjectDir("sub-NDAR-AC904DMU")).toBe(true);
    expect(isSubjectDir("sub-group-A-01")).toBe(true);
    expect(isSubjectDir("sub-john-doe")).toBe(true);
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

  it("renders a subjects-only tree without a root file list", () => {
    // No root-level files (all paths under sub-*/...) is the common
    // shape for high-subject OpenNeuro datasets. Skeleton must not emit
    // a dangling empty tree__list--root ul.
    const root = buildTree([
      entry("sub-01/eeg/sub-01_task-rest_eeg.set", 50_000),
      entry("sub-02/eeg/sub-02_task-rest_eeg.set", 60_000),
    ]);
    const html = renderBidsTree(root, BASE);
    expect(html).not.toContain("tree__list--root");
    expect(html).toContain(`data-subject="sub-01"`);
    expect(html).toContain(`data-subject="sub-02"`);
  });
});

describe("renderBidsSubtree non-propagation", () => {
  it("does not collapse nested sub-* directories inside a subject subtree", () => {
    // Lazy deferral applies only at the top level. A path that contains
    // an inner sub-* segment (synthetic here) must render fully inline
    // once the user expands the parent subject — no second-level
    // data-subject-target slot.
    const root = buildTree([entry("sub-01/sub-ses-01/eeg/x.set", 100)]);
    const subject = root.children.find((c) => c.name === "sub-01");
    if (!subject) return;
    const subtree = renderBidsSubtree(subject, BASE);
    expect(subtree).not.toContain("data-subject=");
    expect(subtree).not.toContain("data-subject-target");
    expect(subtree).toContain("x.set");
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
