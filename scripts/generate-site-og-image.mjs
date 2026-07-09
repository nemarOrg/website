import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { renderSiteOgSvg } from "../src/lib/site-og-image.ts";
import { aggregateHostedStats } from "../src/lib/stats.ts";

// Regenerates public/og-image.png (the site-wide share card) with live hosted
// totals. Runs as part of `bun run build`, so every deploy and every 4h OG
// cron rebuild refreshes the numbers. The template lives in
// src/lib/site-og-image.ts; this script only supplies the three stats and
// rasterizes.

const API_BASE = (process.env.PUBLIC_API_BASE_URL ?? "https://api.nemar.org").replace(/\/$/, "");
const OUT_PATH = "public/og-image.png";
const PAGE_SIZE = 200;

// Last-resort figures if the catalog is unreachable at build time. Keeps a
// transient API blip from failing the deploy with a broken share image; the
// next rebuild replaces them with live numbers. An independent point-in-time
// snapshot — not required to match the homepage hero's fallback exactly, it
// only needs to be plausible on the rare occasion it renders.
const FALLBACK_STATS = { datasets: 759, participants: 35_503, size: 54 * 1024 ** 4 };

if (process.env.NEMAR_SKIP_OG_GENERATE === "1") {
  console.log("[site-og] skipped by NEMAR_SKIP_OG_GENERATE=1");
  process.exit(0);
}

const stats = await fetchHostedStats().catch((err) => {
  console.warn(`[site-og] catalog fetch failed, using fallback stats: ${err}`);
  return FALLBACK_STATS;
});

await initWasm(await Bun.file("node_modules/@resvg/resvg-wasm/index_bg.wasm").arrayBuffer());
const logoSvg = await Bun.file("src/assets/nemar-logo.svg").text();
const fontBuffers = await Promise.all([
  Bun.file("src/assets/fonts/Inter.ttf").bytes(),
  Bun.file("src/assets/fonts/JetBrainsMono.ttf").bytes(),
]);

const svg = renderSiteOgSvg(stats, logoSvg);
const renderer = new Resvg(svg, {
  fitTo: { mode: "original" },
  font: {
    fontBuffers,
    defaultFontFamily: "Inter",
    sansSerifFamily: "Inter",
    monospaceFamily: "JetBrains Mono",
  },
  shapeRendering: 2,
  textRendering: 1,
  imageRendering: 0,
});

try {
  const image = renderer.render();
  try {
    await Bun.write(OUT_PATH, image.asPng());
  } finally {
    image.free();
  }
} finally {
  renderer.free();
}

console.log(
  `[site-og] wrote ${OUT_PATH} — ${stats.datasets} datasets, ${stats.participants} participants, ${stats.size} bytes`,
);

/**
 * Page the whole catalog and aggregate the hosted (`managed`) subset via the
 * shared aggregateHostedStats() from src/lib/stats.ts, so the OG card uses the
 * exact same classification/summation rule as the homepage hero (no drift).
 * Only the paging is local — kept hermetic like scripts/generate-og-images.mjs,
 * which avoids importing api.ts's Vite-env-dependent client.
 */
async function fetchHostedStats() {
  const rows = [];
  let total = Number.POSITIVE_INFINITY;

  for (let offset = 0; offset < total; offset += PAGE_SIZE) {
    const url = new URL(`${API_BASE}/datasets`);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sort", "newest");

    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`catalog fetch failed: ${res.status} ${res.statusText}`);
    }

    const page = await res.json();
    rows.push(...page.datasets);
    total = page.total_count;
    if (page.datasets.length === 0) break;
  }

  // Same completeness guard as src/lib/stats.ts: offset paging steps by a full
  // page even when the API returns a short (non-empty) page, so a drifted
  // total_count or a partial response would silently understate the totals.
  // Warn (surfaces in the build log) rather than bake a wrong number into the
  // share card; the fallback only triggers on the thrown !ok response above.
  if (Number.isFinite(total) && total > PAGE_SIZE && rows.length < total * 0.9) {
    console.warn(
      `[site-og] expected ~${total} catalog rows, received ${rows.length}; hosted totals may be understated`,
    );
  }

  return aggregateHostedStats(rows);
}
