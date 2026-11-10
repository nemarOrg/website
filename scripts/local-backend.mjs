/**
 * Run the REAL nemar-cli backend locally, with seeded accounts, so
 * `bun run dev` can talk to it (website ADR 0030; .context/local-backend.md).
 *
 *   NEMAR_CLI_DIR=<checkout of the nemar-cli branch to run> bun scripts/local-backend.mjs
 *   PUBLIC_API_BASE_URL=http://localhost:8787 bun run dev      # in another terminal
 *
 * Nothing is stood in for. It imports the backend's own Worker entry point
 * (`backend/src/index.ts`), its real migrations over a bun:sqlite database
 * (`backend/test/helpers/d1.ts`) and its real session issuance, and serves the
 * Worker with `Bun.serve`. The only additions are the platform's: an
 * `ExecutionContext` and `X-Test-Bypass`, the backend's documented bypass of
 * the rate limiter (which needs the Cloudflare Cache API that bun lacks).
 *
 * Accounts are `@nemar.test` fixtures: the dev backend echoes their sign-in
 * code instead of mailing it, and the script signs each one in through the
 * real `POST /auth/code/request` and `POST /auth/code/verify` (Origin
 * `http://localhost:4321`) and prints the session cookie to paste into the
 * browser. The database lives in memory: restarting resets everything.
 *
 * It listens on 127.0.0.1 only. It injects `X-Test-Bypass` into every request
 * and prints a fixed owner key, so it must never be reachable from another
 * machine; it refuses to start under a production-like `ENVIRONMENT`, a bind
 * override (`BIND_HOST`, `HOST`, `BUN_HOST`) that is not loopback, or a
 * `WEB_ORIGIN` that is not loopback, and it checks the socket it got.
 * `test/local-backend-guard.test.ts` runs those refusals.
 *
 * Options:
 *   --seed-compute  also seeds the compute dashboard's data (website phase E2, #495), with the backend's
 *                   own helpers and ledger services, never a stand-in: `localrich` (active; grants,
 *                   charges across the last 30 days on both pools, one administrator's correction,
 *                   an open hold, 40 jobs in all ten states, queue samples with figures), `localfrozen`
 *                   (a frozen pool), `localoverrun` (a negative available), `localgranted` (granted
 *                   through the REAL admin routes: access, then a pool grant; no jobs, no charges).
 *                   There is no unverified persona: signing in by emailed code verifies the email, so
 *                   the real flow cannot leave one signed in (`bun run dev` without
 *                   PUBLIC_API_BASE_URL has the `@nemar.cpending` mock for that screen). The
 *                   loopback guards below are unchanged.
 *
 *   --seed-compute-jobs  with --seed-compute and LOCAL_BACKEND_JOBS=1, also makes the job page's
 *                   (website phase E3, #496) jobs for `localjobs` through the REAL services and the
 *                   Tapis stand-in: a finished job (three outputs, a log), a running one, a second
 *                   running one to cancel, a hostile log, a log over 1 MiB, a failed job, a finished
 *                   job with 1,002 outputs, one whose results expire soon and one whose results
 *                   expired, a job that is queued and then advances by itself (queued, running,
 *                   finished, every 20 s), and a running job of another account (the 404 check). The
 *                   ids are printed and written to `.local-backend/jobs.json`. No route is stood in
 *                   for; the launcher's last step is played by the backend's own helper.
 *
 * It also seeds what the admin Compute tab (website#497) reviews: an owner and a
 * non-owner admin who are signed in, a queue of people who asked for compute
 * access (varied countries, a purpose full of markup, a service account, the
 * admin's own request), a non-zero owner default allocation set through the real
 * `PUT /admin/compute/policy`, and the scheduler accounting rows no job claims,
 * posted through the real observer route with a really minted run token. With
 * `LOCAL_BACKEND_JOBS=1` it runs on the backend's lifecycle fixture (Miniflare's
 * R2 and the Tapis stand-in, no tenant) and also makes jobs through the real
 * services and sets the flag columns the way the backend's own reporting test
 * does, because no real path produces a flag without a live tenant.
 *
 * Environment:
 *   NEMAR_CLI_DIR        required; the nemar-cli checkout (bun install at its
 *                        root and in backend/)
 *   PORT                 default 8787
 *   WEB_ORIGIN           default http://localhost:4321 (the Origin sign-in sends)
 *   LOCAL_BACKEND_JOBS   set to 1 for the job rows (starts Miniflare)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Guards first, before anything is imported: this process hands out a bypass of
// the rate limiter and a known owner key, so it is loopback-only and local-only.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
function refuse(reason) {
  console.error(`Refusing to start: ${reason}`);
  process.exit(1);
}
const ENVIRONMENT = process.env.ENVIRONMENT;
if (ENVIRONMENT !== undefined && !["test", "dev", "development", "local"].includes(ENVIRONMENT)) {
  refuse(
    `ENVIRONMENT=${ENVIRONMENT} is not a local environment (this script is for local use only).`,
  );
}
for (const name of ["BIND_HOST", "HOST", "BUN_HOST"]) {
  const value = process.env[name];
  if (value !== undefined && value !== "" && !LOOPBACK_HOSTS.has(value)) {
    refuse(
      `${name}=${value} would bind a non-loopback address; this script listens on 127.0.0.1 only.`,
    );
  }
}
{
  let origin;
  try {
    origin = new URL(process.env.WEB_ORIGIN ?? "http://localhost:4321");
  } catch {
    refuse("WEB_ORIGIN is not a URL.");
  }
  if (!LOOPBACK_HOSTS.has(origin.hostname)) {
    refuse(`WEB_ORIGIN host ${origin.hostname} is not loopback.`);
  }
}

const NEMAR_CLI_DIR = process.env.NEMAR_CLI_DIR;
if (!NEMAR_CLI_DIR) {
  console.error("Set NEMAR_CLI_DIR to a checkout of the nemar-cli branch to run.");
  process.exit(1);
}
const root = resolve(NEMAR_CLI_DIR);
const PORT = Number(process.env.PORT ?? 8787);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:4321";

const { default: worker } = await import(join(root, "backend/src/index.ts"));
const { freshDb, realD1 } = await import(join(root, "backend/test/helpers/d1.ts"));
const { hashApiKey } = await import(join(root, "backend/src/services/token.ts"));
const { DEFAULT_COMPUTE_POLICY } = await import(join(root, "shared/contract/compute.ts"));
const { COMPUTE_TERMS_VERSION } = await import(join(root, "shared/contract/compute-terms.ts"));
const { default: dailyDoc } = await import(
  join(root, "test/fixtures/compute-observation/daily.v1.json"),
  { with: { type: "json" } }
);

// Job rows need the backend's lifecycle fixture (Miniflare's R2 and the Tapis stand-in).
const WITH_JOBS = process.env.LOCAL_BACKEND_JOBS === "1";
const SEED_COMPUTE_JOBS = process.argv.includes("--seed-compute-jobs");
const lifecycle = WITH_JOBS
  ? await import(join(root, "backend/test/helpers/compute-lifecycle-fixture.ts"))
  : null;
const fx = lifecycle ? await lifecycle.startLifecycleFixture() : null;
if (fx) await fx.reset();

const BYPASS = "local-backend-bypass-token";
const OWNER_KEY = "local-owner-key-0123456789abcdef0123456789abcdef";

/** A well-formed ORCID iD (with its ISO 7064 mod 11-2 check digit) for fixture number `n`. */
function orcidFor(n) {
  const base = `00000002182${String(1000 + n)}`;
  let total = 0;
  for (const ch of base) total = (total + Number(ch)) * 2;
  const remainder = total % 11;
  const check = (12 - remainder) % 11;
  const digits = `${base}${check === 10 ? "X" : check}`;
  return digits.match(/.{4}/g).join("-");
}
let fixtureCount = 0;
const STAMPS = { requested: "2026-10-20 09:30:00", granted: "2026-10-24 14:05:00" };

const db = fx ? fx.harness.db : freshDb();
const env = {
  ...(fx ? fx.env() : { DB: realD1(db) }),
  // Compute runs only in `production` or `development` (the backend's switch), so the job page's seed
  // needs `development`; both are non-production and fenced from real mail.
  ENVIRONMENT: SEED_COMPUTE_JOBS ? "development" : "test",
  // Decisions are bookkeeping and read no switch, but minting an observer run does.
  COMPUTE_ENABLED: "1",
  API_BASE_URL: `http://localhost:${PORT}`,
  APP_BASE_URL: WEB_ORIGIN,
  ENCRYPTION_KEY: "local-backend-encryption-key-0123456789abcdef",
  OIDC_SECRET: "local-backend-oidc-secret-0123456789abcdef0123456789",
  TEST_BYPASS_TOKEN: BYPASS,
  WEB_SESSION_COOKIE_DOMAIN: "",
  // Admin mail is production-only by default; the owner below is the only
  // admin, and nothing is sent anywhere (no Resend key is configured).
};

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

function insertUser(o) {
  fixtureCount += 1;
  const orcid = orcidFor(fixtureCount);
  const row = {
    given_name: "Ada",
    family_name: "Rivers",
    city: "San Diego",
    country: "USA",
    affiliation: "Example Institute",
    email_verified: 1,
    status: "verified",
    role: "member",
    compute_access: "none",
    compute_access_requested_at: null,
    compute_access_granted_at: null,
    compute_purpose: null,
    account_kind: "person",
    identity: true,
    ...o,
  };
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name, city, country, affiliation,
                        orcid, orcid_verified, signup_source, service_access, account_kind,
                        compute_access, compute_access_requested_at, compute_access_granted_at,
                        compute_access_notified_at, compute_purpose, compute_terms_version,
                        compute_terms_accepted_at)
     VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.username,
    row.email,
    row.status,
    row.role,
    row.email_verified,
    row.given_name,
    row.family_name,
    row.city,
    row.country,
    row.affiliation,
    row.identity ? orcid : null,
    row.identity ? 1 : 0,
    row.account_kind,
    row.compute_access,
    row.compute_access_requested_at,
    row.compute_access_granted_at,
    row.compute_access_requested_at,
    row.compute_purpose,
    row.compute_purpose ? COMPUTE_TERMS_VERSION : null,
    row.compute_purpose ? row.compute_access_requested_at : null,
  );
  const { id } = db.query("SELECT id FROM users WHERE email = ?").get(row.email);
  if (row.identity) {
    db.query(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
    ).run(id, orcid);
  }
  return id;
}

// An owner with an API key, to grant and revoke from the command line.
const ownerId = insertUser({
  username: "localowner",
  email: "owner@nemar.test",
  role: "owner",
  status: "approved",
});
db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
  ownerId,
  await hashApiKey(OWNER_KEY),
  OWNER_KEY.slice(0, 8),
);

const PERSONAS = [
  { who: "none", compute_access: "none" },
  { who: "requested", compute_access: "requested", compute_access_requested_at: STAMPS.requested },
  {
    who: "active",
    compute_access: "active",
    compute_access_requested_at: STAMPS.requested,
    compute_access_granted_at: STAMPS.granted,
  },
  {
    who: "suspended",
    compute_access: "suspended",
    compute_access_requested_at: STAMPS.requested,
    compute_access_granted_at: STAMPS.granted,
  },
  { who: "denied", compute_access: "denied", compute_access_requested_at: STAMPS.requested },
  {
    who: "revoked",
    compute_access: "revoked",
    compute_access_requested_at: STAMPS.requested,
    compute_access_granted_at: STAMPS.granted,
  },
  // Accounts that a request refuses, to see each refusal list.
  { who: "noaffiliation", compute_access: "none", affiliation: null },
  { who: "noprofile", compute_access: "none", given_name: null, city: null, affiliation: null },
  { who: "noorcid", compute_access: "none", identity: false },
];
const SEED_COMPUTE = process.argv.includes("--seed-compute");
if (SEED_COMPUTE_JOBS && !(SEED_COMPUTE && WITH_JOBS)) {
  refuse("--seed-compute-jobs needs --seed-compute and LOCAL_BACKEND_JOBS=1.");
}
if (SEED_COMPUTE) {
  const active = {
    compute_access: "active",
    compute_access_requested_at: STAMPS.requested,
    compute_access_granted_at: STAMPS.granted,
  };
  PERSONAS.push(
    { who: "rich", ...active },
    { who: "frozen", ...active },
    { who: "overrun", ...active },
    // The job page's account (--seed-compute-jobs): no other live jobs, so the concurrency limit has room.
    ...(SEED_COMPUTE_JOBS ? [{ who: "jobs", ...active }] : []),
    // Asks, then is granted through the real admin routes below.
    { who: "granted", compute_access: "requested", compute_access_requested_at: STAMPS.requested },
  );
}
for (const p of PERSONAS) {
  const { who, ...rest } = p;
  insertUser({ username: `local${who}`, email: `${who}@nemar.test`, ...rest });
}

// The admin Compute tab's world. A non-owner administrator, whose own request is open, to see
// the self-grant refusal; and a queue of people who asked, with varied stated countries.
const PURPOSE =
  "Run ICA decompositions on public EEG datasets for a methods comparison, 40 subjects.";
const HOSTILE =
  "Plan: <img src=x onerror=alert(1)> and <script>alert(2)</script> [link](https://example.org) \u202Egnp.exe \u200B zero-width\nSecond line with a tab:\tend. " +
  "Decompose recordings and compare the components across sites. ".repeat(6);
const QUEUE = [
  { who: "adminself", role: "admin", status: "approved", country: "USA", purpose: PURPOSE },
  { who: "queueusa", country: "USA", purpose: PURPOSE },
  { who: "queuefr", country: "France", given_name: "Zoe", family_name: "Martin", purpose: PURPOSE },
  { who: "queuehostile", country: "Freedonia <b>x</b>", purpose: HOSTILE },
  {
    who: "queuebare",
    affiliation: null,
    city: null,
    given_name: null,
    family_name: null,
    purpose: PURPOSE,
  },
  { who: "queueservice", account_kind: "service", purpose: PURPOSE },
  { who: "queuedeny", country: "Sylvania", purpose: PURPOSE },
  { who: "queuesuspend", country: "Canada", purpose: PURPOSE },
];
QUEUE.forEach((q, i) => {
  const { who, purpose, ...rest } = q;
  insertUser({
    username: `local${who}`,
    email: `${who}@nemar.test`,
    compute_access: "requested",
    compute_access_requested_at: `2026-11-0${(i % 6) + 1} 09:30:00`,
    compute_purpose: purpose,
    ...rest,
  });
});
// The admin who is not an owner, and an owner who has signed in (the key above is the owner's).
const ADMIN_PERSONAS = [
  { who: "owner", email: "owner@nemar.test" },
  { who: "adminself", email: "adminself@nemar.test" },
];

async function call(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Test-Bypass", BYPASS);
  const req = new Request(`http://localhost:${PORT}${path}`, { ...init, headers });
  return worker.fetch(req, env, ctx);
}

/** Sign in through the real endpoints and return the session cookie. */
async function signIn(email) {
  const asked = await call("/auth/code/request", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: WEB_ORIGIN },
    body: JSON.stringify({ email }),
  });
  const { dev_code } = await asked.json();
  if (!dev_code) throw new Error(`no dev_code echoed for ${email} (status ${asked.status})`);
  const verified = await call("/auth/code/verify", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: WEB_ORIGIN },
    body: JSON.stringify({ email, code: dev_code, remember: false }),
  });
  if (!verified.ok) {
    throw new Error(`sign-in failed for ${email}: ${verified.status} ${await verified.text()}`);
  }
  const setCookie = verified.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).find((c) => /nemar_session=/.test(c));
  if (!cookie) throw new Error(`no session cookie for ${email}`);
  return cookie;
}

const server = Bun.serve({
  // Loopback only: `port` alone binds every interface, and this server adds the
  // rate limiter's bypass header to whatever reaches it.
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req) {
    const headers = new Headers(req.headers);
    headers.set("X-Test-Bypass", BYPASS);
    return worker.fetch(new Request(req, { headers }), env, ctx);
  },
});
if (server.hostname !== "127.0.0.1") {
  server.stop(true);
  refuse(`the server bound ${server.hostname}, not 127.0.0.1.`);
}

/** The compute dashboard's data (--seed-compute): the backend's own seed helpers and ledger services. */
async function seedComputeData() {
  const seeds = await import(join(root, "backend/test/helpers/compute-user-seed.ts"));
  const { fundAccount, fundPlatform } = await import(
    join(root, "backend/test/helpers/compute-seed.ts")
  );
  const { placeHold } = await import(join(root, "backend/src/services/compute-ledger.ts"));
  const { COMPUTE_STATES } = await import(join(root, "shared/compute-state.ts"));
  const { insertJob, jobIdFor, chargeAt, correctionAt, sqliteAt } = seeds;
  const d1 = realD1(db);
  const idOf = (name) => db.query("SELECT id FROM users WHERE username = ?").get(`local${name}`).id;
  const now = Date.now();
  const DAY = 86_400_000;
  /** A time `days` days and `hours` hours ago, as SQLite text (UTC). */
  const ago = (days, hours = 0) => sqliteAt(now - days * DAY - hours * 3_600_000);
  const budget = (word) =>
    db
      .query(
        "SELECT id FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = ?",
      )
      .get(word).id;

  await fundPlatform(d1, "people", 1_000_000_000);
  await fundPlatform(d1, "people", 1_000_000_000, "gpu");

  // --- rich: charges on several days of the last 30, a correction, a hold, jobs in all ten states.
  const rich = idOf("rich");
  const cpu = await fundAccount(d1, rich, 100_000, "cpu");
  await fundAccount(d1, rich, 40_000, "gpu");
  const charged = (partition, milli, days, hours = 0, source = "cli") => {
    const pool = partition.startsWith("gpu") ? "gpu" : "cpu";
    const at = ago(days, hours);
    const id = insertJob(db, {
      account_id: rich,
      partition,
      pool,
      source,
      state: "finished",
      charged_milli: milli,
      created_at: ago(days, hours + 1),
      started_at: at,
      ended_at: at,
    });
    chargeAt(db, { accountId: rich, jobId: id, milli, at, pool });
  };
  charged("shared", 4_000, 24);
  charged("compute", 12_500, 24, 2);
  charged("shared", 2_500, 23, 0, "web");
  charged("shared", 6_000, 17);
  charged("debug", 500, 17, 1);
  charged("compute", 9_000, 10);
  charged("shared", 3_250, 3, 0, "partner");
  charged("shared", 1_750, 3, 3);
  charged("gpu-shared", 5_000, 21);
  charged("gpu", 8_000, 9);
  charged("gpu-shared", 1_500, 2, 0, "pipeline");
  correctionAt(db, { accountId: rich, milli: 1_000, at: ago(8) });
  {
    const held = jobIdFor();
    const hold = await placeHold(d1, {
      poolId: cpu,
      budgetPoolId: budget("cpu"),
      amountMilli: 20_000,
      jobId: held,
    });
    if (!hold.ok) throw new Error(`could not place the seed hold: ${JSON.stringify(hold)}`);
    insertJob(db, {
      id: held,
      account_id: rich,
      partition: "shared",
      state: "running",
      held_milli: 20_000,
      created_at: ago(0, 3),
      started_at: ago(0, 2),
    });
  }
  // One job in each of the ten states, over the four front doors (the running one asks to be canceled)...
  COMPUTE_STATES.forEach((state, i) => {
    const terminal = ["finished", "failed", "cancelled"].includes(state);
    insertJob(db, {
      account_id: rich,
      state,
      source: ["cli", "web", "partner", "pipeline"][i % 4],
      partition: i % 3 === 0 ? "gpu-shared" : "shared",
      pool: i % 3 === 0 ? "gpu" : "cpu",
      gpus: i % 3 === 0 ? 1 : 0,
      created_at: ago(1, i),
      started_at: ["running", "archiving", "finished", "failed"].includes(state)
        ? ago(1, i - 1)
        : null,
      ended_at: terminal ? ago(1, i - 2) : null,
      cancel_requested_at: state === "running" ? ago(0, 1) : null,
    });
  });
  // ...and enough finished ones that "Load more" has a second page.
  for (let i = 0; i < 30; i++) {
    insertJob(db, {
      account_id: rich,
      state: i % 5 === 0 ? "failed" : "finished",
      created_at: ago(12 + i / 4, i),
      started_at: ago(12 + i / 4, i),
      ended_at: ago(12 + i / 4, i),
    });
  }
  // Queue samples (the whole platform, not this person): figures, a real zero, and a thin sample.
  const sample = (partition, wait) =>
    insertJob(db, {
      partition,
      pool: partition.startsWith("gpu") ? "gpu" : "cpu",
      account_id: null,
      source: "pipeline",
      started_at: ago(1),
      remote_submitted_at: sqliteAt(now - DAY - wait * 1000),
    });
  for (const wait of [10, 20, 30, 40, 50, 75, 3700]) sample("shared", wait);
  for (const wait of [0, 0, 0, 0, 0]) sample("gpu-shared", wait);
  for (const wait of [5, 6, 7]) sample("compute", wait);

  // --- frozen: a pool the backend reports as frozen.
  const frozen = idOf("frozen");
  const frozenPool = await fundAccount(d1, frozen, 50_000, "cpu");
  db.query("UPDATE compute_pools SET frozen = 1 WHERE id = ?").run(frozenPool);

  // --- overrun: charged past the grant, so available is negative.
  const overrun = idOf("overrun");
  await fundAccount(d1, overrun, 10_000, "cpu");
  {
    const id = insertJob(db, {
      account_id: overrun,
      partition: "shared",
      state: "finished",
      charged_milli: 12_500,
      created_at: ago(2, 1),
    });
    chargeAt(db, { accountId: overrun, jobId: id, milli: 12_500, at: ago(2) });
  }

  // --- granted: through the REAL admin routes (access, then a pool grant). No jobs, no charges.
  const asOwner = (path, body) =>
    call(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OWNER_KEY}`,
        "content-type": "application/json",
        "Idempotency-Key": `seed-${body?.pool ?? "access"}-${path.length}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const accessRes = await asOwner("/admin/compute/access/grant/localgranted");
  if (!accessRes.ok) throw new Error(`grant failed: ${accessRes.status} ${await accessRes.text()}`);
  const grantedId = idOf("granted");
  for (const [pool, amount] of [
    ["cpu", 25_000],
    ["gpu", 10_000],
  ]) {
    const res = await asOwner(`/admin/compute/pools/by-id/${grantedId}/grant`, {
      pool,
      amount_milli: amount,
    });
    if (!res.ok) throw new Error(`pool grant failed: ${res.status} ${await res.text()}`);
  }
}
if (SEED_COMPUTE) await seedComputeData();

/** The job page's jobs (--seed-compute-jobs): the backend's services, the Tapis stand-in, no route stood in. */
const seededJobs = {};
async function seedComputeJobs() {
  const { createJob } = await import(join(root, "backend/src/services/compute-jobs.ts"));
  const { fundAccount } = await import(join(root, "backend/test/helpers/compute-seed.ts"));
  const { submitComputeJob, advanceComputeJob } = await import(
    join(root, "backend/src/services/compute-lifecycle.ts")
  );
  const { launchableSpec, playLauncher, reread, setTapisTimes, MINUTE } = lifecycle;
  const idOf = (name) => db.query("SELECT id FROM users WHERE username = ?").get(`local${name}`).id;
  const rich = idOf("jobs");
  const frozen = idOf("granted");
  await fundAccount(realD1(db), rich, 400_000, "cpu");
  const make = async (account, label) => {
    const made = await createJob(env, {
      source: "cli",
      accountId: account,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      spec: launchableSpec(),
    });
    if (!made.ok) throw new Error(`could not make ${label}: ${made.code}`);
    seededJobs[label] = made.job.id;
    return made.job.id;
  };
  const submit = async (id) => {
    const sub = await submitComputeJob(env, id);
    if (!sub.ok) throw new Error(`could not submit ${id}: ${sub.outcome}`);
    return (await reread(env, id)).tapis_uuid;
  };
  const toRunning = async (id) => {
    const uuid = await submit(id);
    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    await advanceComputeJob(env, id);
    return uuid;
  };
  const finish = async (id, uuid, plan) => {
    await playLauncher(fx, env, await reread(env, id), uuid, plan);
    fx.tapis.advance(uuid, "FINISHED");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    await advanceComputeJob(env, id);
    // The stand-in reports the run as 30 minutes long, ending now, and the backend copies the
    // scheduler's start into `started_at`; the job record itself was only just made. A job cannot
    // start before it exists, so the record is backdated to just before its start. (Without this the
    // job page showed Started earlier than Created: a seed artifact, not a display bug.)
    db.query(
      "UPDATE compute_jobs SET created_at = datetime(started_at, '-1 minute') WHERE id = ? AND started_at < created_at",
    ).run(id);
  };
  const outputs = [
    { path: "report.txt", content: "the report\n" },
    { path: "figures/plot.json", content: '{"x":[1,2,3]}' },
    { path: "table.csv", content: "a,b\n1,2\n" },
  ];

  const finished = await make(rich, "finished");
  const u1 = await toRunning(finished);
  fx.tapis.setOutput(u1, "tapisjob.out", "step one\nstep two\ndone\n");
  await finish(finished, u1, { outputs });

  const running = await make(rich, "running");
  fx.tapis.setOutput(await toRunning(running), "tapisjob.out", "starting\nworking...\n");

  const toCancel = await make(rich, "cancel");
  fx.tapis.setOutput(await toRunning(toCancel), "tapisjob.out", "this one will be canceled\n");

  // Hostile and huge logs are on ENDED jobs (read from the records copy), which also keeps the
  // number of live jobs under the concurrency limit.
  const hostile = await make(rich, "hostile_log");
  const uh = await toRunning(hostile);
  fx.tapis.setOutput(
    uh,
    "tapisjob.out",
    [
      "plain line",
      "\u001b[31mred\u001b[0m and \u001b[2K cleared",
      "link \u001b]8;;https://example.org\u0007text\u001b]8;;\u0007 end",
      "progress 10%\rprogress 50%\rprogress 100%",
      "nul \u0000 bell \u0007 next-line \u0085 end",
      "override \u202egnp.exe and isolate \u2066x\u2069 and zero\u200bwidth",
      '<script>window.__pwned = 1; alert("x")</script> <img src=x onerror="window.__pwned = 2"> &amp; "q" back\\slash',
      "x".repeat(5000),
    ].join("\n"),
  );
  await finish(hostile, uh, { outputs: [], failureCode: "runtime_error" });

  const big = await make(rich, "big_log");
  const lines = Array.from({ length: 40_000 }, (_, i) => `line ${i + 1} ${"y".repeat(20)}`).join(
    "\n",
  );
  const ub = await toRunning(big);
  fx.tapis.setOutput(ub, "tapisjob.out", lines);
  await finish(big, ub, { outputs: [], failureCode: "runtime_error" });

  const failed = await make(rich, "failed");
  const u2 = await toRunning(failed);
  fx.tapis.setOutput(
    u2,
    "tapisjob.out",
    'Traceback (most recent call last):\n  File "main.py", line 3\nZeroDivisionError: division by zero\n',
  );
  await finish(failed, u2, { outputs: [], failureCode: "runtime_error" });

  const many = await make(rich, "many_results");
  const u3 = await toRunning(many);
  await finish(many, u3, {
    outputs: Array.from({ length: 1002 }, (_, i) => ({
      // `.dat`, not `.txt`: `bun run dev` answers a URL that ends in `.txt` (the cursor of the second page
      // is the last path) as a static file lookup and 500s; a deployed build is not known to.
      path: `out/file-${String(i).padStart(5, "0")}.dat`,
      content: `n${i}\n`,
    })),
  });

  for (const [label, daysAgo] of [
    ["expiring", 28],
    ["expired", 31],
  ]) {
    const id = await make(rich, label);
    const uuid = await toRunning(id);
    await finish(id, uuid, { outputs });
    // The whole record moves back, not only its end: a job that ended 31 days ago did not start or
    // get created after that.
    db.query(
      `UPDATE compute_jobs
          SET ended_at = datetime('now', ?1),
              started_at = datetime('now', ?1, '-30 minutes'),
              created_at = datetime('now', ?1, '-31 minutes')
        WHERE id = ?2`,
    ).run(`-${daysAgo} days`, id);
  }

  const foreign = await make(frozen, "foreign");
  await toRunning(foreign);

  // A job that advances by itself every 20 s: submitted, queued, running, finished.
  const watch = await make(rich, "watch");
  const watchUuid = await submit(watch);
  let step = 0;
  const timer = setInterval(async () => {
    try {
      step += 1;
      if (step === 1) fx.tapis.advance(watchUuid, "QUEUED");
      if (step === 2) {
        fx.tapis.advance(watchUuid, "RUNNING");
        fx.tapis.setOutput(watchUuid, "tapisjob.out", "watch job running\n");
      }
      if (step === 3) {
        fx.tapis.setOutput(watchUuid, "tapisjob.out", "watch job running\nwatch job done\n");
        await playLauncher(fx, env, await reread(env, watch), watchUuid, { outputs });
        fx.tapis.advance(watchUuid, "FINISHED");
        setTimeout(() => {}, 0);
      }
      // The backend refreshes a live job from the stand-in at most once a minute per read: age the
      // stored read so the next page read picks the change up.
      db.query(
        "UPDATE compute_jobs SET tapis_synced_at = datetime('now', '-5 minutes') WHERE id = ?",
      ).run(watch);
      if (step >= 3) clearInterval(timer);
    } catch (err) {
      console.error(`watch job step failed: ${err instanceof Error ? err.message : err}`);
      clearInterval(timer);
    }
  }, 20_000);
  timer.unref?.();
}
if (SEED_COMPUTE_JOBS) await seedComputeJobs();

const cookies = {};
for (const p of [...PERSONAS, ...ADMIN_PERSONAS])
  cookies[p.who] = await signIn(`${p.who}@nemar.test`);

// The owner's default allocation, through the real owner-only route: a grant then opens something.
const ownerAuth = { Authorization: `Bearer ${OWNER_KEY}`, "content-type": "application/json" };
{
  const res = await call("/admin/compute/policy", {
    method: "PUT",
    headers: ownerAuth,
    body: JSON.stringify({
      policy: { ...DEFAULT_COMPUTE_POLICY, defaultGrantMilli: { cpu: 50_000, gpu: 5_000 } },
      note: "local backend",
    }),
  });
  if (!res.ok) throw new Error(`could not set the policy: ${res.status} ${await res.text()}`);
}

// Scheduler accounting rows that no job claims, through the real observer route: an
// administrator mints a one-hour run and the document is posted under its token.
{
  const minted = await call("/admin/compute/observer-runs", { method: "POST", headers: ownerAuth });
  if (!minted.ok)
    throw new Error(`could not mint an observer run: ${minted.status} ${await minted.text()}`);
  const { token } = await minted.json();
  const row = (slurm, over = {}) => ({
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
  const jobs = [row("77001"), row("77002", { state: "FAILED", elapsed_seconds: 90 })];
  const posted = await call("/compute/observer", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ...dailyDoc,
      partitions: {},
      accounting: {
        ...dailyDoc.accounting,
        rows_total: jobs.length,
        rows_included: jobs.length,
        jobs,
      },
    }),
  });
  if (!posted.ok)
    throw new Error(`the observer post failed: ${posted.status} ${await posted.text()}`);
}

// Jobs, only with the lifecycle fixture: made through the real services, then flagged by the
// same UPDATE the backend's own reporting test uses (no real path flags a job without a tenant).
if (fx) {
  const { makeJob } = lifecycle;
  const { endedJob } = await import(join(root, "backend/test/helpers/compute-ended.ts"));
  const flag = (column, id) => db.run(`UPDATE compute_jobs SET ${column} = 1 WHERE id = ?`, [id]);
  const unreserved = await makeJob(fx);
  const unattributed = await makeJob(fx);
  const mismatch = await endedJob(fx, 30);
  const overrun = await endedJob(fx, 45);
  db.run("UPDATE compute_jobs SET flag_unreserved = 1, cancel_reason = 'unreserved' WHERE id = ?", [
    unreserved.job.id,
  ]);
  flag("flag_unattributed", unattributed.job.id);
  flag("flag_mismatch", mismatch.job.id);
  flag("flag_overrun", overrun.job.id);
}

const outDir = join(import.meta.dir, "..", ".local-backend");
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "cookies.json"), `${JSON.stringify(cookies, null, 2)}\n`);
if (SEED_COMPUTE_JOBS) {
  await writeFile(join(outDir, "jobs.json"), `${JSON.stringify(seededJobs, null, 2)}\n`);
}

console.log(`nemar-cli backend on http://localhost:${PORT} (in-memory database; restart resets)`);
console.log("");
console.log("Start the website against it, in another terminal:");
console.log(`  PUBLIC_API_BASE_URL=http://localhost:${PORT} bun run dev`);
console.log("");
console.log(
  "Session cookies (paste as `nemar_session` for localhost:4321; also in .local-backend/cookies.json):",
);
for (const [who, cookie] of Object.entries(cookies)) console.log(`  ${who.padEnd(14)} ${cookie}`);
if (SEED_COMPUTE_JOBS) {
  console.log("");
  console.log(
    "Job page jobs (also in .local-backend/jobs.json), open /compute/jobs/<id> as `jobs`:",
  );
  for (const [label, id] of Object.entries(seededJobs)) console.log(`  ${label.padEnd(14)} ${id}`);
}
console.log("");
console.log(
  "Admin Compute tab: sign in as `owner` or `adminself` (a non-owner administrator whose own",
);
console.log("request is open) and open http://localhost:4321/admin/compute.");
console.log(`Owner API key (grant from a terminal): ${OWNER_KEY}`);
console.log(
  `  curl -s -X POST -H "Authorization: Bearer ${OWNER_KEY}" http://localhost:${PORT}/admin/compute/access/grant/localrequested`,
);
