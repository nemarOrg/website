/**
 * Creates the first news posts (scripts/news-seed/posts.ts) through the
 * admin API, uploading each banner first (website#371).
 *
 *   NEMAR_API_KEY=... bun scripts/seed-news.mjs --api https://api-test.nemar.org --images ~/Desktop
 *
 * Needs an admin's API key (the same kind the `nemar` CLI uses). PNG
 * screenshots are converted to WebP first (at most 2000 px wide, quality 88)
 * when ImageMagick's `magick` is on the PATH, which cuts a retina screenshot
 * from over a megabyte to a few hundred kilobytes. Safe to re-run: a slug that already exists is left alone unless `--update` is
 * passed, which rewrites it from the seed. `--dry-run` prints the plan and
 * sends nothing.
 */
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NEWS_MEDIA_TYPES } from "../src/lib/news.ts";
import { SEED_POSTS } from "./news-seed/posts.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const api = (option("api") ?? "").replace(/\/$/, "");
const images = option("images");
const key = process.env.NEMAR_API_KEY;
const dryRun = flag("dry-run");
const update = flag("update");

if (!api || !images || (!key && !dryRun)) {
  console.error(
    "Usage: NEMAR_API_KEY=... bun scripts/seed-news.mjs --api <api origin> --images <dir> [--update] [--dry-run]",
  );
  process.exit(2);
}

const auth = { Authorization: `Bearer ${key}` };

async function call(method, path, init = {}) {
  const res = await fetch(`${api}${path}`, {
    ...init,
    method,
    headers: { Accept: "application/json", ...auth, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const typeFor = (file) => {
  const ext = file.toLowerCase().split(".").pop() ?? "";
  const type = NEWS_MEDIA_TYPES[ext === "jpeg" ? "jpg" : ext];
  if (!type) throw new Error(`${file}: not a PNG, JPEG, WebP, or GIF`);
  return type;
};

const existing = new Map();
if (!dryRun) {
  const list = await call("GET", "/admin/news");
  for (const p of list.posts ?? []) existing.set(p.slug, p.id);
}

for (const post of SEED_POSTS) {
  const id = existing.get(post.slug);
  if (id !== undefined && !update) {
    console.log(`skip    ${post.slug} (exists as #${id})`);
    continue;
  }
  const bannerPath = join(images, post.banner);
  const file = Bun.file(bannerPath);
  if (!(await file.exists())) throw new Error(`missing banner ${bannerPath}`);
  if (dryRun) {
    console.log(
      `${id === undefined ? "create" : "update"}  ${post.slug} with ${basename(bannerPath)}`,
    );
    continue;
  }

  const upload = await prepare(bannerPath);
  const media = await call("POST", "/admin/news/media", {
    headers: { "Content-Type": typeFor(upload) },
    body: await Bun.file(upload).arrayBuffer(),
  });

  const input = {
    slug: post.slug,
    title: post.title,
    summary: post.summary,
    body: post.body,
    category: post.category,
    banner_url: media.url,
    banner_alt: post.banner_alt,
    status: "published",
    published_at: post.published_at,
  };
  const saved = await call(
    id === undefined ? "POST" : "PUT",
    id === undefined ? "/admin/news" : `/admin/news/${id}`,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  console.log(
    `${id === undefined ? "created" : "updated"} ${post.slug} as #${saved.post?.id ?? id}`,
  );
}

/** A WebP copy of a PNG when ImageMagick is available, else the file itself. */
async function prepare(path) {
  if (!path.toLowerCase().endsWith(".png") || !Bun.which("magick")) return path;
  const out = join(tmpdir(), `${basename(path, ".png")}.webp`);
  const proc = Bun.spawn(["magick", path, "-resize", "2000x>", "-quality", "88", out]);
  if ((await proc.exited) !== 0) return path;
  const before = Bun.file(path).size;
  const after = Bun.file(out).size;
  console.log(`        ${basename(path)} ${kb(before)} -> ${basename(out)} ${kb(after)}`);
  return after < before ? out : path;
}

function kb(bytes) {
  return `${Math.round(bytes / 1024)} KB`;
}
