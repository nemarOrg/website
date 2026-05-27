import { describe, expect, it } from "vitest";
import type { DirListing } from "./dir-listing";
import { renderSubdir, renderTopLevel } from "./render-dir-listing";

function listing(overrides: Partial<DirListing> = {}): DirListing {
  return {
    dataset_id: "on005514",
    version: "v1.0.0",
    path: "",
    kind: "directory",
    children: [],
    ...overrides,
  };
}

describe("renderTopLevel", () => {
  it("wraps in <section class='tree'> with header + meta", () => {
    const html = renderTopLevel(listing());
    expect(html).toContain(`<section class="tree" aria-label="Dataset file tree">`);
    expect(html).toContain(`<header class="tree__head">`);
    expect(html).toContain("<h2>Files</h2>");
    expect(html).toContain("0 top-level entries");
  });

  it("emits file rows under .tree__list--root, directory rows under .tree__list", () => {
    const html = renderTopLevel(
      listing({
        children: [
          { kind: "file", name: "README.md", size: 6906 },
          { kind: "dir", name: "sub-01" },
        ],
      }),
    );
    expect(html).toContain(`<ul class="tree__list tree__list--root"`);
    expect(html).toContain(
      `<a class="tree__name" href="https://data.nemar.org/on005514/v1.0.0/README.md"`,
    );
    expect(html).toContain(`<ul class="tree__list" role="list">`);
    expect(html).toContain(`<details class="tree__dir" data-dir-path="sub-01" data-depth="0">`);
  });

  it("renders files in the root list (before the directory list), numeric-aware within each kind", () => {
    const html = renderTopLevel(
      listing({
        children: [
          { kind: "file", name: "z.txt", size: 1 },
          { kind: "dir", name: "sub-10" },
          { kind: "file", name: "a.txt", size: 1 },
          { kind: "dir", name: "sub-2" },
        ],
      }),
    );
    // Files appear first (in the .tree__list--root flat list); dirs follow.
    expect(html.indexOf("a.txt")).toBeLessThan(html.indexOf("sub-2"));
    expect(html.indexOf("z.txt")).toBeLessThan(html.indexOf("sub-2"));
    // Alpha sort within files: a.txt before z.txt.
    expect(html.indexOf("a.txt")).toBeLessThan(html.indexOf("z.txt"));
    // Numeric sort within dirs: sub-2 before sub-10.
    expect(html.indexOf("sub-2")).toBeLessThan(html.indexOf("sub-10"));
  });

  it("emits a [data-dir-target] slot for every directory (lazy-load placeholder)", () => {
    const html = renderTopLevel(
      listing({
        children: [
          { kind: "dir", name: "sub-01" },
          { kind: "dir", name: "code" },
        ],
      }),
    );
    const slots = html.match(/data-dir-target/g);
    expect(slots).not.toBeNull();
    expect(slots?.length).toBe(2);
  });

  it("computes root total bytes from the file children only", () => {
    const html = renderTopLevel(
      listing({
        children: [
          { kind: "file", name: "a.bin", size: 1000 },
          { kind: "file", name: "b.bin", size: 2000 },
          { kind: "dir", name: "sub-01" },
        ],
      }),
    );
    expect(html).toContain("2.93 KB root total");
  });
});

describe("renderSubdir", () => {
  it("emits an inner <ul class='tree__children'> with depth variable", () => {
    const html = renderSubdir(
      listing({
        path: "sub-01",
        children: [{ kind: "file", name: "x.set", size: 100 }],
      }),
      1,
    );
    expect(html.startsWith(`<ul class="tree__children"`)).toBe(true);
    expect(html).toContain(`style="--depth: 1"`);
  });

  it("emits no <section> wrapper (fragment only — injected into a slot)", () => {
    const html = renderSubdir(
      listing({ path: "sub-01", children: [{ kind: "dir", name: "eeg" }] }),
      1,
    );
    expect(html).not.toContain("<section");
    expect(html).not.toContain("tree__head");
  });

  it("nested dirs carry parent path in data-dir-path (so deeper expansion fetches the right URL)", () => {
    const html = renderSubdir(
      listing({ path: "sub-01", children: [{ kind: "dir", name: "eeg" }] }),
      1,
    );
    expect(html).toContain(`data-dir-path="sub-01/eeg"`);
  });

  it("file rows carry tree__row--file + indent based on depth", () => {
    const html = renderSubdir(
      listing({
        path: "sub-01/eeg",
        children: [{ kind: "file", name: "sub-01_task-rest_eeg.set", size: 50000 }],
      }),
      2,
    );
    expect(html).toContain(`class="tree__row tree__row--file"`);
    expect(html).toContain(
      "padding-inline-start: calc(var(--space-5) + 2 * var(--space-5) + 16px)",
    );
    expect(html).toContain(
      `href="https://data.nemar.org/on005514/v1.0.0/sub-01/eeg/sub-01_task-rest_eeg.set"`,
    );
    expect(html).toContain("48.8 KB");
  });
});
