/**
 * Size budgets of the quality views' browser code (website ADR 0035 decision 1), checked after the
 * build: the sensor-field worker at most 12 KB gzipped, and the code a page loads on its main
 * thread to draw views (the lazy chunk and every chunk it imports) at most 30 KB gzipped.
 *
 *   bunx astro build && bun scripts/check-quality-views-size.mjs --require-build   (CI)
 *   bun run check:quality-views-size                                (the same, dist/ optional)
 *
 * Two measurements, both gzip at level 9, both of what Vite emitted:
 *
 * 1. The site build in `dist/_astro/`: the main-thread part is every emitted script that carries
 *    the client's own error text, with each chunk it imports statically; the module worker is the
 *    file a `new Worker(new URL(...))` among them names. A chunk imported only dynamically (the
 *    fallback for a browser without workers) is listed but not counted. Until a page imports the
 *    client (phases W4 and W6) no emitted script carries it, and the script says so;
 *    `--require-build` makes a missing `dist/` an error.
 * 2. Always: the site's own Vite (Astro's copy) builds `worker-client.ts` and `colormap.ts` as an
 *    entry, in production mode, with the worker emitted by Vite's worker plugin as the site build
 *    emits it, and the same two budgets are applied to what it writes. Until a page imports the
 *    client this is the measurement; after, it is a floor of (1).
 *
 * Exits 1 when a measurement is over its budget, and prints every measurement either way.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const KB = 1024;
const BUDGET = { worker: 12 * KB, mainThread: 30 * KB };
/** Text only the client carries (`UNREADABLE_ANSWER` in worker-client.ts). */
const CLIENT_MARKER = "the map worker sent an answer this page cannot read";

const requireBuild = process.argv.includes("--require-build");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lib = join(repo, "src/lib/quality-views");
const gzipped = (bytes) => gzipSync(bytes, { level: 9 }).length;
const kb = (bytes) => `${(bytes / KB).toFixed(1)} KB`;

const results = [];
const notes = [];

/**
 * Measure one directory of emitted scripts: the main-thread set grown from `roots` along static
 * imports, and the module worker(s) a `new Worker(new URL(...))` in that set names.
 */
function measure(label, dir, roots) {
  const files = new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => [name, readFileSync(join(dir, name))]),
  );
  const text = (name) => files.get(name).toString("utf8");
  const staticImports = (name) =>
    [
      ...text(name).matchAll(
        /(?:^|[;}\s])import\s*(?:[\w$*{}\s,]+from\s*)?["']\.\/([^"']+\.js)["']/g,
      ),
    ]
      .map((m) => m[1])
      .filter((file) => files.has(file));
  const dynamicImports = (name) =>
    [...text(name).matchAll(/import\(\s*["']\.\/([^"']+\.js)["']\s*\)/g)]
      .map((m) => m[1])
      .filter((file) => files.has(file));

  const mainThread = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop();
    if (mainThread.has(name)) continue;
    mainThread.add(name);
    queue.push(...staticImports(name));
  }
  if (![...mainThread].some((name) => text(name).includes(CLIENT_MARKER))) {
    throw new Error(`${label}: the main-thread set ${[...mainThread]} does not hold the client`);
  }
  const workers = new Set();
  const lazy = new Set();
  for (const name of mainThread) {
    for (const m of text(name).matchAll(/new Worker\(\s*new URL\(\s*["']([^"']+\.js)["']/g)) {
      workers.add(basename(m[1]));
    }
    for (const file of dynamicImports(name)) if (!mainThread.has(file)) lazy.add(file);
  }
  if (workers.size === 0) throw new Error(`${label}: no module worker is named by ${[...roots]}`);
  for (const name of workers) {
    if (!files.has(name)) throw new Error(`${label}: the worker ${name} was not emitted`);
    results.push({
      label: `${label}: worker ${name}`,
      size: gzipped(files.get(name)),
      raw: files.get(name).length,
      budget: BUDGET.worker,
    });
  }
  let size = 0;
  let raw = 0;
  for (const name of mainThread) {
    size += gzipped(files.get(name));
    raw += files.get(name).length;
  }
  results.push({
    label: `${label}: main thread (${[...mainThread].sort().join(" + ")})`,
    size,
    raw,
    budget: BUDGET.mainThread,
  });
  for (const name of lazy) {
    notes.push(
      `${label}: ${name} (${kb(gzipped(files.get(name)))} gzipped) is imported only dynamically, by the fallback for a browser without workers, and is not counted.`,
    );
  }
}

// 1. The site build.
const astroDir = join(repo, "dist", "_astro");
if (existsSync(astroDir)) {
  const roots = readdirSync(astroDir).filter(
    (name) =>
      name.endsWith(".js") && readFileSync(join(astroDir, name), "utf8").includes(CLIENT_MARKER),
  );
  if (roots.length === 0) {
    notes.push("site build: no emitted script carries the client yet (no page imports it).");
  } else {
    measure("site build", astroDir, roots);
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
    `export * from ${JSON.stringify(join(lib, "worker-client.ts"))};\nexport * from ${JSON.stringify(join(lib, "colormap.ts"))};\n`,
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
  const roots = readdirSync(outDir).filter((name) => /^measured-entry-[\w-]+\.js$/.test(name));
  if (roots.length !== 1) throw new Error(`the entry build wrote ${roots.length} entry chunks`);
  measure(`Vite ${vite.version} entry build`, outDir, roots);
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
