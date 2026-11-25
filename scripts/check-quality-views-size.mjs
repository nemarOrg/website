/**
 * Size budgets of the quality views' browser code (website ADR 0035 decision 1): the sensor-field
 * worker at most 12 KB gzipped, and the lazy chunk a page loads to draw views at most 30 KB gzipped.
 *
 *   bun scripts/check-quality-views-size.mjs          (also: bun run check:quality-views-size)
 *
 * Two measurements, both gzip at level 9:
 *
 * 1. Always: each entry bundled on its own with Bun's bundler, minified ESM for the browser, the
 *    way a page's build emits it. The worker is `src/lib/quality-views/worker.ts`; the main-thread
 *    side is `worker-client.ts` with `colormap.ts` (the client and the painting a panel needs), the
 *    part of the lazy chunk that exists so far. Phases W4 and W6 add the panel, and with it the rest
 *    of that chunk; until then this is a floor of the chunk, not the chunk.
 * 2. After `bun run build`, when `dist/` exists: every emitted script that carries the worker's or
 *    the client's own error text is measured the same way, so the budget holds on what ships once a
 *    page imports the client. Before then no emitted script carries it, and the script says so.
 *
 * Exits 1 when a measurement is over its budget, and prints every measurement either way.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const KB = 1024;
const BUDGET = { worker: 12 * KB, lazy: 30 * KB };
/** Text only the worker's bundle carries (sensor-field.ts), and only the client's (worker-client.ts). */
const WORKER_MARKER = "no grid cell lies inside the head circle";
const CLIENT_MARKER = "the map worker sent an answer this page cannot read";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lib = join(repo, "src/lib/quality-views");
const gzipped = (bytes) => gzipSync(bytes, { level: 9 }).length;
const kb = (bytes) => `${(bytes / KB).toFixed(1)} KB`;

if (typeof Bun === "undefined") {
  console.error("Run this with Bun: bun scripts/check-quality-views-size.mjs");
  process.exit(1);
}

/** One entry bundled alone (dynamic imports split off), minified: the entry chunk's bytes. */
async function bundle(entry) {
  const outdir = mkdtempSync(join(tmpdir(), "quality-views-size-"));
  try {
    const result = await Bun.build({
      entrypoints: [entry],
      outdir,
      target: "browser",
      format: "esm",
      minify: true,
      splitting: true,
    });
    if (!result.success) {
      for (const message of result.logs) console.error(message);
      throw new Error(`could not bundle ${relative(repo, entry)}`);
    }
    const main = result.outputs.find((output) => output.kind === "entry-point");
    return new Uint8Array(await main.arrayBuffer());
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

const results = [];
function measure(name, bytes, budget) {
  const size = gzipped(bytes);
  results.push({ name, raw: bytes.length, size, budget, over: size > budget });
}

measure("worker (worker.ts, bundled alone)", await bundle(join(lib, "worker.ts")), BUDGET.worker);

const scratch = mkdtempSync(join(tmpdir(), "quality-views-entry-"));
try {
  const entry = join(scratch, "main-thread.ts");
  writeFileSync(
    entry,
    `export * from ${JSON.stringify(join(lib, "worker-client.ts"))};\nexport * from ${JSON.stringify(join(lib, "colormap.ts"))};\n`,
  );
  measure("main thread so far (worker-client.ts + colormap.ts)", await bundle(entry), BUDGET.lazy);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const astroDir = join(repo, "dist", "_astro");
if (existsSync(astroDir)) {
  let found = 0;
  for (const name of readdirSync(astroDir).filter((file) => file.endsWith(".js"))) {
    const bytes = readFileSync(join(astroDir, name));
    const text = bytes.toString("utf8");
    if (text.includes(WORKER_MARKER)) {
      measure(`built worker chunk dist/_astro/${name}`, bytes, BUDGET.worker);
      found++;
    } else if (text.includes(CLIENT_MARKER)) {
      measure(`built lazy chunk dist/_astro/${name}`, bytes, BUDGET.lazy);
      found++;
    }
  }
  if (found === 0) {
    console.log("dist/_astro/ holds no quality-view chunk: no page imports the client yet.");
  }
} else {
  console.log("No dist/: run `bun run build` first to measure the emitted chunks too.");
}

for (const r of results) {
  console.log(
    `${r.over ? "OVER" : "ok  "} ${r.name}: ${kb(r.size)} gzipped (${kb(r.raw)} minified), budget ${kb(r.budget)}`,
  );
}
if (results.some((r) => r.over)) process.exit(1);
