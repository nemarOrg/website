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
import { describe, expect, it } from "vitest";

/** `node:fs` reached without a static import (no `@types/node` here); see the OIDC contract drift test. */
interface Dirent {
  name: string;
  isDirectory(): boolean;
}
interface NodeFs {
  readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  readFileSync(path: string, encoding: string): string;
}
const fsSpecifier = "node:fs";
const fs = (await import(/* @vite-ignore */ fsSpecifier)) as NodeFs;

/** The test's own location, so the path does not depend on the working directory. */
const DIST = `${decodeURIComponent(new URL("../node_modules/astro/dist", import.meta.url).pathname)}`;

function jsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return jsFiles(path);
    return entry.name.endsWith(".js") ? [path] : [];
  });
}

const read = (file: string) => fs.readFileSync(`${DIST}/${file}`, "utf8");

const MENTIONS = jsFiles(DIST)
  .map((file) => file.slice(DIST.length + 1))
  .filter((file) => read(file).includes("checkOrigin"))
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
    const readers = MENTIONS.filter((file) => /manifest\.checkOrigin/.test(read(file)));
    expect(readers).toEqual(["core/base-pipeline.js"]);
    const pipeline = read("core/base-pipeline.js");
    expect(pipeline).toMatch(
      /if \(this\.manifest\.checkOrigin\) \{\s*internalMiddlewares\.unshift\(createOriginCheckMiddleware\(\)\);/,
    );
  });
});
