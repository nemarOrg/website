/**
 * Capture the admin run drill-down's fixtures (website phase W9, #588) from the REAL nemar-cli
 * routes, served by the local backend:
 *
 *   NEMAR_CLI_DIR=<epic #2324 checkout> LOCAL_BACKEND_JOBS=1 bun scripts/local-backend.mjs --seed-pipeline --seed-quality
 *   NEMAR_CLI_DIR=<the same checkout> bun scripts/capture-run-quality-fixtures.mjs     # in another terminal
 *
 * For each run the backend seeded (`.local-backend/quality.json`: current, canary, expired, in
 * progress, deferred) it asks, as the local owner, `GET /admin/compute/pipeline/runs/<id>/quality`
 * and `GET /admin/compute/pipeline/runs/<id>`, and writes their bodies to
 * test/fixtures/compute/admin-run-quality/<label>.json, with provenance.json naming the nemar-cli
 * commit. The owner key is the local backend's fixed, local-only one; no host, person or secret
 * appears in what is written.
 */

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const NEMAR_CLI_DIR = process.env.NEMAR_CLI_DIR;
if (!NEMAR_CLI_DIR) {
  console.error("Set NEMAR_CLI_DIR to the nemar-cli checkout the local backend runs.");
  process.exit(1);
}
const API = `http://localhost:${Number(process.env.PORT ?? 8787)}`;
const OWNER_KEY = "local-owner-key-0123456789abcdef0123456789abcdef";
const here = import.meta.dir;
const stamps = JSON.parse(await readFile(join(here, "..", ".local-backend/quality.json"), "utf8"));
const out = join(here, "..", "test/fixtures/compute/admin-run-quality");
await mkdir(out, { recursive: true });

async function get(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${OWNER_KEY}` } });
  return { status: res.status, body: await res.json() };
}

for (const [label, id] of Object.entries(stamps)) {
  const quality = await get(`/admin/compute/pipeline/runs/${id}/quality`);
  const run = await get(`/admin/compute/pipeline/runs/${id}`);
  await writeFile(join(out, `${label}.json`), `${JSON.stringify({ quality, run }, null, 2)}\n`);
  console.log(`${label}: quality ${quality.status} (${quality.body.quality}), run ${run.status}`);
}
const commit = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], {
  cwd: resolve(NEMAR_CLI_DIR),
  encoding: "utf8",
}).stdout.trim();
await writeFile(
  join(out, "provenance.json"),
  `${JSON.stringify({ nemar_cli_commit: commit, stamps: Object.keys(stamps) }, null, 2)}\n`,
);
