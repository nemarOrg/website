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
 * Environment:
 *   NEMAR_CLI_DIR   required; the nemar-cli checkout (bun install at its root
 *                   and in backend/)
 *   PORT            default 8787
 *   WEB_ORIGIN      default http://localhost:4321 (the Origin sign-in sends)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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

Bun.serve({
  port: PORT,
  fetch(req) {
    const headers = new Headers(req.headers);
    headers.set("X-Test-Bypass", BYPASS);
    return worker.fetch(new Request(req, { headers }), env, ctx);
  },
});

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
