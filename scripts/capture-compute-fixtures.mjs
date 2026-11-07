/**
 * Capture the compute-access fixtures from the REAL nemar-cli backend routes
 * (website ADR 0030; epic nemarOrg/website#493 phase E1).
 *
 *   NEMAR_CLI_DIR=<checkout of nemar-cli's Epic D branch> \
 *     bun scripts/capture-compute-fixtures.mjs
 *
 * Captured from nemar-cli commit 3a869903 (Phase D1, #2071, squash on
 * `feature/issue-2021-epic-compute-users`). The checkout needs
 * `bun install` at its root and in `backend/`. Nothing is stood in for: the
 * script imports the real `userRoutes` behind the real `authMiddleware`
 * (backend/test/helpers/compute-app.ts), the real `authWebRoutes`, a real
 * migrated bun:sqlite database, real hashed API keys and real session
 * issuance, and dispatches Requests to them. The one external boundary,
 * Resend, is the backend's own local `Bun.serve()` stand-in
 * (helpers/resend.ts), so the admin notification runs unchanged.
 *
 * Writes two files under test/fixtures/compute/:
 *   request-responses.json   one real response per outcome of
 *                            POST /users/me/compute-access/request
 *   auth-me-states.json      the `user` of GET /auth/me in each of the six
 *                            compute-access states
 *
 * Only the wall-clock `requested_at` of the two success bodies is replaced
 * (with a fixed value) so the fixture does not change on every run; every
 * other byte is the backend's. Emails are @example.org. No real host, tenant,
 * allocation or person appears.
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

const { makeComputeApp } = await import(join(root, "backend/test/helpers/compute-app.ts"));
const { freshDb, realD1 } = await import(join(root, "backend/test/helpers/d1.ts"));
const { withFakeResend } = await import(join(root, "backend/test/helpers/resend.ts"));
const { hashApiKey } = await import(join(root, "backend/src/services/token.ts"));
const { issueSession } = await import(join(root, "backend/src/services/web-session.ts"));
const { authWebRoutes } = await import(join(root, "backend/src/routes/auth-web.ts"));
const { Hono } = await import(join(root, "backend/node_modules/hono/dist/index.js"));
const { COMPUTE_TERMS_VERSION } = await import(
  join(root, "shared/contract/compute-terms.ts")
);

const COMMIT = "3a869903";
const FIXED_REQUESTED_AT = "2026-11-05 12:00:00";
const USER_KEY = "capture-user-key-0123456789abcdef0123456789abcdef";
const USER_EMAIL = "requester@example.org";
const ADMIN_EMAIL = "admin@example.org";
const ORCID = "0000-0002-1825-0097";
const PURPOSE =
  "Run ICA decompositions on public EEG datasets for a methods comparison, 40 subjects.";
const ENCRYPTION_KEY = "capture-encryption-key-0123456789abcdef";

const handle = makeComputeApp();

function env(db, over = {}) {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    RESEND_API_KEY: "capture-resend-key",
    DEV_EMAIL_ALLOWLIST: "@example.org",
    DEV_ADMIN_NOTIFICATIONS: "1",
    FROM_EMAIL: "NEMAR <noreply@example.org>",
    WEB_SESSION_COOKIE_DOMAIN: "",
    ...over,
  };
}

/** A complete requester by default; each scenario blanks the one thing it is about. */
async function seedRequester(db, o = {}) {
  const row = {
    username: "requester",
    given_name: "Ada",
    family_name: "Rivers",
    city: "San Diego",
    country: "USA",
    affiliation: "Example Institute",
    email_verified: 1,
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
     VALUES (?, ?, 'x', 'verified', 'member', ?, ?, ?, ?, ?, ?, ?, 1, 'web', 0, 'person', ?, ?, ?, ?)`,
  ).run(
    row.username,
    USER_EMAIL,
    row.email_verified,
    row.given_name,
    row.family_name,
    row.city,
    row.country,
    row.affiliation,
    ORCID,
    row.compute_access,
    row.compute_access_requested_at,
    row.compute_access_granted_at,
    row.compute_access_requested_at,
  );
  const u = db.query("SELECT id FROM users WHERE email = ?").get(USER_EMAIL);
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(USER_KEY),
    USER_KEY.slice(0, 8),
  );
  if (row.identity) {
    db.query(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
    ).run(u.id, ORCID);
  }
  return u.id;
}

function seedAdmin(db) {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES ('captureadmin', ?, 'x', 'approved', 'admin', 1, 1)`,
  ).run(ADMIN_EMAIL);
}

async function post(db, body, over = {}) {
  const res = await handle(
    new Request("http://api.test/users/me/compute-access/request", {
      method: "POST",
      headers: { Authorization: `Bearer ${USER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env(db, over),
  );
  return { status: res.status, body: await res.json() };
}

const GOOD = { purpose: PURPOSE, accept_terms_version: COMPUTE_TERMS_VERSION };

function pinTimestamp(captured) {
  if (typeof captured.body.requested_at === "string") {
    captured.body.requested_at = FIXED_REQUESTED_AT;
  }
  return captured;
}

async function scenario(seed, body, over) {
  const db = freshDb();
  seedAdmin(db);
  await seedRequester(db, seed);
  return post(db, body, over);
}

const responses = {
  _provenance: {
    command: "NEMAR_CLI_DIR=<nemar-cli checkout> bun scripts/capture-compute-fixtures.mjs",
    nemar_cli_commit: COMMIT,
    route: "POST /users/me/compute-access/request",
    note: "Real route over a real migrated database. Only requested_at of the two success bodies is pinned to a fixed value. Emails are @example.org.",
  },
};

// The refusals, one real body each.
responses.purpose_required = await scenario({}, { ...GOOD, purpose: "too short" });
responses.terms_not_accepted = await scenario({}, { ...GOOD, accept_terms_version: "2026-01-old" });
responses.email_not_verified = await scenario({ email_verified: 0, identity: false }, GOOD);
responses.orcid_not_proven = await scenario({ identity: false }, GOOD);
responses.profile_incomplete = await scenario(
  { given_name: null, family_name: "  ", city: null, country: null, affiliation: null },
  GOOD,
);
responses.profile_incomplete_affiliation_only = await scenario({ affiliation: null }, GOOD);
responses.access_closed_denied = await scenario({ compute_access: "denied" }, GOOD);
responses.access_closed_revoked = await scenario({ compute_access: "revoked" }, GOOD);
responses.access_closed_suspended = await scenario({ compute_access: "suspended" }, GOOD);
responses.already_active = await scenario({ compute_access: "active" }, GOOD);
responses.terms_unpublished = await scenario({}, GOOD, { ENVIRONMENT: "production" });

// The two successes, with the admin mail delivered to the backend's own stand-in.
{
  const db = freshDb();
  seedAdmin(db);
  await seedRequester(db);
  responses.created = pinTimestamp(await withFakeResend(() => post(db, GOOD)));
  responses.already_requested = pinTimestamp(await post(db, GOOD));
}

// A refusal whose mail failed to send leaves `email_sent: false`; capture it too, so the
// client's reading of that field is tested against the real shape.
{
  const db = freshDb();
  await seedRequester(db); // no admin => nobody to notify
  responses.created_unnotified = pinTimestamp(await post(db, GOOD));
}

// GET /auth/me in each of the six states.
const authMe = {
  _provenance: {
    command: "NEMAR_CLI_DIR=<nemar-cli checkout> bun scripts/capture-compute-fixtures.mjs",
    nemar_cli_commit: COMMIT,
    route: "GET /auth/me (the `user` object)",
    note: "Real route, one account per state. The compute stamps are written with fixed values; the state column is the backend's own vocabulary. Emails are @example.org.",
  },
};
const STAMPS = {
  none: [null, null],
  requested: ["2026-10-20 09:30:00", null],
  active: ["2026-10-20 09:30:00", "2026-10-24 14:05:00"],
  suspended: ["2026-10-20 09:30:00", "2026-10-24 14:05:00"],
  denied: ["2026-10-20 09:30:00", null],
  revoked: ["2026-10-20 09:30:00", "2026-10-24 14:05:00"],
};
for (const [state, [requestedAt, grantedAt]] of Object.entries(STAMPS)) {
  const db = freshDb();
  const id = await seedRequester(db, {
    compute_access: state,
    compute_access_requested_at: requestedAt,
    compute_access_granted_at: grantedAt,
  });
  const e = env(db);
  const { cookieIdRaw } = await issueSession(e, id, false, null, null, "orcid");
  const app = new Hono();
  app.route("/auth", authWebRoutes);
  const res = await app.request(
    "/auth/me",
    { headers: { Cookie: `nemar_session=${cookieIdRaw}` } },
    e,
  );
  const json = await res.json();
  authMe[state] = { status: res.status, user: json.user };
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "request-responses.json"), `${JSON.stringify(responses, null, 2)}\n`);
await writeFile(join(OUT, "auth-me-states.json"), `${JSON.stringify(authMe, null, 2)}\n`);
console.log(`wrote ${join(OUT, "request-responses.json")} and auth-me-states.json`);
process.exit(0);
