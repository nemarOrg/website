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
 * Environment:
 *   NEMAR_CLI_DIR   required; the nemar-cli checkout (bun install at its root
 *                   and in backend/)
 *   PORT            default 8787
 *   WEB_ORIGIN      default http://localhost:4321 (the Origin sign-in sends)
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
  refuse(`ENVIRONMENT=${ENVIRONMENT} is not a local environment (this script is for local use only).`);
}
for (const name of ["BIND_HOST", "HOST", "BUN_HOST"]) {
  const value = process.env[name];
  if (value !== undefined && value !== "" && !LOOPBACK_HOSTS.has(value)) {
    refuse(`${name}=${value} would bind a non-loopback address; this script listens on 127.0.0.1 only.`);
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

const db = freshDb();
const env = {
  DB: realD1(db),
  ENVIRONMENT: "test",
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
    identity: true,
    ...o,
  };
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name, city, country, affiliation,
                        orcid, orcid_verified, signup_source, service_access, account_kind,
                        compute_access, compute_access_requested_at, compute_access_granted_at,
                        compute_access_notified_at)
     VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', 0, 'person', ?, ?, ?, ?)`,
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
    row.compute_access,
    row.compute_access_requested_at,
    row.compute_access_granted_at,
    row.compute_access_requested_at,
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
    // Asks, then is granted through the real admin routes below.
    { who: "granted", compute_access: "requested", compute_access_requested_at: STAMPS.requested },
  );
}
for (const p of PERSONAS) {
  const { who, ...rest } = p;
  insertUser({ username: `local${who}`, email: `${who}@nemar.test`, ...rest });
}

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
  const { fundAccount, fundPlatform } = await import(join(root, "backend/test/helpers/compute-seed.ts"));
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
      started_at: ["running", "archiving", "finished", "failed"].includes(state) ? ago(1, i - 1) : null,
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
  for (const [pool, amount] of [["cpu", 25_000], ["gpu", 10_000]]) {
    const res = await asOwner(`/admin/compute/pools/by-id/${grantedId}/grant`, {
      pool,
      amount_milli: amount,
    });
    if (!res.ok) throw new Error(`pool grant failed: ${res.status} ${await res.text()}`);
  }
}
if (SEED_COMPUTE) await seedComputeData();

const cookies = {};
for (const p of PERSONAS) cookies[p.who] = await signIn(`${p.who}@nemar.test`);

const outDir = join(import.meta.dir, "..", ".local-backend");
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "cookies.json"), `${JSON.stringify(cookies, null, 2)}\n`);

console.log(`nemar-cli backend on http://localhost:${PORT} (in-memory database; restart resets)`);
console.log("");
console.log("Start the website against it, in another terminal:");
console.log(`  PUBLIC_API_BASE_URL=http://localhost:${PORT} bun run dev`);
console.log("");
console.log("Session cookies (paste as `nemar_session` for localhost:4321; also in .local-backend/cookies.json):");
for (const [who, cookie] of Object.entries(cookies)) console.log(`  ${who.padEnd(14)} ${cookie}`);
console.log("");
console.log(`Owner API key (grant from a terminal): ${OWNER_KEY}`);
console.log(
  `  curl -s -X POST -H "Authorization: Bearer ${OWNER_KEY}" http://localhost:${PORT}/admin/compute/access/grant/localrequested`,
);
