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
