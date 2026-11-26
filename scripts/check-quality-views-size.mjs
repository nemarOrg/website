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
import {
  BUDGET,
  dynamicImports,
  gzipped,
  kb,
  measureChunks,
  staticClosure,
} from "./quality-views-size-lib.mjs";

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
      // The model and the renderers' dispatch a panel draws views with (phase W4), so the floor
      // holds the panel's drawing code before a panel imports it. The guards and the renderer rule
      // (kinds.ts) run in the worker, and each renderer is a lazy chunk, measured below.
      "model.ts",
      "checks.ts",
      "render/index.ts",
      // The idle-time preload a dataset page runs before the panel opens (W6's trigger).
      "prepare-ahead.ts",
    ]
      .map((file) => `export * from ${JSON.stringify(join(lib, file))};\n`)
      .join(""),
  );
  const outDir = join(scratch, "out");
  const output = await vite.build({
    configFile: false,
    root: repo,
    logLevel: "warn",
    publicDir: false,
    mode: "production",
    // As the site builds it (astro.config.mjs): the map worker has a lazy chunk.
    worker: { format: "es" },
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
  lazyRenderers(`Vite ${vite.version} entry build`, Array.isArray(output) ? output[0] : output, outDir);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/**
 * Each renderer is a chunk of its own, loaded when its kind is drawn (the owner's ruling on #594):
 * each is measured with the entry's static set, which is what a page holds once it draws that
 * kind, against the main-thread budget. Activations (W7, `transforms/`, `activations.ts`) and
 * exports (W8, `export/`) must be lazy chunks of their own too: none may sit in the entry's static
 * set, and each such chunk is measured the same way.
 */
function lazyRenderers(label, rollup, dir) {
  const chunks = new Map(rollup.output.filter((o) => o.type === "chunk").map((c) => [c.fileName, c]));
  const entry = [...chunks.values()].find((c) => c.isEntry);
  const closure = (start) => {
    const seen = new Set();
    const queue = [start];
    while (queue.length > 0) {
      const name = queue.pop();
      if (seen.has(name) || !chunks.has(name)) continue;
      seen.add(name);
      queue.push(...chunks.get(name).imports);
    }
    return seen;
  };
  const base = closure(entry.fileName);
  const lazyKind = /\/quality-views\/(render\/|export\/|transforms\/|activations\.ts)/;
  // Only when the worker cannot start does the page check views itself (local-checks.ts, which
  // loads the guards); that set is printed, not gated, since no first screen loads it.
  const fallbackKind = /\/quality-views\/(local-checks\.ts|guards-computed\.ts)/;
  const mustBeLazy = /\/quality-views\/(export\/|transforms\/|activations\.ts)/;
  for (const name of base) {
    const held = chunks.get(name).moduleIds.filter((id) => mustBeLazy.test(id));
    if (held.length > 0) {
      results.push({
        label: `${label}: ${held.join(", ")} must load lazily, not with the entry (${name})`,
        size: 1,
        raw: 0,
        budget: 0,
      });
    }
  }
  // Lazy chunks of the entry's set, and theirs in turn (guards-computed loads from local-checks).
  const lazy = new Set();
  const visit = (name) => {
    for (const d of chunks.get(name)?.dynamicImports ?? []) {
      if (lazy.has(d)) continue;
      lazy.add(d);
      for (const member of closure(d)) visit(member);
    }
  };
  for (const name of base) visit(name);
  const sizeOf = (set) => {
    let size = 0;
    let raw = 0;
    const all = [];
    for (const member of set) {
      const bytes = readFileSync(join(dir, member));
      size += gzipped(bytes);
      raw += bytes.length;
      all.push(bytes);
    }
    return { size, raw, together: gzipped(Buffer.concat(all)) };
  };
  const ownOf = (chunk, kind) =>
    chunk.moduleIds.filter((id) => kind.test(id)).map((id) => id.replace(/^.*\/quality-views\//, ""));
  /** The lazy chunk holding a module of this path, by file name. */
  const holding = (path) =>
    [...lazy].find((name) => chunks.get(name)?.moduleIds.some((id) => id.endsWith(`/quality-views/${path}`)));
  let measured = 0;
  for (const name of [...lazy].sort()) {
    const chunk = chunks.get(name);
    if (!chunk) continue;
    if (chunk.moduleIds.some((id) => lazyKind.test(id))) {
      const { size, raw } = sizeOf(new Set([...base, ...closure(name)]));
      results.push({
        label: `${label}: main thread with the lazy ${ownOf(chunk, lazyKind).join(", ")} (${name})`,
        size,
        raw,
        budget: BUDGET.mainThread,
      });
      measured++;
    } else if (chunk.moduleIds.some((id) => fallbackKind.test(id))) {
      const parents = [...lazy].filter((p) => chunks.get(p)?.dynamicImports.includes(name));
      const set = new Set([...base, ...closure(name), ...parents.flatMap((p) => [...closure(p)])]);
      notes.push(
        `${label}: with the page's own checks (${ownOf(chunk, fallbackKind).join(", ")}), loaded only when the worker cannot start: ${kb(sizeOf(set).size)} gzipped, not gated.`,
      );
    }
  }
  if (measured === 0) throw new Error(`${label}: no lazy renderer chunk was found`);
  // What a first screen loads, gated as one union gzipped together (the review of #594): each
  // tab's renderers with the entry. The sum of each file's own gzip is printed beside it.
  for (const [tab, paths] of [
    ["Spectrum tab (lines and scalp maps)", ["render/lines.ts", "render/sensor-field-view.ts"]],
    ["Components tab (scalp maps and histogram)", ["render/sensor-field-view.ts", "render/histogram.ts"]],
  ]) {
    const set = new Set(base);
    for (const path of paths) {
      const name = holding(path);
      if (!name) throw new Error(`${label}: no lazy chunk holds ${path}`);
      for (const member of closure(name)) set.add(member);
    }
    const { size, raw, together } = sizeOf(set);
    results.push({
      label: `${label}: first screen, ${tab}, ${set.size} files gzipped together (${kb(size)} as separate files)`,
      size: together,
      raw,
      budget: BUDGET.mainThread,
    });
  }
  // The module worker with its lazy chunk (the computed presets' schemas), gzipped together,
  // against the worker budget. The module worker is the file a chunk names in `new Worker(new
  // URL(...))`; the client's in-thread fallback for a browser without workers is another file.
  const files = new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith(".js"))
      .map((f) => [f, readFileSync(join(dir, f))]),
  );
  const moduleWorkers = new Set();
  for (const bytes of files.values()) {
    for (const m of bytes.toString("utf8").matchAll(/new Worker\(\s*new URL\(\s*["']([^"']+\.js)["']/g)) {
      moduleWorkers.add(m[1].replace(/^.*\//, ""));
    }
  }
  if (moduleWorkers.size === 0) throw new Error(`${label}: no module worker is named`);
  for (const workerName of moduleWorkers) {
    const bytes = files.get(workerName);
    if (!bytes) throw new Error(`${label}: the worker ${workerName} was not emitted`);
    const extra = dynamicImports(bytes.toString("utf8"), files);
    const set = staticClosure([workerName, ...extra], files);
    const { size, raw, together } = sizeOf(set);
    results.push({
      label: `${label}: worker ${workerName} with its lazy ${extra.join(", ") || "(none)"}, gzipped together (${kb(size)} as separate files)`,
      size: together,
      raw,
      budget: BUDGET.worker,
    });
    for (const name of extra) {
      notes.push(
        `${label}: the worker's lazy chunk ${name}: ${kb(gzipped(files.get(name)))} gzipped on its own.`,
      );
    }
  }
}

for (const note of notes) console.log(note);
for (const r of results) {
  const over = r.size > r.budget;
  console.log(
    `${over ? "OVER" : "ok  "} ${r.label}: ${kb(r.size)} gzipped (${kb(r.raw)} minified), budget ${kb(r.budget)}`,
  );
}
if (results.some((r) => r.size > r.budget)) process.exit(1);
