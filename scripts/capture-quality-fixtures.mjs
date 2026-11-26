/**
 * Capture the per-recording quality panel's fixtures from the REAL nemar-cli quality route
 * (nemar-cli ADR 0137 decisions 6 and 7, epic nemarOrg/nemar-cli#2324 phase B2; website phase W6,
 * #588).
 *
 *   NEMAR_CLI_DIR=<checkout of nemar-cli's epic #2324 branch> bun scripts/capture-quality-fixtures.mjs
 *
 * The checkout needs `bun install` at its root and in `backend/`. Nothing is stood in for: the
 * script mounts the backend's own `dataRoutes` (the data plane router, the route registered before
 * the version routes) over a real migrated database (`backend/test/helpers/d1.ts`) and Miniflare's
 * R2 as the derivatives bucket, and stores nemar-ica's real product
 * (`test/fixtures/quality/ica-views`, copied from nemar-process P7) under a derivative key with the
 * backend's own fixture helpers (`backend/test/helpers/quality-fixture.ts`), as
 * `backend/test/quality-route.test.ts` does. Then it asks the route for the recording's record,
 * for every file the record's views declare, and for each refusal the panel words.
 *
 * Writes under test/fixtures/quality-views/route/:
 *   record.json     the record answer: status, the headers the panel reads, and the body's text
 *   files.json      each declared file: its location and the answer's status and headers
 *   files/<sha256>  each declared file's bytes as served
 *   refusals.json   quality_not_found (no such recording, and a dataset that is not public),
 *                   recording_path_invalid, view_not_declared, views_expired
 *   provenance.json the nemar-cli commit, the dataset id, the recipe and the recording
 *
 * The dataset id is the fixture's own (the product's records name it). No host, person or secret
 * appears.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NEMAR_CLI_DIR = process.env.NEMAR_CLI_DIR;
if (!NEMAR_CLI_DIR) {
  console.error("Set NEMAR_CLI_DIR to a checkout of nemar-cli's epic #2324 branch.");
  process.exit(1);
}
const root = resolve(NEMAR_CLI_DIR);
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "..", "test", "fixtures", "quality-views", "route");
const load = (path) => import(join(root, path));

const COMMIT = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();

const { Hono } = await import(join(root, "backend/node_modules/hono/dist/index.js"));
const { Miniflare } = await import(join(root, "node_modules/miniflare/dist/src/index.js"));
const { dataRoutes } = await load("backend/src/routes/data.ts");
const { freshDb, realD1 } = await load("backend/test/helpers/d1.ts");
const { newJobId, productFiles, seedDerivative, seedIcaStamp } = await load(
  "backend/test/helpers/quality-fixture.ts",
);
const { qualityFilePath, qualityRecordPath } = await load("shared/contract/quality-route.ts");
const { viewFiles } = await load("backend/src/services/quality-views.ts");

export const DATASET = "on007823";
export const RECIPE = "nemar-ica";
export const RECORDING = "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_eeg.edf";
const RECORD_PATH = "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_desc-nemarica_signalJourney.json";

const host = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('ok') } }",
  compatibilityDate: "2024-12-01",
  r2Buckets: ["COMPUTE_DERIVATIVES"],
});
try {
  const bucket = await host.getR2Bucket("COMPUTE_DERIVATIVES");
  const db = freshDb();
  const env = {
    DB: realD1(db),
    ENVIRONMENT: "test",
    COMPUTE_DERIVATIVES: bucket,
    COMPUTE_DERIVATIVES_BUCKET_NAME: "nemar-compute-derivatives",
  };
  const app = new Hono();
  app.route("/", dataRoutes);
  // No edge cache: every answer is the route's own.
  globalThis.caches = undefined;

  const seedDataset = (id) =>
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, anonymous,
                             modalities, first_published_at)
       VALUES (?, ?, -1, 'active', 'public', 0, 0, 'eeg', '2026-01-01 00:00:00')`,
      [id, id],
    );
  seedDataset(DATASET);
  const product = productFiles();
  const derivative = async (over = {}) => {
    const d1 = realD1(db);
    const jobId = newJobId();
    const stampId = await seedIcaStamp(d1, {
      datasetId: DATASET,
      jobId,
      version: over.version ?? "v1.0.0",
    });
    const key = await seedDerivative(d1, {
      datasetId: DATASET,
      stampId,
      jobId,
      retention: "catalog",
      storedAt: over.storedAt ?? "2026-11-20 10:00:00",
      ...over.row,
    });
    for (const [path, bytes] of product) await bucket.put(`d/${key}/${path}`, bytes);
    return key;
  };
  // An older public derivative that has expired (`views_expired` for a file asked of it by key),
  // then the current one.
  const expired = await derivative({
    version: "v0.9.0",
    storedAt: "2026-10-01 10:00:00",
    row: { state: "expired" },
  });
  const key = await derivative();

  const HEADERS = ["Content-Type", "Cache-Control", "ETag", "X-Content-Type-Options", "Content-Disposition"];
  const answer = async (path) => {
    const res = await app.request(path, {}, env);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const headers = {};
    for (const name of HEADERS) {
      const value = res.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return { status: res.status, headers, bytes };
  };
  const text = (bytes) => new TextDecoder().decode(bytes);

  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, "files"), { recursive: true });

  const record = await answer(qualityRecordPath(DATASET, RECIPE, RECORDING));
  if (record.status !== 200) throw new Error(`record: ${record.status} ${text(record.bytes)}`);
  await writeFile(
    join(OUT, "record.json"),
    `${JSON.stringify({ path: qualityRecordPath(DATASET, RECIPE, RECORDING), status: record.status, headers: record.headers, body: text(record.bytes) }, null, 2)}\n`,
  );

  const recordDoc = JSON.parse(text(product.get(RECORD_PATH)));
  const files = {};
  for (const view of recordDoc.extensions.nemar.views) {
    for (const f of viewFiles(view)) {
      if (files[f.sha256]) continue;
      const got = await answer(qualityFilePath(DATASET, RECIPE, key, f.sha256, RECORDING));
      if (got.status !== 200) throw new Error(`file ${f.location}: ${got.status}`);
      if (createHash("sha256").update(got.bytes).digest("hex") !== f.sha256) {
        throw new Error(`file ${f.location}: served bytes are not its digest`);
      }
      await writeFile(join(OUT, "files", f.sha256), got.bytes);
      files[f.sha256] = { location: f.location, status: got.status, headers: got.headers };
    }
  }
  await writeFile(join(OUT, "files.json"), `${JSON.stringify(files, null, 2)}\n`);

  const anySha = Object.keys(files)[0];
  const refusals = {};
  const refusal = async (name, path) => {
    const got = await answer(path);
    refusals[name] = { path, status: got.status, headers: got.headers, body: text(got.bytes) };
  };
  await refusal(
    "no_record",
    qualityRecordPath(DATASET, RECIPE, "sub-CUCOV999/eeg/sub-CUCOV999_task-COVID_eeg.edf"),
  );
  await refusal("dataset_not_public", qualityRecordPath("nm000777", RECIPE, RECORDING));
  await refusal(
    "path_invalid",
    `/${DATASET}/quality/v1/${RECIPE}/record/sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_meg.fif`,
  );
  await refusal(
    "not_declared",
    qualityFilePath(DATASET, RECIPE, key, "0".repeat(64), RECORDING),
  );
  await refusal("expired", qualityFilePath(DATASET, RECIPE, expired, anySha, RECORDING));
  await writeFile(join(OUT, "refusals.json"), `${JSON.stringify(refusals, null, 2)}\n`);

  await writeFile(
    join(OUT, "provenance.json"),
    `${JSON.stringify({ nemar_cli_commit: COMMIT, dataset_id: DATASET, recipe: RECIPE, recording: RECORDING, derivative_key: key }, null, 2)}\n`,
  );
  console.log(
    `Captured the record, ${Object.keys(files).length} files and ${Object.keys(refusals).length} refusals at nemar-cli ${COMMIT} into ${OUT}.`,
  );
} finally {
  await host.dispose();
}
