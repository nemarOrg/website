/**
 * Astro drops a whitespace-only text between two expressions when they are a component's children
 * rather than an HTML element's: `<Fragment slot="lede">{a} {b}</Fragment>` renders `ab`. The
 * admin Pipelines pages printed "This page showsone recipe's runs" that way. A slotted Fragment's
 * text joins its parts in one template literal, or separates them with `{" "}`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;

function astroFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = join(dir, entry.name);
    if (entry.isDirectory()) return astroFiles(at);
    return entry.name.endsWith(".astro") ? [at] : [];
  });
}

describe("slotted Fragments keep the spaces between their expressions", () => {
  it("no slotted Fragment separates two expressions by bare whitespace", () => {
    const offenders: string[] = [];
    for (const file of astroFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/<Fragment slot="[^"]*">([\s\S]*?)<\/Fragment>/g)) {
        const body = m[1].replaceAll('{" "}', "␠");
        if (/\}\s+\{/.test(body)) offenders.push(`${file.slice(SRC.length)}: ${body.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
