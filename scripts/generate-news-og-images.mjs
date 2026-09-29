// Renders one 1200x630 social card per public news post into
// public/og/news-card/<slug>.png (website#371).
//
// Runs in `bun run build` after the dataset cards. The nemar-og-rebuild-cron
// Worker rebuilds the site every four hours, so a new post gets its card
// within that window; until then /og/news/<slug>.png redirects to the post's
// banner (src/pages/og/news/[slug].png.ts).
//
// Never fails the build: news is decorative to a deploy, and the API may not
// serve /news at all yet (the backend and the site deploy independently).
// Any failure is logged and the posts it affects simply get no card.
import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { renderNewsOgSvg } from "../src/lib/news-og-image.ts";
import { parseNewsList } from "../src/lib/news.ts";

const API_BASE = (process.env.PUBLIC_API_BASE_URL ?? "https://api.nemar.org").replace(/\/$/, "");
const OUT_DIR = "public/og/news-card";
const PAGE_SIZE = 50;

if (process.env.NEMAR_SKIP_OG_GENERATE === "1") {
  console.log("[og:news] skipped by NEMAR_SKIP_OG_GENERATE=1");
  process.exit(0);
}

await mkdir(OUT_DIR, { recursive: true });

let posts;
try {
  posts = await fetchAllPosts();
} catch (err) {
  console.warn(`[og:news] no cards rendered: ${err instanceof Error ? err.message : err}`);
  process.exit(0);
}

await initWasm(await Bun.file("node_modules/@resvg/resvg-wasm/index_bg.wasm").arrayBuffer());
const logoSvg = await Bun.file("src/assets/nemar-logo.svg").text();
const fontBuffers = await Promise.all([
  Bun.file("src/assets/fonts/Inter.ttf").bytes(),
  Bun.file("src/assets/fonts/JetBrainsMono.ttf").bytes(),
]);

const expected = new Set();
let rendered = 0;
for (const post of posts) {
  const filename = `${post.slug}.png`;
  try {
    const svg = renderNewsOgSvg(
      {
        title: post.title,
        category: post.category,
        publishedAt: post.published_at,
        bannerDataUri: post.banner_url ? await bannerDataUri(post.banner_url) : null,
      },
      logoSvg,
    );
    const renderer = new Resvg(svg, {
      fitTo: { mode: "original" },
      font: {
        fontBuffers,
        defaultFontFamily: "Inter",
        sansSerifFamily: "Inter",
        monospaceFamily: "monospace",
      },
      shapeRendering: 2,
      textRendering: 1,
      imageRendering: 0,
    });
    try {
      const image = renderer.render();
      try {
        await Bun.write(join(OUT_DIR, filename), image.asPng());
        expected.add(filename);
        rendered += 1;
      } finally {
        image.free();
      }
    } finally {
      renderer.free();
    }
  } catch (err) {
    console.warn(`[og:news] ${post.slug}: ${err instanceof Error ? err.message : err}`);
  }
}

await removeStaleImages(expected);
console.log(`[og:news] rendered ${rendered} of ${posts.length} news cards into ${OUT_DIR}`);

async function fetchAllPosts() {
  const all = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = new URL(`${API_BASE}/news`);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`GET ${url.pathname} answered ${res.status}`);
    const body = await res.json();
    const page = parseNewsList(body);
    all.push(...page);
    const total = typeof body.total_count === "number" ? body.total_count : all.length;
    if (page.length === 0 || all.length >= total) return all;
  }
}

// A banner is `/news/media/<sha256>.<ext>`: fetch it from the API directly
// (the site's own route is a proxy for the same bytes).
//
// resvg decodes PNG, JPEG, and GIF but not WebP, which is what banners are
// usually uploaded as. sharp (already installed as an Astro dependency) turns
// any of them into a PNG sized for the card's frame, which also keeps the
// SVG small. Without sharp, a PNG/JPEG/GIF is embedded as is and a WebP
// banner is left out: the card still renders, in its no-picture layout.
const RESVG_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);
let sharpModule;

async function bannerDataUri(bannerUrl) {
  const res = await fetch(`${API_BASE}${bannerUrl}`);
  if (!res.ok) throw new Error(`banner ${bannerUrl} answered ${res.status}`);
  const type = res.headers.get("content-type")?.split(";")[0] || "";
  const bytes = Buffer.from(await res.arrayBuffer());

  if (sharpModule === undefined) {
    sharpModule = await import("sharp").then((m) => m.default).catch(() => null);
  }
  if (sharpModule) {
    // Twice the frame's 488 px width, for high-density previews.
    const png = await sharpModule(bytes)
      .resize({ width: 976, withoutEnlargement: true })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  }
  if (RESVG_TYPES.has(type)) return `data:${type};base64,${bytes.toString("base64")}`;
  console.warn(
    `[og:news] ${bannerUrl}: ${type || "unknown type"} needs sharp to embed; card has no picture`,
  );
  return null;
}

async function removeStaleImages(keep) {
  const entries = await readdir(OUT_DIR, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((e) => e.isFile() && e.name.endsWith(".png") && !keep.has(e.name))
      .map((e) => unlink(join(OUT_DIR, e.name))),
  );
}
