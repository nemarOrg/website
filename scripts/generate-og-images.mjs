import { access, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { buildDatasetOgModel, renderDatasetOgSvg } from "../src/lib/og-image.ts";

const API_BASE = (process.env.PUBLIC_API_BASE_URL ?? "https://api.nemar.org").replace(/\/$/, "");
const CACHE_BASE = (process.env.NEMAR_OG_CACHE_BASE_URL ?? "https://ww2.nemar.org").replace(
  /\/$/,
  "",
);
const FORCE_REFRESH = process.env.NEMAR_OG_REFRESH === "1";
const OUT_DIR = "public/og/dataset-card";
const PAGE_SIZE = 200;

if (process.env.NEMAR_SKIP_OG_GENERATE === "1") {
  console.log("[og] skipped by NEMAR_SKIP_OG_GENERATE=1");
  process.exit(0);
}

await mkdir(OUT_DIR, { recursive: true });

const datasets = await fetchAllDatasets();
const expected = new Set();
const counts = { local: 0, remote: 0, rendered: 0 };
let resvgReady = null;
let logoSvg = "";

for (const dataset of datasets) {
  const id = dataset.dataset_id || dataset.id;
  if (!id) continue;
  const filename = `${id}.png`;
  const outputPath = join(OUT_DIR, filename);
  expected.add(filename);

  if (!FORCE_REFRESH && (await fileExists(outputPath))) {
    counts.local += 1;
    continue;
  }

  if (!FORCE_REFRESH && (await copyCachedImage(id, outputPath))) {
    counts.remote += 1;
    continue;
  }

  await ensureResvg();
  const model = buildDatasetOgModel({ id, catalog: dataset });
  const svg = renderDatasetOgSvg(model, logoSvg);
  const renderer = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "Arial",
      sansSerifFamily: "Arial",
      monospaceFamily: "monospace",
    },
    shapeRendering: 2,
    textRendering: 1,
    imageRendering: 0,
  });

  try {
    const image = renderer.render();
    try {
      await Bun.write(outputPath, image.asPng());
      counts.rendered += 1;
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}

await removeStaleImages(expected);
console.log(
  `[og] ready ${expected.size} dataset cards in ${OUT_DIR} (${counts.local} local, ${counts.remote} cache, ${counts.rendered} rendered)`,
);

async function ensureResvg() {
  if (!resvgReady) {
    resvgReady = initWasm(
      await Bun.file("node_modules/@resvg/resvg-wasm/index_bg.wasm").arrayBuffer(),
    );
    logoSvg = await Bun.file("src/assets/nemar-logo.svg").text();
  }
  await resvgReady;
}

async function fetchAllDatasets() {
  const datasets = [];
  let total = Number.POSITIVE_INFINITY;

  for (let offset = 0; offset < total; offset += PAGE_SIZE) {
    const url = new URL(`${API_BASE}/datasets`);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sort", "newest");

    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`[og] catalog fetch failed: ${res.status} ${res.statusText}`);
    }

    const page = await res.json();
    datasets.push(...page.datasets);
    total = page.total_count;
    if (page.datasets.length === 0) break;
  }

  return datasets;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyCachedImage(id, outputPath) {
  if (!CACHE_BASE) return false;
  const url = new URL(`/og/dataset-card/${encodeURIComponent(id)}.png`, CACHE_BASE);
  try {
    const res = await fetch(url, { headers: { Accept: "image/png" } });
    if (!res.ok || !res.headers.get("content-type")?.includes("image/png")) return false;
    await Bun.write(outputPath, await res.arrayBuffer());
    return true;
  } catch {
    return false;
  }
}

async function removeStaleImages(expected) {
  const entries = await readdir(OUT_DIR, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".png") && !expected.has(entry.name))
      .map((entry) => unlink(join(OUT_DIR, entry.name))),
  );
}
