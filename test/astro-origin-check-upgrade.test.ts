/**
 * Upgrade guard for ADR 0031. Astro's `security.checkOrigin` is OFF here and the site's own check
 * (`src/lib/origin-check.ts`) stands in for the built-in. That is safe only while the option gates
 * nothing but the built-in origin check. This test reads Astro's compiled output and fails when any
 * file other than the known ones mentions the option, or when anything but `core/base-pipeline.js`
 * READS it off the manifest, so an upgrade that ties another protection to it fails loudly.
 *
 * On an Astro upgrade that fails here: read what `checkOrigin` now gates, decide whether the site's
 * check must replace that too, update the lists below and ADR 0031, and re-run
 * `src/lib/origin-check.test.ts`, which compares the site's rule with Astro's built-in.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const DIST = join(__dirname, "..", "node_modules", "astro", "dist");

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.name.endsWith(".js") ? [path] : [];
  });
}

const MENTIONS = jsFiles(DIST)
  .filter((file) => readFileSync(file, "utf8").includes("checkOrigin"))
  .map((file) => relative(DIST, file))
  .sort();

describe("what Astro's checkOrigin option reaches", () => {
  it("is mentioned only by the config schema, the manifest writers and the pipeline", () => {
    expect(MENTIONS).toEqual([
      "container/index.js",
      "core/base-pipeline.js",
      "core/build/plugins/plugin-manifest.js",
      "core/config/schemas/base.js",
      "manifest/serialized.js",
    ]);
  });

  it("is READ (off the manifest) by core/base-pipeline.js alone, where it adds the origin check", () => {
    const readers = MENTIONS.filter((file) =>
      /manifest\.checkOrigin/.test(readFileSync(join(DIST, file), "utf8")),
    );
    expect(readers).toEqual(["core/base-pipeline.js"]);
    const pipeline = readFileSync(join(DIST, "core/base-pipeline.js"), "utf8");
    expect(pipeline).toMatch(
      /if \(this\.manifest\.checkOrigin\) \{\s*internalMiddlewares\.unshift\(createOriginCheckMiddleware\(\)\);/,
    );
  });
});
