/**
 * Capture the admin Pipelines tab fixtures from the REAL nemar-cli pipeline grid routes
 * (nemar-cli ADR 0134 decision 5; epic nemarOrg/nemar-cli#2324 phase 4b, website#586).
 *
 *   NEMAR_CLI_DIR=<checkout of nemar-cli's epic #2324 branch> \
 *     bun scripts/capture-compute-pipeline-fixtures.mjs
 *
 * The checkout needs `bun install` at its root and in `backend/`. Nothing is stood in for: the
 * script imports the backend's own `makeComputeApp` (the real admin router with its real
 * authentication, admin and cookie-origin middleware), its lifecycle fixture (a real migrated
 * database, Miniflare's R2 and the Tapis stand-in), the real dispatch, the real stamp sync and
 * reconciliation, and the real progress write. The worlds are the ones the backend's own
 * `backend/test/compute-pipeline-grid.test.ts` builds: job, stamp and report states and times are
 * set with the same SQL that suite uses where a case is about what the grid shows for a row in
 * that shape (a silent report, an unreported job, a runner job, an unreadable failure list).
 *
 * Writes under test/fixtures/compute/:
 *   admin-pipeline-grid.json      GET /admin/compute/pipeline/grid: every row status and cell mark,
 *                                 a runner facet, two pages, a status filter, an empty filter,
 *                                 the refusals (invalid_query, recipe_unknown, member, signed out)
 *   admin-pipeline-coverage.json  GET /admin/compute/pipeline/coverage, by default and for 7 days
 *   admin-pipeline-run.json       GET /admin/compute/pipeline/runs/<id>: reconciled, live, an
 *                                 unreadable list, recordings left out, stamp_not_found, a bad id
 *
 * Wall-clock stamps, job ids and trend days differ on every run; they are replaced with fixed values
 * (see pin()) so a re-capture changes only what the backend changed. Dataset ids are in a band no
 * live dataset uses. No real host, tenant, allocation or person appears.
 */

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NEMAR_CLI_DIR = process.env.NEMAR_CLI_DIR;
if (!NEMAR_CLI_DIR) {
  console.error("Set NEMAR_CLI_DIR to a checkout of nemar-cli's epic #2324 branch.");
  process.exit(1);
}
const root = resolve(NEMAR_CLI_DIR);
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "..", "test", "fixtures", "compute");
const load = (path) => import(join(root, path));

const COMMIT = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();

const { COMPUTE_KEYS, makeComputeApp, seedComputeUsers } = await load(
  "backend/test/helpers/compute-app.ts",
);
const { startLifecycleFixture } = await load("backend/test/helpers/compute-lifecycle-fixture.ts");
const {
  finishAtTapis,
  floorOutputs,
  floorTable,
  fundPipelines,
  recipeRecord,
  seedEegDataset,
  seedPipelinesAccount,
} = await load("backend/test/helpers/compute-pipeline-fixture.ts");
const { dispatchPipelineJob, syncPipelineStamps } = await load(
  "backend/src/services/compute-pipeline.ts",
);
const { recordProgress, stampForJob } = await load(
  "backend/src/services/compute-pipeline-progress.ts",
);
const { findRecipe } = await load("shared/compute-recipes.ts");
const { PROGRESS_FORMAT } = await load("shared/contract/compute-progress.ts");

const handle = makeComputeApp();
const fx = await startLifecycleFixture();
let env;

/** Wall-clock keys, replaced by a fixed value so a re-capture is stable. */
const PINNED = {
  as_of: "2026-11-20 12:00:00",
  created_at: "2026-11-20 09:00:00",
  updated_at: "2026-11-20 10:00:00",
  reported_at: "2026-11-20 09:30:00",
};
/** The last day of a pinned trend; each earlier point is one day before the next. */
const TREND_LAST_DAY = Date.UTC(2026, 10, 20);
const jobIds = new Map();

function pinTrend(points) {
  return points.map((p, i) => {
    const at = new Date(TREND_LAST_DAY - (points.length - 1 - i) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return { ...pin(p), at };
  });
}

function pin(value) {
  if (typeof value === "string" && /^job_[0-9a-f]{24}$/.test(value)) {
    if (!jobIds.has(value))
      jobIds.set(value, `job_${(jobIds.size + 1).toString(16).padStart(24, "0")}`);
    return jobIds.get(value);
  }
  if (Array.isArray(value)) return value.map(pin);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (k === "trend" && Array.isArray(v)) return [k, pinTrend(v)];
        if (typeof v === "string" && Object.hasOwn(PINNED, k)) return [k, PINNED[k]];
        return [k, pin(v)];
      }),
    );
  }
  return value;
}

const provenance = (route, note = "") => ({
  command: "NEMAR_CLI_DIR=<nemar-cli checkout> bun scripts/capture-compute-pipeline-fixtures.mjs",
  nemar_cli_commit: COMMIT,
  route,
  note: `Real routes over a real migrated database (backend/test/compute-pipeline-grid.test.ts's worlds). Wall-clock stamps are pinned to fixed values, job ids to a stable sequence and trend days to a fixed week.${note ? ` ${note}` : ""}`,
});

/** One admin read, as the page receives it: status and parsed body. */
async function get(path, who = "admin") {
  const headers = {};
  if (who) headers.Authorization = `Bearer ${COMPUTE_KEYS[who]}`;
  const res = await handle(new Request(`http://api.test/admin${path}`, { headers }), env);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return pin({ status: res.status, body });
}

const sql = (text, ...binds) =>
  env.DB.prepare(text)
    .bind(...binds)
    .run();

async function world() {
  await fx.reset();
  env = fx.env();
  await seedComputeUsers(fx.harness.db);
  await seedPipelinesAccount(env);
  await fundPipelines(env);
}

const floor = findRecipe("nemar-floor");
const ENGINE_VERSION = floor.engine.split("@")[1];
const RECORD = JSON.stringify({
  sj_version: "0.1.0",
  ...JSON.parse(
    recipeRecord({
      recipe: { id: "nemar-floor", version: floor.version },
      engine: { package: "eegprep", version: ENGINE_VERSION },
    }),
  ),
});
const TABLE = floorTable([
  ["sub-01/eeg/sub-01_task-rest_eeg.edf", "succeeded", null, null],
  ["sub-02/eeg/sub-02_task-rest_eeg.edf", "failed", "load_failed", "load"],
  ["sub-03/eeg/sub-03_task-rest_eeg.edf", "failed", "step_failed", "bad_channels"],
  ["sub-04/eeg/sub-04_task-rest_eeg.edf", "succeeded", null, null],
]);
const ALL_PASS = floorTable([
  ["sub-01/eeg/sub-01_task-rest_eeg.edf", "succeeded", null, null],
  ["sub-02/eeg/sub-02_task-rest_eeg.edf", "succeeded", null, null],
]);
const MANY = floorTable([
  ...Array.from({ length: 12 }, (_, i) => {
    const sub = `sub-${String(i + 1).padStart(2, "0")}`;
    return [`${sub}/eeg/${sub}_task-rest_eeg.edf`, "failed", "load_failed", "load"];
  }),
  ["sub-20/eeg/sub-20_task-rest_eeg.edf", "failed", "step_failed", "bad_channels"],
  ["sub-21/eeg/sub-21_task-rest_eeg.edf", "succeeded", null, null],
]);

async function dispatch(datasetId) {
  const r = await dispatchPipelineJob(env, {
    recipe: "nemar-floor",
    datasetId,
    actor: { kind: "admin", userId: 1 },
  });
  if (!r.ok) throw new Error(`could not dispatch ${datasetId}: ${r.code}`);
  return { jobId: r.jobId, stampId: r.stampId, datasetId };
}

async function finished(datasetId, table = TABLE) {
  const d = await dispatch(datasetId);
  await finishAtTapis(fx, env, d.jobId, { outputs: floorOutputs(RECORD, table) });
  await syncPipelineStamps(env);
  return d;
}

const liveProgress = (total, imported = 1) => ({
  format: PROGRESS_FORMAT,
  checkpoint: "import",
  counts: {
    import: { passed: imported, failed: 0, skipped: 0, total },
    preprocess: { passed: 0, failed: 0, skipped: 0, total },
    quality: { passed: 0, failed: 0, skipped: 0, total },
  },
  failures: [],
});

async function reporting(datasetId) {
  const d = await dispatch(datasetId);
  await sql("UPDATE compute_jobs SET state = 'running' WHERE id = ?1", d.jobId);
  const lookup = await stampForJob(env.DB, d.jobId);
  if (!lookup.ok) throw new Error(lookup.reason);
  const outcome = await recordProgress(env.DB, {
    jobId: d.jobId,
    stamp: lookup.stamp,
    progress: liveProgress(4),
    reporter: { executor: "tapis" },
  });
  if (outcome !== "accepted") throw new Error(`progress not accepted: ${outcome}`);
  return d;
}

const RUNNER_ID = `rnr_${"ab".repeat(12)}`;

/** File name to content, written together at the end. */
const files = {};

// --- 1. The grid: every row status and every cell mark ---------------------------------------------

await world();
const grid = { _provenance: provenance("GET /admin/compute/pipeline/grid") };
{
  const ids = [
    "nm099101", // not started
    "nm099102", // waiting: dispatched, never reported
    "nm099103", // running: one accepted report
    "nm099104", // stalled: its last report is ten minutes old
    "nm099105", // finished: failed, skipped and pending cells
    "nm099106", // finished: every recording passed
    "nm099107", // failed: the job ended with no table, so no counts
    "nm099108", // running on a runner: the runner facet
  ];
  for (const id of ids) await seedEegDataset(env, id);
  await dispatch("nm099102");
  await reporting("nm099103");
  const stalled = await reporting("nm099104");
  await sql(
    "UPDATE compute_pipeline_progress_runs SET reported_at = datetime('now', '-600 seconds') WHERE stamp_id = ?1",
    stalled.stampId,
  );
  await finished("nm099105");
  await finished("nm099106", ALL_PASS);
  const failed = await dispatch("nm099107");
  await sql(
    "UPDATE compute_jobs SET state = 'failed', failure_code = 'runtime_error', ended_at = datetime('now') WHERE id = ?1",
    failed.jobId,
  );
  await syncPipelineStamps(env);
  const onRunner = await reporting("nm099108");
  await sql(
    `INSERT INTO compute_runners (id, name, pool, cores, memory_mb, gpus, scratch_gb, backend, runtimes, arch,
       accounting, site, trust, secret_hash, registered_by)
     VALUES (?1, 'ws_b', 'cpu', 8, 16000, 0, 100, 'local', '["docker"]', 'amd64', 'none', 'sccn', 'lab', ?2, 1)`,
    RUNNER_ID,
    "c".repeat(64),
  );
  await sql(
    "UPDATE compute_jobs SET executor = 'runner', accounting = 'none', runner_id = ?2 WHERE id = ?1",
    onRunner.jobId,
    RUNNER_ID,
  );

  grid.all = await get("/compute/pipeline/grid?recipe=nemar-floor");
  grid.page_one = await get("/compute/pipeline/grid?recipe=nemar-floor&limit=2");
  grid.page_two = await get(
    `/compute/pipeline/grid?recipe=nemar-floor&limit=2&after=${grid.page_one.body.next_after}`,
  );
  grid.status_failed = await get("/compute/pipeline/grid?recipe=nemar-floor&status=failed");
  grid.runner = await get(`/compute/pipeline/grid?recipe=nemar-floor&runner=${RUNNER_ID}`);
  grid.empty_filter = await get("/compute/pipeline/grid?recipe=nemar-floor&recipe_version=9.9.9");
  grid.invalid_query = await get("/compute/pipeline/grid?recipe=nemar-floor&status=sleeping");
  grid.runner_with_tapis = await get(
    `/compute/pipeline/grid?recipe=nemar-floor&executor=tapis&runner=${RUNNER_ID}`,
  );
  grid.recipe_unknown = await get("/compute/pipeline/grid?recipe=no-such-recipe");
  grid.member = await get("/compute/pipeline/grid?recipe=nemar-floor", "member");
  grid.signed_out = await get("/compute/pipeline/grid?recipe=nemar-floor", null);
}
files["admin-pipeline-grid.json"] = grid;

// --- 2. Coverage ---------------------------------------------------------------------------------

await world();
const coverage = { _provenance: provenance("GET /admin/compute/pipeline/coverage") };
{
  for (const id of ["nm099101", "nm099102", "nm099103"]) await seedEegDataset(env, id);
  await finished("nm099101", ALL_PASS);
  const b = await finished("nm099102");
  // One run failed two days ago, so the trend has a failed day as well as an ended one.
  await sql(
    "UPDATE compute_pipeline_stamps SET state = 'failed', refusal_code = 'runtime_error', updated_at = datetime('now', '-2 days') WHERE id = ?1",
    b.stampId,
  );
  coverage.default = await get("/compute/pipeline/coverage");
  coverage.days_7 = await get("/compute/pipeline/coverage?days=7");
  coverage.invalid_days = await get("/compute/pipeline/coverage?days=91");
  coverage.member = await get("/compute/pipeline/coverage", "member");
}
files["admin-pipeline-coverage.json"] = coverage;

// --- 3. The drill-down ---------------------------------------------------------------------------

await world();
const run = { _provenance: provenance("GET /admin/compute/pipeline/runs/<id>") };
{
  for (const id of ["nm099101", "nm099102", "nm099103", "nm099104"]) {
    await seedEegDataset(env, id);
  }
  const reconciled = await finished("nm099101");
  const live = await reporting("nm099102");
  const unreadable = await reporting("nm099103");
  await sql(
    "UPDATE compute_pipeline_progress SET failures = '[x' WHERE stamp_id = ?1 AND checkpoint = 'import'",
    unreadable.stampId,
  );
  const many = await finished("nm099104", MANY);
  run.reconciled = await get(`/compute/pipeline/runs/${reconciled.stampId}`);
  run.live = await get(`/compute/pipeline/runs/${live.stampId}`);
  run.unreadable = await get(`/compute/pipeline/runs/${unreadable.stampId}`);
  run.unlisted = await get(`/compute/pipeline/runs/${many.stampId}`);
  run.stamp_not_found = await get("/compute/pipeline/runs/999999");
  run.bad_id = await get("/compute/pipeline/runs/abc");
  run.member = await get(`/compute/pipeline/runs/${reconciled.stampId}`, "member");
}
files["admin-pipeline-run.json"] = run;

// --- Write ---------------------------------------------------------------------------------------

await mkdir(OUT, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  await writeFile(join(OUT, name), `${JSON.stringify(content, null, 2)}\n`);
}
console.log(`wrote ${Object.keys(files).join(", ")} to ${OUT} from nemar-cli ${COMMIT}`);
await fx.dispose();
process.exit(0);
