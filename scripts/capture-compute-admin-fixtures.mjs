/**
 * Capture the admin Compute tab fixtures from the REAL nemar-cli backend routes
 * (website ADR 0030; epic nemarOrg/website#493 phase E4, issue #497).
 *
 *   NEMAR_CLI_DIR=<checkout of nemar-cli's Epic D branch> \
 *     bun scripts/capture-compute-admin-fixtures.mjs
 *
 * The checkout needs `bun install` at its root and in `backend/`. Nothing is stood in for: the
 * script imports the backend's own `makeComputeApp` (the real admin router with its real
 * authentication, admin and cookie-origin middleware, and the real person routes), a real
 * migrated bun:sqlite database, real hashed API keys, the real owner policy route, the real
 * decision routes, and, for job rows, the backend's lifecycle fixture (Miniflare's R2 and the
 * Tapis stand-in, no response of which was recorded from a real tenant). Flag columns are set by
 * the same `UPDATE compute_jobs SET flag_... = 1` that the backend's own
 * `compute-reporting-routes.test.ts` uses on rows the real services made, because no real path
 * produces a flag without a live tenant. Account rows are seeded by SQL the way the backend's
 * `compute-access-decision-routes.test.ts` seeds them; every state change after that goes through
 * the decision routes. `stale_state` is forced with the same database wrapper that suite uses.
 *
 * Writes under test/fixtures/compute/:
 *   admin-access-list.json       GET /admin/compute/access, every state, a page, empty, refused
 *   admin-access-decisions.json  POST /admin/compute/access/<decision>/by-id/<id>, every outcome
 *   admin-pools.json             GET /admin/compute/pools, each holder kind
 *   admin-jobs-flagged.json      GET /admin/compute/jobs?flag=, one page per flag
 *   admin-jobs-unmatched.json    GET /admin/compute/jobs?unmatched=1
 *   admin-access-report.json     GET /admin/compute/access-report
 *   admin-status.json            GET /admin/compute/status
 *
 * Wall-clock stamps and job ids differ on every run; they are replaced with fixed values (see
 * PINNED and pin()) so a re-capture changes only what the backend changed. Every other
 * byte is the backend's. Emails are @example.org. No real host, tenant, allocation or person
 * appears.
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
const load = (path) => import(join(root, path));

const { COMPUTE_KEYS, makeComputeApp, seedComputeUsers } = await load(
  "backend/test/helpers/compute-app.ts",
);
const { startLifecycleFixture, makeJob } = await load(
  "backend/test/helpers/compute-lifecycle-fixture.ts",
);
const { endedJob } = await load("backend/test/helpers/compute-ended.ts");
const { makeRoutesApp } = await load("backend/test/helpers/compute-routes-app.ts");
const { realD1 } = await load("backend/test/helpers/d1.ts");
const { fundPartner } = await load("backend/test/helpers/compute-seed.ts");
const { mintObserverRun } = await load("backend/src/services/compute-observer.ts");
const { decisionFlipStatement } = await load("backend/src/services/compute-access.ts");
const { DEFAULT_COMPUTE_POLICY } = await load("shared/contract/compute.ts");
const { COMPUTE_TERMS_VERSION } = await load("shared/contract/compute-terms.ts");
const dailyDoc = (await import(join(root, "test/fixtures/compute-observation/daily.v1.json")))
  .default;

const COMMIT = "e0685a25";
const handle = makeComputeApp();
const routes = makeRoutesApp();
const fx = await startLifecycleFixture();

/** Wall-clock keys, replaced by a fixed value so a re-capture is stable. */
const PINNED = {
  compute_access_granted_at: "2026-11-06 10:00:00",
  created_at: "2026-11-06 09:00:00",
  updated_at: "2026-11-06 10:00:00",
  ingested_at: "2026-11-06 12:00:00",
  submitted_at: "2026-11-06 09:01:00",
  started_at: "2026-11-06 09:02:00",
  ended_at: "2026-11-06 09:32:00",
  tapis_synced_at: "2026-11-06 09:33:00",
};
/** Job ids are random per run; each distinct one becomes a stable `job_<n>` of the same shape. */
const jobIds = new Map();
function pin(value) {
  if (typeof value === "string" && /^job_[0-9a-f]{24}$/.test(value)) {
    if (!jobIds.has(value))
      jobIds.set(value, `job_${(jobIds.size + 1).toString(16).padStart(24, "0")}`);
    return jobIds.get(value);
  }
  if (Array.isArray(value)) return value.map(pin);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        typeof v === "string" && Object.hasOwn(PINNED, k) ? PINNED[k] : pin(v),
      ]),
    );
  }
  return value;
}

const provenance = (route, note = "") => ({
  command: "NEMAR_CLI_DIR=<nemar-cli checkout> bun scripts/capture-compute-admin-fixtures.mjs",
  nemar_cli_commit: COMMIT,
  route,
  note: `Real routes over a real migrated database. Wall-clock stamps are pinned to fixed values and job ids to a stable sequence. Emails are @example.org.${note ? ` ${note}` : ""}`,
});

/** File name to content, written together at the end. */
const files = {};

// --- A world ------------------------------------------------------------------------------------

let ids;
let db;
let seq = 0;

function env(over = {}) {
  return fx.env({
    ENVIRONMENT: "test",
    DEV_EMAIL_ALLOWLIST: "@example.org",
    DEV_ADMIN_NOTIFICATIONS: "1",
    WEB_SESSION_COOKIE_DOMAIN: "",
    ...over,
  });
}

async function world() {
  await fx.reset();
  db = fx.harness.db;
  ids = await seedComputeUsers(db);
  seq = 0;
}

/** An account row in `state`, seeded the way the backend's decision suite seeds one. */
function seedPerson(o = {}) {
  seq += 1;
  const state = o.state ?? "requested";
  const purpose =
    o.purpose === undefined
      ? "Run ICA decompositions on public EEG datasets for a methods comparison, 40 subjects."
      : o.purpose;
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified,
                        given_name, family_name, affiliation, city, country, orcid, account_kind,
                        compute_access, compute_access_requested_at, compute_purpose,
                        compute_terms_version, compute_terms_accepted_at, deleted_at)
     VALUES (?, ?, 'x', ?, 'member', 'web', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      o.username === undefined ? `person${seq}` : o.username,
      o.email ?? `person${seq}@example.org`,
      o.status ?? "verified",
      o.given_name === undefined ? "Ada" : o.given_name,
      o.family_name === undefined ? "Rivers" : o.family_name,
      o.affiliation === undefined ? "Example Institute" : o.affiliation,
      o.city === undefined ? "San Diego" : o.city,
      o.country === undefined ? "USA" : o.country,
      o.orcid === undefined ? `0000-0002-1825-${String(96 + seq).padStart(4, "0")}` : o.orcid,
      o.kind ?? "person",
      state,
      state === "none" ? null : (o.requested_at ?? `2026-11-0${Math.min(seq, 9)} 09:30:00`),
      state === "none" ? null : purpose,
      state === "none" ? null : COMPUTE_TERMS_VERSION,
      state === "none" ? null : `2026-11-0${Math.min(seq, 9)} 09:29:00`,
    ],
  );
  return db.query("SELECT id FROM users ORDER BY id DESC LIMIT 1").get().id;
}

async function call(method, path, who, body, over = {}) {
  const headers = {};
  if (who) headers.Authorization = `Bearer ${COMPUTE_KEYS[who]}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await handle(
    new Request(`http://api.test/admin/compute${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    over.env ?? env(),
  );
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return pin({ status: res.status, body: parsed });
}

const decide = (decision, who, id, body, over) =>
  call("POST", `/access/${decision}/by-id/${id}`, who, body ?? {}, over);

async function setDefaultGrant(cpu, gpu) {
  const res = await call("PUT", "/policy", "owner", {
    policy: { ...DEFAULT_COMPUTE_POLICY, defaultGrantMilli: { cpu, gpu } },
    note: "capture",
  });
  if (res.status !== 200) throw new Error(`the policy was not set: ${JSON.stringify(res)}`);
}

/** Like the backend's own wrapper: `then` runs after the first read the account route makes. */
function racing(base, when, then) {
  return {
    prepare(sql) {
      const inner = base.prepare(sql);
      if (!when(sql)) return inner;
      const api = {
        bind(...a) {
          inner.bind(...a);
          return api;
        },
        async first() {
          const r = await inner.first();
          then();
          return r;
        },
      };
      return api;
    },
    batch: (stmts) => base.batch(stmts),
  };
}
const isAccountRead = (sql) => sql.includes("FROM users") && sql.includes("compute_purpose");

// --- 1. The listing -----------------------------------------------------------------------------

await world();
await setDefaultGrant(50_000, 0);
const HOSTILE =
  "Plan: <img src=x onerror=alert(1)> and <script>alert(2)</script> [link](https://example.org) ‮gnp.exe ​ zero-width\nSecond line with a tab:\tend.";
const LONG =
  `Long purpose. ${"Decompose EEG recordings with ICA and compare the components across sites. ".repeat(14)}`.slice(
    0,
    1000,
  );
const p = {};
p.hostile = seedPerson({ username: "hostile", purpose: HOSTILE, country: "Freedonia <b>x</b>" });
p.long = seedPerson({
  username: null,
  affiliation: null,
  purpose: LONG,
  given_name: null,
  family_name: null,
});
p.service = seedPerson({ username: "agent", kind: "service", city: null });
p.granted = seedPerson({ username: "granted" });
p.suspended = seedPerson({ username: "suspended" });
p.denied = seedPerson({ username: "denied" });
p.revoked = seedPerson({ username: "revoked" });
for (const [who, decisions] of [
  [p.granted, ["grant"]],
  [p.suspended, ["grant", "suspend"]],
  [p.denied, ["deny"]],
  [p.revoked, ["grant", "revoke"]],
]) {
  for (const d of decisions) {
    const r = await decide(d, "admin", who, d === "deny" ? { reason: "outside scope" } : {});
    if (r.status !== 200) throw new Error(`${d} failed: ${JSON.stringify(r)}`);
  }
}
const list = { _provenance: provenance("GET /admin/compute/access") };
list.all = await call("GET", "/access?limit=50", "admin");
for (const state of ["requested", "active", "suspended", "denied", "revoked"]) {
  list[state] = await call("GET", `/access?state=${state}&limit=50`, "admin");
}
list.page_one = await call("GET", "/access?limit=2", "admin");
list.page_two = await call(
  "GET",
  `/access?limit=2&after=${list.page_one.body.next_after}`,
  "admin",
);
list.empty = await call("GET", "/access?after=999999", "admin");
list.invalid_state_none = await call("GET", "/access?state=none", "admin");
list.invalid_unknown_key = await call("GET", "/access?colour=red", "admin");
list.invalid_limit = await call("GET", "/access?limit=500", "admin");
list.one_by_cursor = await call("GET", `/access?after=${p.long - 1}&limit=1`, "admin");
list.unauthenticated = await call("GET", "/access", null);
list.member = await call("GET", "/access", "member");
files["admin-access-list.json"] = list;

// --- 2. The decisions ---------------------------------------------------------------------------

const decisions = {
  _provenance: provenance(
    "POST /admin/compute/access/{grant|deny|suspend|revoke}/by-id/:id",
    "A success body has no sentence; a refusal carries { error, code }.",
  ),
};

// With the owner's default allocation at zero (the platform default), and the mail delivered.
await world();
{
  const id = seedPerson();
  decisions.grant_default_zero = await decide("grant", "admin", id, {
    reason: "export review done",
  });
}
// With a non-zero default: the grant opens it, a re-grant after a suspension opens nothing more.
await world();
await setDefaultGrant(50_000, 5_000);
{
  const id = seedPerson();
  decisions.grant_allocated = await decide("grant", "admin", id);
  decisions.suspend = await decide("suspend", "admin", id, { reason: "pending a review" });
  decisions.lift_suspension_already_granted = await decide("grant", "admin", id);
  decisions.revoke = await decide("revoke", "admin", id);
  decisions.grant_again_after_revoke = await decide("grant", "owner", id);
  const d = seedPerson();
  decisions.deny = await decide("deny", "admin", d, { reason: "outside the stated scope" });
  decisions.grant_again_after_deny = await decide("grant", "admin", d);
  const s = seedPerson({ kind: "service" });
  decisions.grant_email_not_sent = await decide("grant", "admin", s);
  // The refusals.
  const none = seedPerson({ state: "none" });
  decisions.refused_not_requested_grant = await decide("grant", "admin", none);
  decisions.refused_not_requested_deny = await decide("deny", "admin", id);
  decisions.refused_already_active = await decide("grant", "admin", s);
  const req = seedPerson();
  decisions.refused_not_active = await decide("suspend", "admin", req);
  decisions.refused_account_not_found = await decide("grant", "admin", 999999);
  decisions.refused_invalid_id = await call("POST", "/access/grant/by-id/abc", "admin", {});
  decisions.refused_invalid_body_reason = await decide("deny", "admin", req, {
    reason: "x".repeat(501),
  });
  decisions.refused_invalid_body_key = await decide("deny", "admin", req, { note: "x" });
  const bad = seedPerson({ status: "revoked" });
  decisions.refused_not_in_good_standing = await decide("grant", "admin", bad);
  // An administrator granting their OWN compute access; the same call by an owner is allowed.
  db.run(
    "UPDATE users SET compute_access = 'requested', compute_access_requested_at = '2026-11-02 09:30:00', compute_purpose = 'An administrator asking for compute for their own research.', compute_terms_version = ?, compute_terms_accepted_at = '2026-11-02 09:29:00' WHERE id = ?",
    [COMPUTE_TERMS_VERSION, ids.admin],
  );
  decisions.refused_self_decision = await decide("grant", "admin", ids.admin);
  decisions.self_grant_by_other_admin = await decide("grant", "admin2", ids.admin);
  // stale_state, with the backend's own seam: the state moves between the read and the write.
  const race = seedPerson();
  const raced = env();
  raced.DB = racing(realD1(db), isAccountRead, () =>
    db.run("UPDATE users SET compute_access = 'none' WHERE id = ?", [race]),
  );
  decisions.refused_stale_state = await decide("grant", "admin", race, {}, { env: raced });
  // The middleware's own answers.
  decisions.refused_unauthenticated = await decide("grant", null, req);
  decisions.refused_member = await decide("grant", "member", req);
  decisions.refused_owner_only_policy = await call("GET", "/policy", "admin");
}
// An unreadable policy fails closed.
await world();
{
  db.run("INSERT INTO compute_policy (policy_json, set_by) VALUES ('{}', ?)", [ids.owner]);
  const id = seedPerson();
  decisions.refused_policy_unreadable = await decide("grant", "admin", id);
}
files["admin-access-decisions.json"] = decisions;

// --- 3. Pools ------------------------------------------------------------------------------------

await world();
await setDefaultGrant(50_000, 5_000);
const pools = { _provenance: provenance("GET /admin/compute/pools") };
{
  const a = seedPerson({ username: "pooled" });
  const b = seedPerson({ username: "frozen" });
  await decide("grant", "admin", a);
  await decide("grant", "admin", b);
  await decide("suspend", "admin", b);
  await fundPartner(realD1(db), "example-client", 20_000, "cpu");
  // Raise a charge past the grant: an overrun can take a balance below zero.
  const adjust = await handle(
    new Request(`http://api.test/admin/compute/pools/by-id/${a}/adjust`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${COMPUTE_KEYS.owner}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "capture-charge-adjust-1",
      },
      body: JSON.stringify({
        pool: "cpu",
        target: "charged",
        delta_milli: 60_000,
        reason: "correction",
      }),
    }),
    env(),
  );
  pools.adjust_charge_status = adjust.status;
  pools.platform = await call("GET", "/pools?holder_kind=platform", "admin");
  pools.partner = await call("GET", "/pools?holder_kind=partner", "admin");
  pools.account = await call("GET", "/pools?holder_kind=account", "admin");
  pools.account_page_one = await call("GET", "/pools?holder_kind=account&limit=1", "admin");
  pools.account_page_two = await call(
    "GET",
    `/pools?holder_kind=account&limit=1&after=${pools.account_page_one.body.next_after}`,
    "admin",
  );
  pools.invalid_holder_kind = await call("GET", "/pools?holder_kind=nobody", "admin");
  pools.member = await call("GET", "/pools", "member");
}
files["admin-pools.json"] = pools;

// --- 4. Jobs: flagged, unmatched, the access report ----------------------------------------------

await world();
const jobs = { _provenance: provenance("GET /admin/compute/jobs?flag=") };
const sql = (q, ...a) => db.run(q, a);
{
  const unreserved = await makeJob(fx);
  const unattributed = await makeJob(fx);
  const mismatch = await endedJob(fx, 30);
  const overrun = await endedJob(fx, 45);
  const partner = await makeJob(fx);
  sql(
    "UPDATE compute_jobs SET flag_unreserved = 1, cancel_reason = 'unreserved' WHERE id = ?",
    unreserved.job.id,
  );
  sql("UPDATE compute_jobs SET flag_unattributed = 1 WHERE id = ?", unattributed.job.id);
  sql("UPDATE compute_jobs SET flag_mismatch = 1 WHERE id = ?", mismatch.job.id);
  sql("UPDATE compute_jobs SET flag_overrun = 1 WHERE id = ?", overrun.job.id);
  sql(
    "UPDATE compute_jobs SET flag_mismatch = 1, source = 'partner', partner_state = 'mismatch', partner_flag = 'owner_mismatch' WHERE id = ?",
    partner.job.id,
  );
  for (const flag of ["unreserved", "unattributed", "mismatch", "overrun"]) {
    jobs[flag] = await call("GET", `/jobs?flag=${flag}&limit=50`, "admin");
  }
  jobs.mismatch_page_one = await call("GET", "/jobs?flag=mismatch&limit=1", "admin");
  jobs.mismatch_page_two = await call(
    "GET",
    `/jobs?flag=mismatch&limit=1&after=${jobs.mismatch_page_one.body.next_after}`,
    "admin",
  );
  jobs.all = await call("GET", "/jobs?limit=50", "admin");
  jobs.invalid_flag = await call("GET", "/jobs?flag=everything", "admin");
  jobs.member = await call("GET", "/jobs?flag=mismatch", "member");
}
files["admin-jobs-flagged.json"] = jobs;

// The observer's accounting rows that no job claims, through the real mint and the real post.
await world();
const unmatched = { _provenance: provenance("GET /admin/compute/jobs?unmatched=1") };
{
  const minted = await mintObserverRun(env(), fx.ownerId);
  if (!minted.ok) throw new Error("could not mint an observer run");
  const acct = (slurm, over = {}) => ({
    job_id: slurm,
    partition: "shared",
    state: "COMPLETED",
    elapsed_seconds: 1800,
    alloc_tres: { billing: "4", cpu: "4", mem: "8000M", node: "1" },
    submit: "2026-11-05T10:00:00",
    start: "2026-11-05T10:01:00",
    end: "2026-11-05T10:31:00",
    ...over,
  });
  const jobsDoc = [acct("77001"), acct("77002", { state: "FAILED", elapsed_seconds: 90 })];
  const doc = {
    ...dailyDoc,
    partitions: {},
    accounting: {
      ...dailyDoc.accounting,
      rows_total: jobsDoc.length,
      rows_included: jobsDoc.length,
      jobs: jobsDoc,
    },
  };
  const post = await routes(
    new Request("http://worker.test/compute/observer", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${minted.token}` },
      body: JSON.stringify(doc),
    }),
    env(),
  );
  unmatched.observer_post_status = post.status;
  unmatched.list = await call("GET", "/jobs?unmatched=1&limit=100", "admin");
  unmatched.limited = await call("GET", "/jobs?unmatched=1&limit=1", "admin");
  unmatched.member = await call("GET", "/jobs?unmatched=1", "member");
}
files["admin-jobs-unmatched.json"] = unmatched;

// The quarter's distinct people and jobs.
await world();
const report = { _provenance: provenance("GET /admin/compute/access-report") };
{
  const a = await makeJob(fx);
  const a2 = await makeJob(fx);
  const b = await makeJob(fx);
  const gateway = db
    .query("SELECT gateway_user FROM compute_jobs WHERE id = ?")
    .get(a.job.id).gateway_user;
  for (const j of [a, a2]) {
    sql(
      "UPDATE compute_jobs SET gateway_user = ?, account_id = ? WHERE id = ?",
      gateway,
      a.accountId,
      j.job.id,
    );
  }
  sql("UPDATE compute_jobs SET source = 'web' WHERE id = ?", a2.job.id);
  for (const [i, j] of [a, a2, b].entries()) {
    sql(
      "UPDATE compute_jobs SET slurm_job_id = ?, remote_submitted_at = '2026-11-15 12:00:00' WHERE id = ?",
      `${5000 + i}`,
      j.job.id,
    );
  }
  report.q4 = await call("GET", "/access-report?quarter=2026Q4", "admin");
  report.empty_quarter = await call("GET", "/access-report?quarter=2025Q1", "admin");
  report.invalid_quarter = await call("GET", "/access-report?quarter=Q4", "admin");
  report.member = await call("GET", "/access-report?quarter=2026Q4", "member");
}
files["admin-access-report.json"] = report;

// --- 5. Status ------------------------------------------------------------------------------------

const status = { _provenance: provenance("GET /admin/compute/status") };
await world();
{
  // Compute off, nothing configured: reconciliation is paused.
  const off = env({
    COMPUTE_ENABLED: "0",
    TAPIS_AUTH_STRATEGY: undefined,
    TAPIS_USERNAME: undefined,
    TAPIS_PASSWORD: undefined,
    TAPIS_TENANT_ID: undefined,
  });
  status.compute_off = await call("GET", "/status", "admin", undefined, { env: off });
  // A recorded cancel still not carried out a day later: a positive attention count.
  const stuck = await makeJob(fx);
  sql(
    "UPDATE compute_jobs SET cancel_requested_at = datetime('now', '-1 day'), cancel_reason = 'user' WHERE id = ?",
    stuck.job.id,
  );
  status.attention = await call("GET", "/status", "admin", undefined, { env: off });
  status.member = await call("GET", "/status", "member", undefined, { env: off });
}
files["admin-status.json"] = status;

// --- Write ---------------------------------------------------------------------------------------

await mkdir(OUT, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  await writeFile(join(OUT, name), `${JSON.stringify(content, null, 2)}\n`);
}
console.log(`wrote ${Object.keys(files).join(", ")} to ${OUT}`);
await fx.dispose();
process.exit(0);
