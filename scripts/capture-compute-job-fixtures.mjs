/**
 * Capture the compute JOB PAGE fixtures from the REAL nemar-cli backend routes (website ADR 0030 and
 * its phase E3 addendum; epic nemarOrg/website#493, issue #496).
 *
 *   NEMAR_CLI_DIR=<checkout of nemar-cli's Epic D branch> \
 *     bun scripts/capture-compute-job-fixtures.mjs
 *
 * Captured from nemar-cli commit 27eecff9 (Epic D, `feature/issue-2021-epic-compute-users`; phases D1
 * to D4 and the copy keys are in it). The checkout needs `bun install` at its root and in `backend/`.
 *
 * Nothing is stood in for. The script runs outside `bun test` (step 0 of the phase plan: it can) on the
 * backend's own lifecycle fixture (`backend/test/helpers/compute-lifecycle-fixture.ts`): real migrated
 * SQLite, Miniflare's R2 for the results and records buckets, the real local S3 interface the signer
 * addresses, and Epic A's Tapis stand-in (a real HTTP server built from Tapis's published
 * specifications; no response of it was recorded from a real tenant). The REAL compute router
 * (`makeRoutesApp`) is called with real hashed API keys, and the bodies are written unchanged.
 * Two kinds of job are read:
 *  - rows written by `insertJob` with fixed times (the states, the failure codes, a recorded cancel):
 *    these rerun to the same bytes;
 *  - jobs taken through the real lifecycle (`makeJob`, `submitComputeJob`, `advanceComputeJob`,
 *    `playLauncher`, which plays the launcher's last step and is documented in the fixture): these
 *    carry fresh ids, times and presigned signatures on every run, so a rerun rewrites those files.
 *    Tests therefore read the identifiers out of the fixture, never a literal.
 *
 * Writes under test/fixtures/compute/:
 *   job-states.json         GET /compute/me/jobs/:id, one job in each of the ten states
 *   job-failure-codes.json  the same, one failed job per failure code (17)
 *   job-cancel-requested.json  a running job with a cancel recorded
 *   job-stale.json          a live job whose cluster read failed: `stale: true`
 *   job-lifecycle.json      a job read at running and again at finished, through the real lifecycle
 *   logs.json               GET /compute/jobs/:id/logs: live, ended (records copy), empty, hostile,
 *                           over 1 MiB (headers and length only), not available yet
 *   results.json            GET and POST renew of a finished job, a second page by cursor (a job with
 *                           more outputs than one page; the first page is summarized, not stored),
 *                           the expired and the not-finished refusals
 *   cancel.json             POST /compute/jobs/:id/cancel: each outcome the route gives
 *   errors-job.json         job_not_found for a foreign, an absent and a malformed id, on every
 *                           job route; the credential refusals
 *
 * Every presigned address points at the local object-store stand-in and carries a test signature; the
 * emails are @example.org; no body contains an identity.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NEMAR_CLI_DIR = process.env.NEMAR_CLI_DIR;
if (!NEMAR_CLI_DIR) {
  console.error("Set NEMAR_CLI_DIR to a checkout of nemar-cli's Epic D branch.");
  process.exit(1);
}
const root = resolve(NEMAR_CLI_DIR);
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "..", "test", "fixtures", "compute");

const lifecycle = await import(join(root, "backend/test/helpers/compute-lifecycle-fixture.ts"));
const { makeRoutesApp } = await import(join(root, "backend/test/helpers/compute-routes-app.ts"));
const { insertJob, personWithKey } = await import(
  join(root, "backend/test/helpers/compute-user-seed.ts")
);
const { submitComputeJob, advanceComputeJob } = await import(
  join(root, "backend/src/services/compute-lifecycle.ts")
);
const { hashApiKey } = await import(join(root, "backend/src/services/token.ts"));
const { logKey } = await import(join(root, "backend/src/services/compute-records.ts"));
const { COMPUTE_STATES, COMPUTE_FAILURE_CODES } = await import(
  join(root, "shared/compute-state.ts")
);
const { COMPUTE_LOG_MAX_BYTES, COMPUTE_RESULTS_PAGE_MAX } = await import(
  join(root, "shared/contract/compute-submit.ts")
);
const { startLifecycleFixture, makeJob, playLauncher, reread, setTapisTimes, MINUTE } = lifecycle;

const COMMIT = "27eecff9";
const COMMAND = "NEMAR_CLI_DIR=<nemar-cli checkout> bun scripts/capture-compute-job-fixtures.mjs";

const provenance = (route, request, note) => ({
  command: COMMAND,
  nemar_cli_commit: COMMIT,
  route,
  request,
  note,
});

const fx = await startLifecycleFixture();
await fx.reset();
const handle = makeRoutesApp();
const db = fx.harness.db;

let keySeq = 0;
async function keyFor(accountId) {
  const key = `capture-job-key-${++keySeq}-0123456789abcdef0123456789abcdef`;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    accountId,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return key;
}

/** The headers a page or a test reads; the rest are transport. */
const KEPT_HEADERS = [
  "content-type",
  "cache-control",
  "x-content-type-options",
  "x-nemar-truncated",
];

/** One request through the real router; `text` bodies are kept as text, JSON as parsed. */
async function call(method, path, key, over = {}) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await handle(
    new Request(`http://api.test/compute${path}`, { method, headers }),
    fx.env(over.env ?? {}),
  );
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const kept = {};
  for (const name of KEPT_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) kept[name] = v;
  }
  let body;
  if ((res.headers.get("content-type") ?? "").includes("json")) body = JSON.parse(text);
  return { status: res.status, headers: kept, bytes, text, body };
}

/** The shape every fixture stores for a JSON answer: the status and the body, unchanged. */
const asJson = ({ status, body }) => ({ status, body });
/** And for a log: the status, the kept headers and the text. */
const asText = ({ status, headers, text }) => ({
  status,
  headers,
  ...(status === 200 ? { text } : { body: JSON.parse(text) }),
});

// --- Insert-based jobs: fixed times, so the bytes rerun the same -----------------------------------

const owner = await personWithKey(db, { access: "active" });
const ownerKey = owner.key;
const T = {
  created: "2026-11-05 09:00:00",
  started: "2026-11-05 09:10:00",
  ended: "2026-11-05 09:50:00",
};
const readJob = async (id, key = ownerKey) => call("GET", `/me/jobs/${id}`, key);

const jobStates = {
  _provenance: provenance(
    "GET /compute/me/jobs/:id",
    "one job in each of the ten states, by id",
    "Real route over rows written with fixed times. A live job has no Tapis job, so nothing is refreshed and `stale` is absent. Times are the database's `YYYY-MM-DD HH:MM:SS` UTC. The route serves no name, no fault attribution and no hold.",
  ),
};
for (const state of COMPUTE_STATES) {
  const terminal = ["finished", "failed", "cancelled"].includes(state);
  const ran = ["running", "archiving", "finished", "failed"].includes(state);
  const id = insertJob(db, {
    account_id: owner.id,
    state,
    created_at: T.created,
    started_at: ran ? T.started : null,
    ended_at: terminal ? T.ended : null,
    charged_milli: state === "finished" ? 2_500 : state === "failed" ? 1_250 : 0,
    partition: "shared",
    memory_mb: state === "finished" ? 8192 : null,
  });
  jobStates[state] = asJson(await readJob(id));
}

const jobFailureCodes = {
  _provenance: provenance(
    "GET /compute/me/jobs/:id",
    "one failed job per failure code (COMPUTE_FAILURE_CODES, 17)",
    "Real route over rows written with fixed times. The user view carries `failure_code` only: `failure_detail` and `platform_failure` are not served.",
  ),
};
for (const code of COMPUTE_FAILURE_CODES) {
  const id = insertJob(db, {
    account_id: owner.id,
    state: "failed",
    failure_code: code,
    created_at: T.created,
    started_at: T.started,
    ended_at: T.ended,
    charged_milli: 500,
  });
  jobFailureCodes[code] = asJson(await readJob(id));
}

const cancelRequestedId = insertJob(db, {
  account_id: owner.id,
  state: "running",
  created_at: T.created,
  started_at: T.started,
  cancel_requested_at: "2026-11-05 09:20:00",
});
const jobCancelRequested = {
  _provenance: provenance(
    "GET /compute/me/jobs/:id",
    "a running job with a cancel recorded",
    "Real route over a row written with fixed times: `cancel_requested` is true while the state is still live.",
  ),
  running: asJson(await readJob(cancelRequestedId)),
};

// --- Lifecycle jobs: the real services, the Tapis stand-in, the launcher's last step played -----------

const HOSTILE_LOG = [
  "plain line",
  "\u001b[31mred\u001b[0m and \u001b[2K cleared",
  "link \u001b]8;;https://example.org\u0007text\u001b]8;;\u0007 end",
  "progress 10%\rprogress 50%\rprogress 100%",
  "nul \u0000 bell \u0007 next-line \u0085 end",
  "override ‮gnp.exe and isolate ⁦x⁩ and zero​width",
  '<script>alert("x")</script> <img src=x onerror=alert(1)> &amp; "quotes" back\\slash',
  "Traceback (most recent call last):",
  '  File "main.py", line 3, in <module>',
  "ZeroDivisionError: division by zero",
  "",
].join("\n");

const TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "main.py", line 3, in <module>',
  "    print(1 / 0)",
  "ZeroDivisionError: division by zero",
  "",
].join("\n");

async function owned(over = {}) {
  const made = await makeJob(fx, over);
  return { ...made, key: await keyFor(made.accountId) };
}

async function submitted(over = {}) {
  const j = await owned(over);
  const sub = await submitComputeJob(j.env, j.job.id);
  if (!sub.ok) throw new Error(`could not submit: ${sub.outcome}`);
  const uuid = (await reread(j.env, j.job.id)).tapis_uuid;
  return { ...j, uuid };
}

async function running(over = {}) {
  const j = await submitted(over);
  fx.tapis.advance(j.uuid, "QUEUED");
  fx.tapis.advance(j.uuid, "RUNNING");
  await advanceComputeJob(j.env, j.job.id);
  return j;
}

async function finished(outputs, log) {
  const j = await running();
  if (log !== undefined) fx.tapis.setOutput(j.uuid, "tapisjob.out", log);
  await playLauncher(fx, j.env, await reread(j.env, j.job.id), j.uuid, { outputs });
  fx.tapis.advance(j.uuid, "FINISHED");
  setTapisTimes(fx, j.uuid, 30 * MINUTE, 0);
  await advanceComputeJob(j.env, j.job.id);
  const job = await reread(j.env, j.job.id);
  if (job.state !== "finished") throw new Error(`the job is ${job.state}, not finished`);
  return j;
}

// A job seen at running, then at finished.
const lifecycleJob = await running();
const lifecycleRunning = asJson(await readJob(lifecycleJob.job.id, lifecycleJob.key));
const lifecycleLog = await call("GET", `/jobs/${lifecycleJob.job.id}/logs`, lifecycleJob.key);
fx.tapis.setOutput(lifecycleJob.uuid, "tapisjob.out", "step one\nstep two\n");
const logLive = asText(await call("GET", `/jobs/${lifecycleJob.job.id}/logs`, lifecycleJob.key));
await playLauncher(
  fx,
  lifecycleJob.env,
  await reread(lifecycleJob.env, lifecycleJob.job.id),
  lifecycleJob.uuid,
  {
    outputs: [
      { path: "report.txt", content: "the report\n" },
      { path: "figures/plot.json", content: '{"x":[1,2,3]}' },
      { path: "table.csv", content: "a,b\n1,2\n" },
    ],
  },
);
fx.tapis.advance(lifecycleJob.uuid, "FINISHED");
setTapisTimes(fx, lifecycleJob.uuid, 30 * MINUTE, 0);
await advanceComputeJob(lifecycleJob.env, lifecycleJob.job.id);
const lifecycleFinished = asJson(await readJob(lifecycleJob.job.id, lifecycleJob.key));
const jobLifecycle = {
  _provenance: provenance(
    "GET /compute/me/jobs/:id",
    "one job through makeJob, submitComputeJob, QUEUED, RUNNING, FINISHED",
    "Real route over a job taken through the real lifecycle against the Tapis stand-in; the launcher's last step (its files and `declared.json`) is played by the backend's own helper. Ids and times are of the run that wrote this file.",
  ),
  job_id: lifecycleJob.job.id,
  running: lifecycleRunning,
  finished: lifecycleFinished,
};

// A stale read: a live job whose stored read is older than a minute and a cluster that cannot answer.
const staleJob = await submitted();
db.query(
  "UPDATE compute_jobs SET tapis_synced_at = datetime('now', '-10 minutes') WHERE id = ?",
).run(staleJob.job.id);
fx.tapis.down();
const staleRead = asJson(await readJob(staleJob.job.id, staleJob.key));
fx.tapis.up();
const jobStale = {
  _provenance: provenance(
    "GET /compute/me/jobs/:id",
    "a submitted job whose last cluster read is ten minutes old, with the Tapis stand-in down",
    "Real route: the refresh failed, so the stored record is served with `stale: true`.",
  ),
  job_id: staleJob.job.id,
  submitted: staleRead,
};

// --- Logs ---------------------------------------------------------------------------------------------

const logsHostileJob = await running();
fx.tapis.setOutput(logsHostileJob.uuid, "tapisjob.out", HOSTILE_LOG);
const logHostile = asText(
  await call("GET", `/jobs/${logsHostileJob.job.id}/logs`, logsHostileJob.key),
);

const logsEmptyJob = await running();
fx.tapis.setOutput(logsEmptyJob.uuid, "tapisjob.out", "");
const logEmpty = asText(await call("GET", `/jobs/${logsEmptyJob.job.id}/logs`, logsEmptyJob.key));

const logsBigJob = await running();
fx.tapis.setOutput(logsBigJob.uuid, "tapisjob.out", "x".repeat(COMPUTE_LOG_MAX_BYTES + 4096));
const big = await call("GET", `/jobs/${logsBigJob.job.id}/logs`, logsBigJob.key);
const logTruncated = {
  status: big.status,
  headers: big.headers,
  byte_length: big.bytes.length,
  note: "Headers and length only: the body is the first 1 MiB of 'x', which the test rebuilds.",
};

const notStarted = await owned();
const logNotAvailable = asText(
  await call("GET", `/jobs/${notStarted.job.id}/logs`, notStarted.key),
);

// An ended job: the log is read from the records copy the lifecycle made when the job ended.
const endedWithLog = await finished([{ path: "report.txt", content: "the report\n" }], TRACEBACK);
const logEnded = asText(await call("GET", `/jobs/${endedWithLog.job.id}/logs`, endedWithLog.key));

const logs = {
  _provenance: provenance(
    "GET /compute/jobs/:id/logs",
    "a running job (from Tapis), an empty log, a hostile log, a log over 1 MiB, a job that has not started, an ended job",
    "Real route. The body is the job's own bytes as `text/plain`, `nosniff`, `no-store`; `X-Nemar-Truncated: true` only when cut at 1 MiB. The route serves the FIRST 1 MiB and has no `tail` (nemar-cli#2094). The hostile log's bytes are written to the Tapis stand-in's output and read back through the route.",
  ),
  live: logLive,
  live_before_output: asText(lifecycleLog),
  ended: logEnded,
  empty: logEmpty,
  hostile: logHostile,
  truncated: logTruncated,
  not_available: logNotAvailable,
};

// --- Results ------------------------------------------------------------------------------------------

const resultsGet = asJson(
  await call("GET", `/jobs/${lifecycleJob.job.id}/results`, lifecycleJob.key),
);
const resultsRenew = asJson(
  await call("POST", `/jobs/${lifecycleJob.job.id}/results/renew`, lifecycleJob.key),
);

// More outputs than one page: the first page is summarized, the second is stored whole.
const OUTPUTS = COMPUTE_RESULTS_PAGE_MAX + 2;
const manyOutputs = Array.from({ length: OUTPUTS }, (_, i) => ({
  path: `out/file-${String(i).padStart(5, "0")}.txt`,
  content: `n${i}\n`,
}));
const many = await finished(manyOutputs);
const firstPage = await call("GET", `/jobs/${many.job.id}/results`, many.key);
const cursor = firstPage.body.next_after;
const secondPage = await call(
  "GET",
  `/jobs/${many.job.id}/results?after=${encodeURIComponent(cursor)}`,
  many.key,
);
const resultsManyFirst = {
  status: firstPage.status,
  summary: {
    file_count: firstPage.body.files.length,
    total: firstPage.body.total,
    truncated: firstPage.body.truncated,
    next_after: firstPage.body.next_after,
    bearer_links: firstPage.body.bearer_links,
    notice: firstPage.body.notice,
    expires_at: firstPage.body.expires_at,
    first_path: firstPage.body.files[0].path,
    last_path: firstPage.body.files.at(-1).path,
    note: "The files array (1,000 presigned links) is elided; the second page below is stored whole.",
  },
};

const notFinished = await running();
const resultsBadState = asJson(
  await call("GET", `/jobs/${notFinished.job.id}/results`, notFinished.key),
);

const expiredJob = await finished([{ path: "report.txt", content: "the report\n" }]);
db.query("UPDATE compute_jobs SET ended_at = datetime('now', '-40 days') WHERE id = ?").run(
  expiredJob.job.id,
);
const resultsExpired = asJson(
  await call("GET", `/jobs/${expiredJob.job.id}/results`, expiredJob.key),
);
const resultsExpiredRenew = asJson(
  await call("POST", `/jobs/${expiredJob.job.id}/results/renew`, expiredJob.key),
);

const failedJob = await owned();
db.query(
  "UPDATE compute_jobs SET state = 'failed', failure_code = 'runtime_error', ended_at = datetime('now') WHERE id = ?",
).run(failedJob.job.id);
const resultsFailed = asJson(await call("GET", `/jobs/${failedJob.job.id}/results`, failedJob.key));

const results = {
  _provenance: provenance(
    "GET|POST /compute/jobs/:id/results[/renew]",
    "a finished job with three outputs; a job with more outputs than one page (cursor); a job that is not finished; a job whose retention passed; a failed job",
    "Real routes. Both verbs mint NEW 7-day presigned links (a renewal is the same handler). Presigned addresses point at the local object-store stand-in and carry test signatures that expire. `bearer_links` and `notice` come from the route. Files are in path order. The retention rule is the backend's: expired once `now > ended_at + results_days` (the job in `expired` had its `ended_at` moved 40 days back).",
  ),
  job_id: lifecycleJob.job.id,
  get: resultsGet,
  renew: resultsRenew,
  many_job_id: many.job.id,
  many_first_page: resultsManyFirst,
  many_second_page: asJson(secondPage),
  bad_state: resultsBadState,
  expired: resultsExpired,
  expired_renew: resultsExpiredRenew,
  failed: resultsFailed,
};

// --- Cancel -------------------------------------------------------------------------------------------

const toCancel = await running();
const cancelRunning = asJson(await call("POST", `/jobs/${toCancel.job.id}/cancel`, toCancel.key));
const cancelAgain = asJson(await call("POST", `/jobs/${toCancel.job.id}/cancel`, toCancel.key));
const afterCancel = asJson(await readJob(toCancel.job.id, toCancel.key));
// The cluster cannot be reached: the intent is recorded and the job is still live.
const cancelPending = await running();
fx.tapis.down();
const cancelClusterDown = asJson(
  await call("POST", `/jobs/${cancelPending.job.id}/cancel`, cancelPending.key),
);
const cancelClusterDownAgain = asJson(
  await call("POST", `/jobs/${cancelPending.job.id}/cancel`, cancelPending.key),
);
const readClusterDown = asJson(await readJob(cancelPending.job.id, cancelPending.key));
fx.tapis.up();
const neverStarted = await owned();
const cancelNeverStarted = asJson(
  await call("POST", `/jobs/${neverStarted.job.id}/cancel`, neverStarted.key),
);
const cancelEnded = asJson(
  await call("POST", `/jobs/${endedWithLog.job.id}/cancel`, endedWithLog.key),
);
const cancel = {
  _provenance: provenance(
    "POST /compute/jobs/:id/cancel",
    "a running job twice, a running job while the cluster cannot be reached, a job that never started, a finished job",
    "Real route, no body, no key. A cancel never refuses by state: an ended job answers 200 `already_ended` with `cancelled: false`. The Tapis stand-in carries out the cancel of a running job at once, so the state is already `cancelled`; with the stand-in down the intent is recorded and the job stays live (`cluster_down`).",
  ),
  running: cancelRunning,
  running_again: cancelAgain,
  running_read_after: afterCancel,
  cluster_down: cancelClusterDown,
  cluster_down_again: cancelClusterDownAgain,
  cluster_down_read_after: readClusterDown,
  never_started: cancelNeverStarted,
  finished: cancelEnded,
};

// --- Refusals -----------------------------------------------------------------------------------------

const stranger = await personWithKey(db, { access: "active" });
const strangerKey = stranger.key;
const pending = await personWithKey(db, { status: "pending", access: "none" });
const ABSENT = "job_000000000000000000000000";
const jobRoutes = [
  ["GET", (id) => `/me/jobs/${id}`],
  ["GET", (id) => `/jobs/${id}/logs`],
  ["GET", (id) => `/jobs/${id}/results`],
  ["POST", (id) => `/jobs/${id}/results/renew`],
  ["POST", (id) => `/jobs/${id}/cancel`],
];
const notFound = {};
for (const [method, path] of jobRoutes) {
  const label = `${method} ${path("<id>")}`;
  notFound[label] = {
    foreign: asJson(await call(method, path(lifecycleJob.job.id), strangerKey)),
    absent: asJson(await call(method, path(ABSENT), ownerKey)),
    malformed: asJson(await call(method, path("nope"), ownerKey)),
  };
}
const errorsJob = {
  _provenance: provenance(
    "the job routes",
    "a foreign job, an absent id and a malformed id on every job route; no credential; an account that is not approved",
    "Real refusals. A foreign, an absent and a malformed id answer the same bytes on every route (no route is an oracle). The 401 and 403 are authMiddleware's own shapes.",
  ),
  job_not_found: notFound,
  no_credential: asJson(await call("GET", `/me/jobs/${ABSENT}`, null)),
  account_not_approved: asJson(await call("GET", `/me/jobs/${ABSENT}`, pending.key)),
  invalid_after: asJson(
    await call("GET", `/jobs/${many.job.id}/results?after=${"x".repeat(2000)}`, many.key),
  ),
};

// --- Write --------------------------------------------------------------------------------------------

const files = {
  "job-states.json": jobStates,
  "job-failure-codes.json": jobFailureCodes,
  "job-cancel-requested.json": jobCancelRequested,
  "job-stale.json": jobStale,
  "job-lifecycle.json": jobLifecycle,
  "logs.json": logs,
  "results.json": results,
  "cancel.json": cancel,
  "errors-job.json": errorsJob,
};
await mkdir(OUT, { recursive: true });
for (const [name, body] of Object.entries(files)) {
  await writeFile(join(OUT, name), `${JSON.stringify(body, null, 2)}\n`);
}
console.log(`wrote ${Object.keys(files).length} files under ${OUT}`);
await fx.dispose();
process.exit(0);
