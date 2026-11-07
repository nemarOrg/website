# Running the website against a local nemar-cli backend

Worked on 2026-11-06 (website#494). It runs the real backend, not a stand-in:
`scripts/local-backend.mjs` imports nemar-cli's own Worker entry point, its real migrations over a
`bun:sqlite` database, and its real session issuance, and serves them with `Bun.serve`. The only
additions are the platform's: an `ExecutionContext`, and the backend's documented `X-Test-Bypass`
for its rate limiter (which needs the Cloudflare Cache API that bun lacks).

## Safety

The server listens on `127.0.0.1` only (`Bun.serve({ hostname })`; without it bun binds every
interface). It adds `X-Test-Bypass` to every request and prints a fixed owner key, so it is never to
be reachable from another machine. The script refuses to start under a production-like
`ENVIRONMENT` (anything but `test`, `dev`, `development`, `local`), a `BIND_HOST`, `HOST` or
`BUN_HOST` that is not loopback, or a `WEB_ORIGIN` that is not loopback, and exits if the socket it
got is not `127.0.0.1`. `test/local-backend-guard.test.ts` runs the refusals.

## Steps

1. A checkout of the nemar-cli branch to run (for the compute card, the Epic D branch
   `feature/issue-2021-epic-compute-users` or any branch after it). Make your own worktree; do not
   touch a shared checkout. Run `bun install` at its root and in `backend/`.
2. In this repo:

   ```bash
   NEMAR_CLI_DIR=/path/to/nemar-cli-checkout bun scripts/local-backend.mjs
   ```

   It seeds an owner and nine `@nemar.test` accounts (complete profiles and an ORCID identity row;
   one per compute state, plus `noaffiliation`, `noprofile` and `noorcid`, which a request refuses).
   For each it signs in through the real `POST /auth/code/request` and `POST /auth/code/verify`
   (the dev backend echoes the code for `@nemar.test`), prints the session cookie, and writes them
   to `.local-backend/cookies.json` (git-ignored). The database is in memory: a restart resets it.
3. In another terminal:

   ```bash
   PUBLIC_API_BASE_URL=http://localhost:8787 bun run dev
   ```

   The middleware verifies a real cookie against `${PUBLIC_API_BASE_URL}/auth/me`, and the browser's
   calls go through the `/api/v1` proxy to the same backend. Localhost is an allowed Origin there.
4. In the browser, on `http://localhost:4321`, set the cookie from the script's output and open
   `/settings`: `document.cookie = "nemar_session=<value>; path=/"`. (The development login mock
   never reaches the backend; pasting the cookie is what does.) A request made from the card is a
   real write; grant it from a terminal with the owner key the script prints:

   ```bash
   curl -s -X POST -H "Authorization: Bearer <owner key>" \
     http://localhost:8787/admin/compute/access/grant/localrequested
   ```

## Seeding the compute dashboard (`--seed-compute`)

```bash
NEMAR_CLI_DIR=/path/to/nemar-cli-checkout bun scripts/local-backend.mjs --seed-compute
```

Adds, with the backend's own test helpers and ledger services (never a stand-in): `localrich` (active; a CPU and a GPU grant, charges on several days of the last 30 on both pools, one administrator's correction naming no job, an open hold, 40 jobs over the ten states and four front doors with enough finished ones for a second page, and queue samples with figures, a real zero and a thin sample), `localfrozen` (a frozen pool), `localoverrun` (a negative available) and `localgranted` (granted through the REAL admin routes, access then a pool grant: no jobs, no charges). Their cookies print with the others. `PORT=<n>` moves the backend (and `PUBLIC_API_BASE_URL` with it). The loopback guards are unchanged.

There is no unverified persona: signing in by emailed code verifies the email. `bun run dev` without `PUBLIC_API_BASE_URL` has the `@nemar.cpending` mock for that screen. The database refuses a markup-bearing `app_id` (a CHECK on `compute_jobs`), so the "hostile text" case is covered by unit tests, not by a seeded row.

A second browser profile on the same host shares cookies; use `http://127.0.0.1:4321` beside `http://localhost:4321` to keep two sessions apart.

## What differs from production

- `ENVIRONMENT` is `test`: the backend takes compute requests whether or not the terms are
  published, and no mail is sent (no mail key is configured). The website shows the request form
  because `PUBLIC_API_BASE_URL` is not the production API (`computeRequestsOpen`).
- The CLI keys card in Settings still shows the `astro dev` mock list (it is gated on the dev flag).
- Under `bun run dev` with no `PUBLIC_API_BASE_URL`, the `@nemar.*` personas of `src/lib/auth-dev.ts`
  need no backend at all (`@nemar.cnone` and the other compute personas render each state).

## If it breaks

The script fails loudly at the first thing it cannot do (a missing `NEMAR_CLI_DIR`, a missing
`backend/node_modules`, a migration the checkout does not have). Do not substitute a mock backend:
fix the checkout, or escalate with the error.

## The admin Compute tab (website#497)

The script also seeds the admin Compute tab's world: sign in as `owner` (an owner) or `adminself`
(a non-owner administrator whose own compute request is open) and open `/admin/compute`. It seeds
a queue of people who asked (varied countries, one purpose full of markup, a service account, an
account with no name or affiliation), sets a non-zero owner default allocation through the real
`PUT /admin/compute/policy`, and posts two scheduler accounting rows no job claims through the real
observer route under a really minted run token.

`LOCAL_BACKEND_JOBS=1` runs on the backend's lifecycle fixture (Miniflare's R2 and the Tapis
stand-in, no tenant) and also makes jobs through the real services, flagged with the same
`UPDATE compute_jobs SET flag_... = 1` the backend's own reporting test uses. No real path
produces a flag without a live tenant.

Worked on 2026-11-07. Differences from production: the compute switch reads `off` here (it needs the
exact production environment), so Reconciliation shows its paused banner; no mail is sent, so a
decision answers `email_sent: false` and the row says the person could not be emailed. Browser
windows cannot be narrower than about 600 px in the Chrome tools; check 375 px in devtools.

## The job page (website#496)

`--seed-compute-jobs` (with `--seed-compute` and `LOCAL_BACKEND_JOBS=1`) makes the job page's jobs for
the account `localjobs` (sign in with the `jobs` cookie) through the real services and the Tapis
stand-in: a finished job (three outputs, a log), a running one, one to cancel, a failed job with a
hostile log, one with a log over 1 MiB, one with 1,002 outputs (a second page of links), one whose
results expire in two days, one whose results are past the 30 days (the real 410), a running job of
another account (the 404 check) and a job that advances by itself every 20 seconds (queued, running,
finished). Ids are printed and written to `.local-backend/jobs.json`. The seed runs the backend with
`ENVIRONMENT=development` (compute only runs in `production` or `development`); mail stays fenced.
The seed takes about 40 seconds, and the watch job starts advancing when it ends: open it at once.
Result links point at the local object store on `127.0.0.1`, which is why `safeResultHref` accepts
`http:` on loopback. Not reachable here: a `stale: true` job (needs the stand-in down at read time;
covered by the captured fixture) and a real 5xx.
