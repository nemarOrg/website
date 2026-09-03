import { describe, expect, it } from "vitest";
import { bidsRowId } from "./bids-tree";
import type { DirListing, DirListingEntry } from "./dir-listing";
import {
  DEFAULT_DIR_CHUNK_SIZE,
  renderDirChunkRows,
  renderSubdir,
  renderTopLevel,
} from "./render-dir-listing";

function dirEntries(count: number, prefix = "sub-"): DirListingEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "dir" as const,
    name: `${prefix}${String(i + 1).padStart(3, "0")}`,
  }));
}

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
    // Post-#85: file rows wrap in <li class="tree__file-wrap"> with a
    // preview button + download icon. README.md → previewType "md".
    expect(html).toContain(`<li class="tree__file-wrap" data-preview-wrap>`);
    expect(html).toContain(`data-preview-type="md"`);
    expect(html).toContain(
      `<a class="tree__dl" href="https://data.nemar.org/on005514/v1.0.0/README.md"`,
    );
    expect(html).toContain(`<ul class="tree__list" role="list" aria-live="polite" data-dir-list>`);
    expect(html).toContain(`<details class="tree__dir" data-dir-path="sub-01" data-depth="0">`);
  });

  it("emits a preview slot for inline-previewable files (md/json/tsv)", () => {
    const html = renderTopLevel(
      listing({
        children: [
          { kind: "file", name: "participants.tsv", size: 1000 },
          { kind: "file", name: "dataset_description.json", size: 500 },
          { kind: "file", name: "data.set", size: 100000 },
          { kind: "file", name: "README.md", size: 800 },
        ],
      }),
    );
    expect(html).toContain(`data-preview-type="tsv"`);
    expect(html).toContain(`data-preview-type="json"`);
    expect(html).toContain(`data-preview-type="eeg"`);
    expect(html).toContain(`data-preview-type="md"`);
    // Every previewable type gets exactly one inline slot, eeg included
    // (website#217 — between #199 and #217 eeg opened straight into a modal
    // and had no per-row slot).
    const slots = html.match(/data-preview-slot/g) ?? [];
    expect(slots.length).toBe(4);
  });

  it("gives the eeg row an inline preview slot marked for signal sizing", () => {
    const html = renderTopLevel(
      listing({ children: [{ kind: "file", name: "sub-01_task-rest_eeg.set", size: 100000 }] }),
    );
    expect(html).toContain(`data-preview-type="eeg"`);
    expect(html).toContain(`class="tree__preview tree__preview--signal"`);
    // The signal panel hosts a live viewer whose readouts update continuously;
    // announcing each one is why it opts out of the aria-live the text
    // previews use.
    expect(html).not.toMatch(/tree__preview--signal[^>]*aria-live/);
  });

  it("stamps a bidsRowId anchor on a recording row (website#277 coverage panel links)", () => {
    const html = renderTopLevel(
      listing({ children: [{ kind: "file", name: "sub-01_task-rest_eeg.set", size: 100000 }] }),
    );
    expect(html).toContain(`id="${bidsRowId("sub-01_task-rest_eeg.set")}"`);
  });

  it("does not stamp an anchor id on a non-recording file row", () => {
    const html = renderTopLevel(
      listing({ children: [{ kind: "file", name: "README.md", size: 100 }] }),
    );
    expect(html).not.toContain(` id="rec-`);
  });

  it("marks the eeg preview button aria-expanded, not aria-haspopup=dialog", () => {
    const html = renderTopLevel(
      listing({ children: [{ kind: "file", name: "sub-01_task-rest_eeg.set", size: 100000 }] }),
    );
    // The button toggles its adjacent panel like every other preview type;
    // the dialog is a second step behind the panel's Enlarge control, so
    // claiming aria-haspopup="dialog" here would misdescribe the button.
    expect(html).toMatch(/data-preview-type="eeg"[^>]*aria-expanded="false"/);
    expect(html).not.toContain(`aria-haspopup="dialog"`);
  });

  it("omits the preview button + slot for unknown formats (CHANGES, .gitattributes)", () => {
    const html = renderTopLevel(
      listing({
        children: [
          { kind: "file", name: "CHANGES", size: 200 },
          { kind: "file", name: ".gitattributes", size: 100 },
        ],
      }),
    );
    // No preview affordance for unknown formats — name is a plain span.
    expect(html).not.toContain("tree__preview-btn");
    expect(html).not.toContain("data-preview-slot");
    // Download icon is still present for these rows.
    expect(html).toContain("tree__dl");
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

  it("caps initial dir rows at DEFAULT_DIR_CHUNK_SIZE and appends a footer when more remain", () => {
    const html = renderTopLevel(listing({ children: dirEntries(60) }));
    // Exactly 50 <details data-dir-path=...> rows on first paint.
    const dirRows = html.match(/<details class="tree__dir"/g) ?? [];
    expect(dirRows.length).toBe(DEFAULT_DIR_CHUNK_SIZE);
    // Footer carries the state the click handler reads.
    expect(html).toContain(`data-tree-more data-rendered="50" data-total="60" data-chunk="50"`);
    expect(html).toContain("Show next 10");
    expect(html).toContain("(50 of 60 shown)");
  });

  it("omits the footer when total dirs <= chunk size", () => {
    const html = renderTopLevel(listing({ children: dirEntries(30) }));
    expect(html).not.toContain("data-tree-more");
    expect(html).not.toContain("tree__more-btn");
  });

  it("respects a custom dirChunkSize override", () => {
    const html = renderTopLevel(listing({ children: dirEntries(12) }), { dirChunkSize: 5 });
    const dirRows = html.match(/<details class="tree__dir"/g) ?? [];
    expect(dirRows.length).toBe(5);
    expect(html).toContain(`data-tree-more data-rendered="5" data-total="12" data-chunk="5"`);
    expect(html).toContain("Show next 5");
  });
});

describe("renderDirChunkRows", () => {
  it("returns just the requested slice of dir rows (no <section>, no <ul>)", () => {
    const result = renderDirChunkRows(listing({ children: dirEntries(60) }), 50, 50);
    expect(result.rendered).toBe(10);
    expect(result.total).toBe(60);
    expect(result.html).not.toContain("<section");
    expect(result.html).not.toContain("<ul");
    const rows = result.html.match(/<details class="tree__dir"/g) ?? [];
    expect(rows.length).toBe(10);
    // First row of the slice is sub-051 (the 51st of the zero-padded names).
    expect(result.html).toContain(`data-dir-path="sub-051"`);
    // Final row is sub-060.
    expect(result.html).toContain(`data-dir-path="sub-060"`);
    // Rows that were already rendered must not be in this chunk.
    expect(result.html).not.toContain(`data-dir-path="sub-050"`);
  });

  it("clamps when fromIndex + count exceeds total", () => {
    const result = renderDirChunkRows(listing({ children: dirEntries(30) }), 0, 50);
    expect(result.rendered).toBe(30);
    expect(result.total).toBe(30);
  });

  it("clamps the tail chunk when fromIndex is mid-list", () => {
    // The final reveal on a 333-subject dataset: chunk size 50, already at
    // 300 rendered — only the last 33 should come back. Mirrors the live
    // puppeteer run that exercised the on005509 footer-removal path.
    const result = renderDirChunkRows(listing({ children: dirEntries(60) }), 55, 50);
    expect(result.rendered).toBe(5);
    expect(result.total).toBe(60);
    const rows = result.html.match(/<details class="tree__dir"/g) ?? [];
    expect(rows.length).toBe(5);
    expect(result.html).toContain(`data-dir-path="sub-056"`);
    expect(result.html).toContain(`data-dir-path="sub-060"`);
    expect(result.html).not.toContain(`data-dir-path="sub-055"`);
  });

  it("returns rendered: 0 when fromIndex >= total (caller should remove the footer)", () => {
    const result = renderDirChunkRows(listing({ children: dirEntries(30) }), 30, 50);
    expect(result.rendered).toBe(0);
    expect(result.total).toBe(30);
    expect(result.html).toBe("");
  });

  it("sorts numerically (sub-2 before sub-10) before slicing", () => {
    const result = renderDirChunkRows(
      listing({
        children: [
          { kind: "dir", name: "sub-10" },
          { kind: "dir", name: "sub-2" },
          { kind: "dir", name: "sub-1" },
        ],
      }),
      0,
      2,
    );
    expect(result.rendered).toBe(2);
    expect(result.html.indexOf("sub-1")).toBeGreaterThanOrEqual(0);
    expect(result.html.indexOf("sub-2")).toBeGreaterThan(result.html.indexOf("sub-1"));
    expect(result.html).not.toContain("sub-10");
  });

  it("ignores file children when slicing dirs", () => {
    const result = renderDirChunkRows(
      listing({
        children: [{ kind: "file", name: "README.md", size: 100 }, ...dirEntries(3)],
      }),
      0,
      10,
    );
    expect(result.total).toBe(3);
    expect(result.rendered).toBe(3);
    expect(result.html).not.toContain("README.md");
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

describe("directory-keyed signal recordings (website#252)", () => {
  const mefd = "sub-01_ses-ieeg01_task-ccep_run-01_ieeg.mefd";

  it("renders a .mefd dir as a hybrid row: sibling toggle + viewer buttons", () => {
    const html = renderSubdir(
      listing({ path: "sub-01/ses-ieeg01/ieeg", children: [{ kind: "dir", name: mefd }] }),
      3,
    );
    // Viewer affordance mirrors signal file rows so the click delegate,
    // zarr annotate pass, and prefetch flow apply unchanged.
    expect(html).toContain(`data-preview-type="eeg"`);
    expect(html).toContain(`data-preview-path="sub-01/ses-ieeg01/ieeg/${mefd}"`);
    expect(html).toContain(`data-dir-recording="true"`);
    expect(html).toContain(`data-file-name="${mefd}"`);
    expect(html).toContain(`class="tree__tag tree__tag--signal">MEFD</span>`);
    // Expansion via a dedicated sibling button, NOT a <summary> wrapping the
    // viewer button (nested interactive content in <summary> is inconsistently
    // exposed to assistive technology).
    expect(html).not.toContain("<details");
    expect(html).toContain("data-dir-toggle");
    expect(html).toContain(`data-dir-path="sub-01/ses-ieeg01/ieeg/${mefd}"`);
    expect(html).toContain(`aria-label="Browse files in ${mefd}"`);
    expect(html).toContain("data-dir-target hidden");
    // A directory recording is a recording too -- always linkable from the
    // coverage panel (website#277).
    expect(html).toContain(`id="${bidsRowId(`sub-01/ses-ieeg01/ieeg/${mefd}`)}"`);
    // The wrap + slot the inline viewer mounts into.
    expect(html).toContain(`<li class="tree__file-wrap" data-preview-wrap>`);
    expect(html).toContain(`class="tree__preview tree__preview--signal" data-preview-slot hidden`);
  });

  it("ordinary dirs keep the native <details> structure", () => {
    const html = renderSubdir(
      listing({ path: "sub-01", children: [{ kind: "dir", name: "ieeg" }] }),
      1,
    );
    expect(html).toContain("<details");
    expect(html).not.toContain("data-dir-toggle");
  });

  it("renders .mefd dirs revealed by Show-next chunks as hybrid rows too", () => {
    const { html } = renderDirChunkRows(
      listing({
        children: [
          { kind: "dir", name: mefd },
          { kind: "dir", name: "sub-02" },
        ],
      }),
      0,
      2,
    );
    expect(html).toContain(`data-preview-type="eeg"`);
    expect(html).toContain(`data-dir-recording="true"`);
    expect(html).toContain("data-dir-toggle");
  });

  it("renders a .ds dir with a DS badge", () => {
    const html = renderSubdir(
      listing({ path: "sub-01/meg", children: [{ kind: "dir", name: "sub-01_task-rest_meg.ds" }] }),
      2,
    );
    expect(html).toContain(`data-dir-recording="true"`);
    expect(html).toContain(`class="tree__tag tree__tag--signal">DS</span>`);
  });

  it("leaves ordinary dirs untouched (no preview affordance)", () => {
    const html = renderSubdir(
      listing({ path: "sub-01", children: [{ kind: "dir", name: "ieeg" }] }),
      1,
    );
    expect(html).not.toContain("data-preview-type");
    expect(html).not.toContain("data-preview-wrap");
    expect(html.startsWith(`<ul class="tree__children"`)).toBe(true);
  });

  it("recognizes .mefd dirs at the top level too", () => {
    const html = renderTopLevel(listing({ children: [{ kind: "dir", name: mefd }] }));
    expect(html).toContain(`data-preview-type="eeg"`);
    expect(html).toContain(`data-dir-recording="true"`);
  });
});
