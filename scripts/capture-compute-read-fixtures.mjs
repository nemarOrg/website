/**
 * Capture the compute READ fixtures from the REAL nemar-cli backend routes (website ADR 0030 and its
 * phase E2 addendum; epic nemarOrg/website#493, issue #495).
 *
 *   NEMAR_CLI_DIR=<checkout of nemar-cli's Epic D branch> \
 *     bun scripts/capture-compute-read-fixtures.mjs
 *
 * Captured from nemar-cli commit e0685a25 (Epic D phase D4, squash on
 * `feature/issue-2021-epic-compute-users`; phases D1 to D4 are in it). The checkout needs
 * `bun install` at its root and in `backend/`. Nothing is stood in for: the script imports the
 * backend's own test helpers (`backend/test/helpers/compute-user-seed.ts`: `readApp`, `personWithKey`,
 * `insertJob`, `chargeAt`, `correctionAt`; `compute-seed.ts`: `fundAccount`, `fundPlatform`;
 * `d1.ts`: `freshDb`), seeds a real migrated SQLite database through the real ledger services
 * (`placeHold`, `settleProvisional`, so the pool totals come from the ledger's own triggers), calls
 * the REAL compute router with a real hashed API key, and writes the bodies unchanged.
 *
 * Writes under test/fixtures/compute/:
 *   me-states.json              GET /compute/me, one per access state (and `none` with requests open)
 *   me-active-with-usage.json   granted, held and charged all non-zero; queue samples with figures
 *   me-frozen.json              an active account whose pool is frozen
 *   me-overrun.json            a negative available_milli
 *   me-thin-queue.json          a partition with 3 samples (null figures, with the count) next to one with figures
 *   usage-day-partition.json    GET /compute/me/usage?group=day,partition over a fixed window
 *   usage-empty.json            a fresh account: rows []
 *   usage-outlier.json          one large day among small ones
 *   jobs-page1.json, jobs-page2.json   limit=2, then the page `next_after` points at
 *   jobs-all-states.json        one job in each of the ten states
 *   jobs-empty.json             { jobs: [], next_after: null }
 *   errors.json                 the real refusals
 *
 * Every request time in the seed is fixed (explicit `created_at` and ledger times, explicit `from` and
 * `to` on the usage request), so a rerun writes the same bytes. Only the queue samples are placed
 * relative to now (the route measures the last 7 days); their figures are seconds and counts, which are
 * stable. Emails are @example.org; no body contains an identity.
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

const { freshDb, realD1 } = await import(join(root, "backend/test/helpers/d1.ts"));
const seeds = await import(join(root, "backend/test/helpers/compute-user-seed.ts"));
const { fundAccount, fundPlatform } = await import(
  join(root, "backend/test/helpers/compute-seed.ts")
);
const { placeHold, settleProvisional } = await import(
  join(root, "backend/src/services/compute-ledger.ts")
);
const { COMPUTE_STATES } = await import(join(root, "shared/compute-state.ts"));
const { insertJob, jobIdFor, personWithKey, readApp, chargeAt, correctionAt, sqliteAt } = seeds;

const COMMIT = "e0685a25";
const COMMAND = "NEMAR_CLI_DIR=<nemar-cli checkout> bun scripts/capture-compute-read-fixtures.mjs";
const WINDOW = { from: "2026-10-09", to: "2026-11-07" };

function provenance(route, request, note) {
  return { command: COMMAND, nemar_cli_commit: COMMIT, route, request, note };
}

/** A fresh database, the platform `people` budget funded, and a helper to find a pool id. */
async function world() {
  const db = freshDb();
  const d1 = realD1(db);
  await fundPlatform(d1, "people", 1_000_000_000);
  await fundPlatform(d1, "people", 1_000_000_000, "gpu");
  const budget = (word) =>
    db
      .query(
        "SELECT id FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = ?",
      )
      .get(word).id;
  return { db, d1, budget };
}

async function get(db, key, path, env) {
  const res = await readApp(db, env).call(path, { key });
  return { status: res.status, body: res.body };
}

/** Stamp the dates a state has, so the access object is the same on every run. */
function stamp(db, personId, state) {
  const requested = state === "none" ? null : "2026-10-20 09:30:00";
  const granted = ["active", "suspended", "revoked"].includes(state) ? "2026-10-24 14:05:00" : null;
  db.query(
    `UPDATE users SET compute_access_requested_at = ?, compute_access_granted_at = ?,
            compute_terms_version = ? WHERE id = ?`,
  ).run(requested, granted, state === "none" ? null : "2026-11-draft", personId);
}

/** Queue samples: `n` jobs that started an hour ago after waiting the given seconds. */
function queueSamples(db, partition, waits) {
  const now = Date.now();
  for (const wait of waits) {
    insertJob(db, {
      partition,
      pool: partition.startsWith("gpu") ? "gpu" : "cpu",
      account_id: 999_999,
      started_at: sqliteAt(now - 3_600_000),
      remote_submitted_at: sqliteAt(now - 3_600_000 - wait * 1000),
    });
  }
}

// --- me-states.json -------------------------------------------------------------------------------

const meStates = {
  _provenance: provenance(
    "GET /compute/me",
    "one account per access state, no query",
    "Real route over a real migrated database. Zero pools and empty queue samples are true: nothing was granted and no job started. The access stamps are written with fixed values. `none_requests_open` is the same account read with a non-production environment, where requests are open.",
  ),
};
for (const state of ["none", "requested", "active", "suspended", "denied", "revoked"]) {
  const { db } = await world();
  const person = await personWithKey(db, { access: state });
  stamp(db, person.id, state);
  meStates[state] = await get(db, person.key, "/me");
  if (state === "none") {
    meStates.none_requests_open = await get(db, person.key, "/me", { ENVIRONMENT: "development" });
  }
}

// --- the rich account: balances, usage by day and partition, jobs ---------------------------------

const rich = await world();
const richPerson = await personWithKey(rich.db, { access: "active" });
stamp(rich.db, richPerson.id, "active");
const cpuPool = await fundAccount(rich.d1, richPerson.id, 100_000, "cpu");
const gpuPool = await fundAccount(rich.d1, richPerson.id, 40_000, "gpu");

/** One finished job, charged `milli` at the time `at` on `partition`. */
function chargedJob(partition, milli, at, over = {}) {
  const pool = partition.startsWith("gpu") ? "gpu" : "cpu";
  const id = insertJob(rich.db, {
    account_id: richPerson.id,
    partition,
    pool,
    state: "finished",
    charged_milli: milli,
    created_at: over.created_at ?? at,
    started_at: at,
    ended_at: at,
    source: over.source ?? "cli",
    app_id: over.app_id ?? "nemar-launch",
  });
  chargeAt(rich.db, { accountId: richPerson.id, jobId: id, milli, at, pool });
  return id;
}

// Oct 9 .. Nov 7, charged on several days. Day boundaries: 23:59:59 and 00:00:00.
chargedJob("shared", 4_000, "2026-10-12 08:00:00");
chargedJob("compute", 12_500, "2026-10-12 23:59:59");
chargedJob("shared", 2_500, "2026-10-13 00:00:00", { source: "web" });
chargedJob("shared", 6_000, "2026-10-20 10:00:00");
chargedJob("debug", 500, "2026-10-20 11:00:00");
chargedJob("compute", 9_000, "2026-10-27 15:30:00");
chargedJob("shared", 3_250, "2026-11-03 09:00:00", { source: "partner" });
chargedJob("shared", 1_750, "2026-11-03 21:00:00");
chargedJob("gpu-shared", 5_000, "2026-10-14 12:00:00");
chargedJob("gpu", 8_000, "2026-10-28 12:00:00");
chargedJob("gpu-shared", 1_500, "2026-11-05 12:00:00");
// A refund on a day with no other charge in that partition: a NET negative row.
{
  const id = insertJob(rich.db, {
    account_id: richPerson.id,
    partition: "debug",
    state: "failed",
    created_at: "2026-10-22 09:00:00",
    started_at: "2026-10-22 09:00:00",
    ended_at: "2026-10-22 09:05:00",
  });
  chargeAt(rich.db, {
    accountId: richPerson.id,
    jobId: id,
    milli: -300,
    at: "2026-10-22 09:10:00",
  });
}
// An administrator's correction that names no job: partition is null in the usage rows.
correctionAt(rich.db, { accountId: richPerson.id, milli: 1_000, at: "2026-10-30 10:00:00" });
correctionAt(rich.db, {
  accountId: richPerson.id,
  milli: 750,
  at: "2026-10-30 10:30:00",
  pool: "gpu",
});

// One live job with a hold: the held figure is real.
{
  const job = jobIdFor();
  const hold = await placeHold(rich.d1, {
    poolId: cpuPool,
    budgetPoolId: rich.budget("cpu"),
    amountMilli: 20_000,
    jobId: job,
  });
  if (!hold.ok) throw new Error(`hold: ${JSON.stringify(hold)}`);
  insertJob(rich.db, {
    id: job,
    account_id: richPerson.id,
    partition: "shared",
    state: "running",
    held_milli: 20_000,
    created_at: "2026-11-06 20:00:00",
    started_at: "2026-11-06 20:05:00",
  });
}
void gpuPool;
void settleProvisional;

// Queue samples with figures on two partitions (waits in seconds; stable whatever the date).
queueSamples(rich.db, "shared", [10, 20, 30, 40, 50, 75, 3700]);
queueSamples(rich.db, "gpu-shared", [0, 0, 0, 0, 0]);

const meActive = {
  _provenance: provenance(
    "GET /compute/me",
    "no query",
    "An active account with a CPU grant of 100.000 SU and a GPU grant of 40.000 SU, charges across several days, one open hold of 20.000 SU, and queue samples with figures (a median of 0 seconds on gpu-shared is a real value).",
  ),
  ...(await get(rich.db, richPerson.key, "/me")),
};

const usageDayPartition = {
  _provenance: provenance(
    "GET /compute/me/usage",
    `group=day,partition&from=${WINDOW.from}&to=${WINDOW.to}`,
    "Several days on both pools, a 23:59:59 and a 00:00:00 entry on neighbouring days, a net-negative refund row, an administrator's correction (null partition) on both pools, and quiet days that have no row. The window is explicit so the file is reproducible; the page itself asks for the server's default window.",
  ),
  ...(await get(
    rich.db,
    richPerson.key,
    `/me/usage?group=day,partition&from=${WINDOW.from}&to=${WINDOW.to}`,
  )),
};

// Jobs: pages of two over the rich account (newest first).
const page1Path = "/me/jobs?limit=2";
const jobsPage1 = await get(rich.db, richPerson.key, page1Path);
const cursor = jobsPage1.body.next_after;
if (typeof cursor !== "string") throw new Error("page one has no next_after");
const jobsPage2 = await get(
  rich.db,
  richPerson.key,
  `/me/jobs?limit=2&after=${encodeURIComponent(cursor)}`,
);
jobsPage1._provenance = provenance(
  "GET /compute/me/jobs",
  "limit=2",
  "The first page of a rich account's jobs; next_after continues it.",
);
jobsPage2._provenance = provenance(
  "GET /compute/me/jobs",
  "limit=2&after=<the first page's next_after, URL-encoded>",
  "The page next_after of jobs-page1.json points at.",
);

// --- me-frozen, me-overrun, me-thin-queue ---------------------------------------------------------

const frozen = await world();
const frozenPerson = await personWithKey(frozen.db, { access: "active" });
stamp(frozen.db, frozenPerson.id, "active");
const frozenPool = await fundAccount(frozen.d1, frozenPerson.id, 50_000, "cpu");
frozen.db.query("UPDATE compute_pools SET frozen = 1 WHERE id = ?").run(frozenPool);
const meFrozen = {
  _provenance: provenance(
    "GET /compute/me",
    "no query",
    "An active account with a frozen CPU pool: frozen is true, the balance is still stated.",
  ),
  ...(await get(frozen.db, frozenPerson.key, "/me")),
};

const overrun = await world();
const overrunPerson = await personWithKey(overrun.db, { access: "active" });
stamp(overrun.db, overrunPerson.id, "active");
await fundAccount(overrun.d1, overrunPerson.id, 10_000, "cpu");
{
  const id = insertJob(overrun.db, {
    account_id: overrunPerson.id,
    partition: "shared",
    state: "finished",
    charged_milli: 12_500,
    created_at: "2026-11-01 10:00:00",
  });
  chargeAt(overrun.db, {
    accountId: overrunPerson.id,
    jobId: id,
    milli: 12_500,
    at: "2026-11-01 11:00:00",
  });
}
const meOverrun = {
  _provenance: provenance(
    "GET /compute/me",
    "no query",
    "A CPU grant of 10.000 SU charged 12.500 SU: available_milli is -2500, an integer, not clamped.",
  ),
  ...(await get(overrun.db, overrunPerson.key, "/me")),
};

const thin = await world();
const thinPerson = await personWithKey(thin.db, { access: "active" });
stamp(thin.db, thinPerson.id, "active");
await fundAccount(thin.d1, thinPerson.id, 8_000, "cpu");
queueSamples(thin.db, "shared", [10, 20, 30, 40, 50]);
queueSamples(thin.db, "compute", [5, 6, 7]);
const meThin = {
  _provenance: provenance(
    "GET /compute/me",
    "no query",
    "shared has five samples (figures), compute has three (null figures with the count), the rest have none.",
  ),
  ...(await get(thin.db, thinPerson.key, "/me")),
};

// --- usage-empty, usage-outlier -------------------------------------------------------------------

const fresh = await world();
const freshPerson = await personWithKey(fresh.db, { access: "active" });
stamp(fresh.db, freshPerson.id, "active");
await fundAccount(fresh.d1, freshPerson.id, 25_000, "cpu");
const usageEmpty = {
  _provenance: provenance(
    "GET /compute/me/usage",
    `group=day,partition&from=${WINDOW.from}&to=${WINDOW.to}`,
    "A freshly granted account with no charge: rows is [], which is true.",
  ),
  ...(await get(
    fresh.db,
    freshPerson.key,
    `/me/usage?group=day,partition&from=${WINDOW.from}&to=${WINDOW.to}`,
  )),
};
const jobsEmpty = {
  _provenance: provenance("GET /compute/me/jobs", "no query", "A fresh account has no jobs."),
  ...(await get(fresh.db, freshPerson.key, "/me/jobs")),
};

const outlier = await world();
const outlierPerson = await personWithKey(outlier.db, { access: "active" });
stamp(outlier.db, outlierPerson.id, "active");
await fundAccount(outlier.d1, outlierPerson.id, 500_000, "cpu");
for (const [day, milli] of [
  ["2026-10-10", 500],
  ["2026-10-11", 750],
  ["2026-10-15", 400],
  ["2026-10-20", 250_000],
  ["2026-10-21", 600],
  ["2026-11-01", 300],
]) {
  const id = insertJob(outlier.db, {
    account_id: outlierPerson.id,
    partition: "shared",
    state: "finished",
    charged_milli: milli,
    created_at: `${day} 06:00:00`,
  });
  chargeAt(outlier.db, {
    accountId: outlierPerson.id,
    jobId: id,
    milli,
    at: `${day} 07:00:00`,
  });
}
const usageOutlier = {
  _provenance: provenance(
    "GET /compute/me/usage",
    `group=day,partition&from=${WINDOW.from}&to=${WINDOW.to}`,
    "One large day (250.000 SU) among days under 1 SU on one partition.",
  ),
  ...(await get(
    outlier.db,
    outlierPerson.key,
    `/me/usage?group=day,partition&from=${WINDOW.from}&to=${WINDOW.to}`,
  )),
};

// --- jobs in all ten states, and a hostile app id -------------------------------------------------

const states = await world();
const statesPerson = await personWithKey(states.db, { access: "active" });
stamp(states.db, statesPerson.id, "active");
await fundAccount(states.d1, statesPerson.id, 100_000, "cpu");
COMPUTE_STATES.forEach((state, i) => {
  const terminal = ["finished", "failed", "cancelled"].includes(state);
  insertJob(states.db, {
    account_id: statesPerson.id,
    state,
    source: ["cli", "web", "partner", "pipeline"][i % 4],
    partition: i % 3 === 0 ? "gpu-shared" : "shared",
    pool: i % 3 === 0 ? "gpu" : "cpu",
    gpus: i % 3 === 0 ? 1 : 0,
    created_at: `2026-11-0${(i % 7) + 1} 1${i % 10}:00:00`,
    started_at: ["running", "archiving", "finished", "failed"].includes(state)
      ? `2026-11-0${(i % 7) + 1} 1${i % 10}:05:00`
      : null,
    ended_at: terminal ? `2026-11-0${(i % 7) + 1} 1${i % 10}:45:00` : null,
    charged_milli: state === "finished" ? 2_500 : state === "failed" ? 0 : 0,
  });
});
// A cancel requested on a live job, and an explicit zero-charge finished job are covered above:
// `cancelled` and `finished` ... add one live job with cancel_requested_at set.
insertJob(states.db, {
  account_id: statesPerson.id,
  state: "running",
  created_at: "2026-11-07 09:00:00",
  started_at: "2026-11-07 09:05:00",
  cancel_requested_at: "2026-11-07 09:30:00",
});
const jobsAllStates = {
  _provenance: provenance(
    "GET /compute/me/jobs",
    "limit=25",
    "One job in each of the ten states over the four front doors, plus a running job with a cancel requested.",
  ),
  ...(await get(states.db, statesPerson.key, "/me/jobs?limit=25")),
};

// There is no hostile-text fixture on purpose: compute_jobs CHECKs app_id and app_version to
// [A-Za-z0-9._+-] (migration 0115), so the route cannot serve markup there. The page still treats
// every backend string as inert text; the tests feed hand-built unit inputs for that, not a
// captured body.

// --- errors.json ----------------------------------------------------------------------------------

const errs = await world();
const errPerson = await personWithKey(errs.db, { access: "active" });
const pending = await personWithKey(errs.db, { status: "pending", access: "none" });
const errors = {
  _provenance: provenance(
    "GET /compute/me*",
    "the refusals below",
    "Real refusals. On the read routes the sentence is in `error` and the machine word in `code` (the reverse of what api-base.ts readError assumes). The 401 and the 403 are authMiddleware's own shapes, which is what a cookie session meets.",
  ),
  invalid_cursor: await get(errs.db, errPerson.key, "/me/jobs?after=garbage"),
  invalid_limit: await get(errs.db, errPerson.key, "/me/jobs?limit=0"),
  invalid_state: await get(errs.db, errPerson.key, "/me/jobs?state=bogus"),
  invalid_group: await get(errs.db, errPerson.key, "/me/usage?group=bogus"),
  invalid_range: await get(errs.db, errPerson.key, "/me/usage?from=2026-13-01&to=2026-11-07"),
  no_credential: await get(errs.db, null, "/me"),
  account_not_approved: await get(errs.db, pending.key, "/me"),
};

// --- write ----------------------------------------------------------------------------------------

const files = {
  "me-states.json": meStates,
  "me-active-with-usage.json": meActive,
  "me-frozen.json": meFrozen,
  "me-overrun.json": meOverrun,
  "me-thin-queue.json": meThin,
  "usage-day-partition.json": usageDayPartition,
  "usage-empty.json": usageEmpty,
  "usage-outlier.json": usageOutlier,
  "jobs-page1.json": jobsPage1,
  "jobs-page2.json": jobsPage2,
  "jobs-all-states.json": jobsAllStates,
  "jobs-empty.json": jobsEmpty,
  "errors.json": errors,
};

await mkdir(OUT, { recursive: true });
for (const [name, body] of Object.entries(files)) {
  await writeFile(join(OUT, name), `${JSON.stringify(body, null, 2)}\n`);
}
console.log(`wrote ${Object.keys(files).length} files under ${OUT}`);
process.exit(0);
