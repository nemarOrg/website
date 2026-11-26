/**
 * Where the dataset quality summary is drawn: on the dataset page, through DatasetTabs, and nowhere
 * on the embed route (ADR 0023: the embed is the signal viewer alone). The check follows each
 * page's static imports, relative ones, through `.astro` and `.ts` files, so a summary reached by
 * any path is found; the dataset page itself is the control that the walk reaches it.
 *
 * And DatasetTabs' source: no "coming soon" placeholder, and the dataset page hands it the summary
 * it read. What DatasetTabs renders for each summary is test/dataset-tabs.astro.test.ts.
 */

import { describe, expect, it } from "vitest";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const source = (path: string) => fs.readFileSync(repoPath(path), "utf8");

/** The relative modules `path` imports statically, resolved to files of the repo. */
function importsOf(path: string): string[] {
  const text = source(path);
  const dir = path.slice(0, path.lastIndexOf("/"));
  const specifiers = [
    ...text.matchAll(
      /(?:^|[\s;])import\s+(type\s+)?(?:[\w$*{}\s,]+\s+from\s+)?["'](\.{1,2}\/[^"'?]+)["']/g,
    ),
  ]
    // A type-only import brings no code to the page.
    .filter((m) => m[1] === undefined)
    .map((m) => m[2]);
  const out: string[] = [];
  for (const specifier of specifiers) {
    const parts = `${dir}/${specifier}`.split("/");
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "..") resolved.pop();
      else if (part !== ".") resolved.push(part);
    }
    const base = resolved.join("/");
    const file = [base, `${base}.ts`, `${base}/index.ts`].find(
      (p) => fs.existsSync(repoPath(p)) && !fs.statSync(repoPath(p)).isDirectory(),
    );
    if (file) out.push(file);
  }
  return out;
}

/** Every file `root` reaches through static relative imports, itself included. */
function reach(root: string): Set<string> {
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (!/\.(astro|ts)$/.test(next)) continue;
    for (const file of importsOf(next)) {
      if (!seen.has(file)) {
        seen.add(file);
        queue.push(file);
      }
    }
  }
  return seen;
}

const SUMMARY = [
  "src/components/quality/DatasetQualitySummary.astro",
  "src/lib/quality-views/dataset-summary.ts",
  "src/components/DatasetTabs.astro",
];

describe("where the summary is drawn", () => {
  it("the dataset page reaches it (the control)", () => {
    const page = reach("src/pages/dataset/[id].astro");
    for (const file of SUMMARY) expect(page, file).toContain(file);
  });

  it("the embed route renders no quality data", () => {
    const embed = reach("src/pages/dataset/[id]/embed.astro");
    expect(embed.size).toBeGreaterThan(5);
    for (const file of SUMMARY) expect(embed, file).not.toContain(file);
    for (const file of embed) {
      if (file.endsWith(".astro"))
        expect(source(file), file).not.toMatch(/dataQuality|readQualitySummary/);
    }
  });
});

describe("DatasetTabs", () => {
  const tabs = source("src/components/DatasetTabs.astro");

  it("has no placeholder left", () => {
    expect(tabs).not.toMatch(/coming soon/i);
    expect(tabs).not.toMatch(/dtabs__soon|dtabs__tab--soon|nemar-cli\/issues\/511/);
  });

  it("is given the summary the dataset page read from metadata.json", () => {
    expect(source("src/pages/dataset/[id].astro")).toMatch(
      /quality=\{readQualitySummary\(metadata, id\)\}/,
    );
  });
});
