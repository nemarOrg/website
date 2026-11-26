/**
 * Size budgets of the quality views' browser code (website ADR 0035 decision 1), checked after the
 * build: the sensor-field worker at most 12 KB gzipped, and the code a page loads on its main
 * thread to draw views (the lazy chunk and every chunk it imports) at most 30 KB gzipped.
 *
 *   bunx astro build && bun scripts/check-quality-views-size.mjs --require-build   (CI)
 *   bun run check:quality-views-size                                (the same, dist/ optional)
 *
 * Two measurements, both gzip at level 9, both of what Vite emitted, each by
 * `quality-views-size-lib.mjs` (which says what is measured and is tested on its own, in
 * test/quality-views-size.test.ts):
 *
 * 1. The site build in `dist/_astro/`: from each dynamically imported chunk whose static imports
 *    reach the client (the lazy chunk a page loads to draw views), that chunk and every chunk it
 *    imports statically, against the main-thread budget; and the module worker those name, against
 *    the worker budget. So two lazy panels sharing the client are each measured with their own code
 *    (website#592). The signal viewer imports the client lazily, so the client's own chunk is a
 *    root. `--require-build` makes a missing `dist/` an error.
 * 2. Always: the site's own Vite (Astro's copy) builds `worker-client.ts`, `colormap.ts` and the
 *    renderers with their model (`model.ts`, `kinds.ts`, `render/index.ts`) as an entry, in production mode, with the worker emitted by Vite's worker plugin as the site build
 *    emits it, and the same two budgets are applied to what it writes: a floor that holds even
 *    before a panel imports the client.
 *
 * Exits 1 when a measurement is over its budget, and prints every measurement either way.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { kb, measureChunks } from "./quality-views-size-lib.mjs";

const requireBuild = process.argv.includes("--require-build");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lib = join(repo, "src/lib/quality-views");

const results = [];
const notes = [];

/** Every emitted script in `dir`, by name. */
function scripts(dir) {
  return new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => [name, readFileSync(join(dir, name))]),
  );
}

/** Measure one directory; `label` names it in the output. */
function measure(label, dir) {
  const measured = measureChunks(label, scripts(dir));
  results.push(...measured.results);
  notes.push(...measured.notes);
  return measured;
}

// 1. The site build.
const astroDir = join(repo, "dist", "_astro");
if (existsSync(astroDir)) {
  const { clients } = measure("site build", astroDir);
  if (clients.length === 0) {
    console.error(
      "site build: no emitted script carries the client, though the viewer imports it.",
    );
    process.exit(1);
  }
} else if (requireBuild) {
  console.error("No dist/_astro/: run `bunx astro build` first (--require-build).");
  process.exit(1);
} else {
  notes.push("No dist/: run `bunx astro build` first to measure the site build too.");
}

// 2. The site's own Vite, building the client and the color maps as an entry.
const requireFromAstro = createRequire(join(repo, "node_modules", "astro", "package.json"));
const vite = await import(pathToFileURL(requireFromAstro.resolve("vite")).href);
const scratch = mkdtempSync(join(tmpdir(), "quality-views-size-"));
try {
  const entry = join(scratch, "measured.ts");
  writeFileSync(
    entry,
    [
      "worker-client.ts",
      "colormap.ts",
      // The renderers and the model a panel draws views with (phase W4), so the floor holds the
      // panel's drawing code before a panel imports it.
      "model.ts",
      "kinds.ts",
      "render/index.ts",
    ]
      .map((file) => `export * from ${JSON.stringify(join(lib, file))};\n`)
      .join(""),
  );
  const outDir = join(scratch, "out");
  await vite.build({
    configFile: false,
    root: repo,
    logLevel: "warn",
    publicDir: false,
    mode: "production",
    build: {
      outDir,
      assetsDir: "",
      emptyOutDir: true,
      rollupOptions: {
        input: { quality: entry },
        // An entry's exports are what a page would import; without this they are shaken out.
        preserveEntrySignatures: "exports-only",
        output: { entryFileNames: "measured-entry-[hash].js" },
      },
    },
  });
  const entries = readdirSync(outDir).filter((name) => /^measured-entry-[\w-]+\.js$/.test(name));
  if (entries.length !== 1) throw new Error(`the entry build wrote ${entries.length} entry chunks`);
  measure(`Vite ${vite.version} entry build`, outDir);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

for (const note of notes) console.log(note);
for (const r of results) {
  const over = r.size > r.budget;
  console.log(
    `${over ? "OVER" : "ok  "} ${r.label}: ${kb(r.size)} gzipped (${kb(r.raw)} minified), budget ${kb(r.budget)}`,
  );
}
if (results.some((r) => r.size > r.budget)) process.exit(1);
