import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Runs scripts/generate-news-og-images.mjs for real, under Bun, against a
 * local server that answers like api.nemar.org. Its unit, renderNewsOgSvg, is
 * tested on its own; this covers the script around it, whose top-level order
 * once made every card throw before rendering, which the build's soft-fail
 * hid (0.2.22 shipped with no news cards).
 *
 * The server replays `/news` as captured from production and answers each
 * banner with the site's own committed og-image.png: real image bytes, which
 * the script sends through sharp exactly as it does a WebP banner.
 */

const ROOT = join(__dirname, "..");
const NEWS_LIST = readFileSync(join(ROOT, "test/fixtures/news-list-production.json"), "utf8");
const BANNER = readFileSync(join(ROOT, "public/og-image.png"));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let server: Server | undefined;
let outDir: string | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  if (outDir) await rm(outDir, { recursive: true, force: true });
  outDir = undefined;
});

async function serveApi(withNews: boolean): Promise<string> {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (withNews && path === "/news") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(NEWS_LIST);
    } else if (withNews && path.startsWith("/news/media/")) {
      res.writeHead(200, { "Content-Type": "image/png" }).end(BANNER);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not_found"}');
    }
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function runScript(apiBase: string, dir: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    // Without the skip flag a developer may have exported, which would make this a no-op.
    const { NEMAR_SKIP_OG_GENERATE: _skip, ...inherited } = process.env;
    const env = { ...inherited, PUBLIC_API_BASE_URL: apiBase, NEMAR_NEWS_OG_OUT_DIR: dir };
    const child = spawn("bun", ["scripts/generate-news-og-images.mjs"], { cwd: ROOT, env });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

describe("generate-news-og-images.mjs", () => {
  it("renders a 1200x630 PNG card for every published post", async () => {
    const posts = JSON.parse(NEWS_LIST).posts as { slug: string }[];
    outDir = await mkdtemp(join(tmpdir(), "news-og-"));

    const { code, output } = await runScript(await serveApi(true), outDir);

    expect(output).not.toContain("WARNING");
    expect(output).toContain(`rendered ${posts.length} of ${posts.length} news cards`);
    expect(code).toBe(0);
    const files = (await readdir(outDir)).sort();
    expect(files).toEqual(posts.map((p) => `${p.slug}.png`).sort());
    for (const file of files) {
      const png = await readFile(join(outDir, file));
      expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      // IHDR: width and height, big-endian, right after the chunk header.
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    }
  }, 60_000);

  it("exits cleanly with no cards when the API does not serve /news", async () => {
    outDir = await mkdtemp(join(tmpdir(), "news-og-"));

    const { code, output } = await runScript(await serveApi(false), outDir);

    expect(code).toBe(0);
    expect(output).toContain("no cards rendered");
    expect(await readdir(outDir)).toEqual([]);
  }, 60_000);
});
