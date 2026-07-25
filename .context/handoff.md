# Handoff — nemar.org website

**Last session:** 2026-07-25.

## TL;DR — where we are right now

`main` is production (Cloudflare GitHub integration → `nemar-website` Pages project,
ww2.nemar.org + app.nemar.org; apex nemar.org still legacy F5). `staging` is a
fast-forward mirror of `main` deploying test.nemar.org against the nemar-cli `dev`
backends. See AGENTS.md "Branch ↔ environment map".

**Epic #158 (admin portal) is CLOSED — all five tabs live**: Overview,
Publications, Users, Imports, Notices. Phases 4 (#176 → PR #177) and 5 (#178 →
PR #179) shipped this session, plus four follow-up fixes.

**nemar-cli is at 0.9.6 on `main`** — the notice level vocabulary and the
same-day expiry fix were promoted to production, with migrations 0063 and 0064
applied to `nemar-db`.

**Notices are live and in real use.** A production notice is up
(`tip`, pointing at ww1.nemar.org, expiring 2026-10-01).

## What happened this session

1. **Phase 4 — imports/quarantine triage** (#176, PR #177). `/admin/imports` with
   status chips backed by fleet-wide `by_status` counts, retry / verify / rollback
   gated on the statuses each endpoint actually accepts.
2. **Phase 5 — notices** (#178, PR #179). `/admin/notices` CRUD plus site-wide
   banners in `Base.astro`, client-fetched from a `no-store` `/api/notices`.
3. **nemar-cli #1025/#1026** — notice `level` widened to
   `tip | announcement | maintenance | warning | critical` (migration 0063).
   `--level info` still works and normalises to `tip`.
4. **nemar-cli #1024/#1027** — same-day expiry fixed (migration 0064), plus
   #1029, a round-trip guard the review panel caught.
5. **Promotion #1028** — `dev` → `main`, reviewed before merge as requested.
6. **Website follow-ups:** #181/#182 (host-neutral `/api/notices`), #180/#184
   (five levels + `--color-maintenance` token), #183/#185 (redirects `no-store`),
   #186/#187 (hyperlinked + centred banners), #188/#189 (per-build edge cache).

## Gotchas learned this session (these cost real time)

- **"Deployed" ≠ "visible" on ww2.** Marketing HTML is edge-cached and the cached
  artifact includes hashed asset URLs, so a deploy could stay invisible for up to
  12 h. Fixed in #189 (namespace derived from the build commit), documented in
  AGENTS.md with the asset-hash check. **Never confirm a deploy by grepping the
  bundle for a generic declaration** — `text-align:center` false-positived and I
  reported #187 as live on ww2 when it wasn't.
- **`gh run list --limit 1` is not "my run".** Twice I read "No migrations to
  apply" from a deploy that fired seconds after the merge commit's own run, and
  twice concluded wrongly. Resolve the merge SHA and view that run.
- **Astro scopes styles by attribute.** Elements built with `createElement` never
  receive `data-astro-cid-*`, so `.parent a { }` compiles to `a[data-astro-cid-…]`
  and silently matches nothing. Use `.parent :global(a)`. Nodes cloned from a
  `<template>` in the same file *do* carry it — so "some rules apply, some don't"
  is the signature.
- **`astro.config.mjs` is `@ts-check`ed with no `@types/node`.** A bare
  `process.env` typechecks locally (something in the tree supplies the global) and
  fails `astro check` in CI. Read env through a `globalThis` cast.
- **Concurrent review subagents share one working tree.** One mutated a file to
  measure coverage while another read it mid-mutation and reported a critical bug
  that did not exist. Verify a finding against the file before acting on it.
- **A migration that narrows a CHECK has a deploy window.** Migrations apply before
  the Worker deploys, so briefly the new constraint is live against old code.
  Admin-only and retryable, but don't create a notice during a deploy.
- **SQLite `datetime()` returns NULL for input it can't parse**, and NULL in a
  nullable column can mean the opposite of what the caller intended (here: "never
  expires"). It also reinterprets a bare numeric string as a Julian Day Number
  rather than rejecting it. Guard round-trips, don't assume rejection.

## The recurring bug class to watch for

**An optional `AbortSignal` that is never defaulted.** Three separate places in this
codebase pass `signal: init.signal` where callers supply nothing. A `try/catch`
around `fetch` covers a request that *fails* — it does not cover one that *hangs*
(connection opens, never writes a response): that promise never settles, so there is
nothing to catch. These clients run during SSR, so an unbounded one stalls the page
render itself.

- Fixed in `observability.ts` (Phase 2 review) and `users-admin-api.ts` (Phase 3),
  both via `resolveSignal()` = `AbortSignal.timeout()` combined with any caller
  signal through `AbortSignal.any()`. Decorative fetches get a shorter deadline than
  primary content — the awaiting-approval badge uses 2s because it is awaited from
  the shared `AdminLayout` on *every* admin page.
- **Still outstanding: website#173** — same pattern in `admin-api.ts`, and an audit
  of `dashboard-api.ts`, `collaborators-api.ts`, `upload-client.ts`.
- Test it by driving the real abort path (a fetch that only settles by rejecting on
  its signal's abort event), never a faked timer.

## Blockers found this session

- **nemar-observability#8 (filed)** — deprecate that Worker's admin action relays.
  All four relayed actions now exist in this portal, so the paste-an-`nm_…`-API-key
  mutation path has no remaining reason to exist. Parity already achieved; it's a
  removal, not a migration.
- **nemar-cli#1023 (pre-existing)** — no admin endpoints to grant/revoke service
  access, and `GET /admin/users` doesn't project `service_access` or the
  city/country/affiliation fields ADR 0010 needs. Still why the service-access
  queue is cut from the portal.
- **nemar-cli#1012 (pre-existing, open)** — ORCID/web signups land with
  `username = NULL`, and every admin write endpoint except delete is keyed by
  username. The users page renders them with an explanation + issue link and offers
  only the id-keyed delete (owner-only). Do not "fix" this by hiding those rows:
  they are exactly the population the approval queue exists to serve.

## Immediate pick-ups

- **Apex cutover — website#190.** ww2 becomes `nemar.org`, legacy moves to ww1.
  Planned "soon", no hard date. Read that issue before touching it: the code half
  is two constants, but there is a **redirect-loop hazard**. The current
  apex → ww2 bridge is a bare `301` with no `Cache-Control`, so browsers have
  cached it persistently; if ww2 redirects back to apex at cutover those clients
  loop with no server-side remedy. **Leave ww2 serving at cutover**, retire it
  later. Also: the Cloudflare rule `nemar.org/dataset/* → ww2` must be removed or
  the apex can never serve.
- **Legacy URL rewrite — website#190 §2.** `/dataexplorer/detail?dataset_id=ds007964`
  → `/dataset/on007964`. The `ds` ⇄ `on` digit correspondence is a **contract**
  (confirmed by the owner; 199/199 sampled rows agree), so it is a plain string
  rewrite. Referrer rule: coming from ww1 → stay on ww1; otherwise → new page.
  `Referer` is unreliable, so absent-referer must default to the new site (the
  citation case). These redirects can't be edge-cached — use `no-store`.
  Note those legacy URLs **already return 521** today, so this is repair, not
  regression-avoidance.
- **Enforce the `ds`/`on` contract upstream.** `importDatasetSchema` in nemar-cli
  validates `dataset_id` and `source_id` independently, so a violating import is
  accepted today. Once the apex rewrites citation URLs on that contract, one bad
  row silently routes a cited link to the **wrong dataset**. A two-line `.refine()`.
- **Real admin pass on live data.** Notices got one this session (the owner created
  a production notice and it worked). Publications, users and imports have still
  only ever been verified against fixtures and dev mocks — which is exactly the gap
  that let the app-host banner bug (#181) ship.
- **Owner actions for real-ORCID staging login** — register
  `https://test.nemar.org/auth/orcid/callback` on the production ORCID app +
  `wrangler secret put ORCID_API_BASE --env dev` = `https://orcid.org`.

## Epic backlog

- **Admin portal — website#158. CLOSED.** All five phases shipped. The
  service-access grant queue was cut and still belongs somewhere once
  nemar-cli#1023 lands — it is the one piece ADR 0010 asked for that has no home.
- **Apex cutover — website#190.** Cutover plan + legacy URL preservation.
- **Tiered access — nemar-cli#1013.** Phase 1 shipped to dev (ADR 0010). Children:
  #1012, #1016, #1018, #1014, and the new #1023.
- **Settings self-service backends — nemar-cli#1019.** #910 merged to dev;
  remaining #911 (email change), #912 (PATCH /auth/profile), #913 (ORCID re-link).
- **Contribute / upload — website#164.** #161 (in-browser BIDS validation) + the
  upload-page `service_access` gate.

Standalone: nemar-cli#1010 (flaky integration-dev CI), website#173
(undefaulted-AbortSignal audit in the remaining API clients).
Parked: legacy import (nemar-cli#833 / website#129).
Redesign-epic remnants: website#5 (Phase 4 citation/community/docs), #6 (apex DNS).

## Standing gotchas

- `staging` must stay a fast-forward of `main`; never commit to it directly.
- nemar-cli has no staging branch: its `dev` Worker serves the `*-test.nemar.org`
  domains with D1 `nemar-db-dev`, a partial prod mirror **containing real user
  emails**. Careful with bulk ops.
- `imageService: "passthrough"` stays (sharp doesn't run in Workers).
- Session cookie is `Domain=app.nemar.org`; browser-side authenticated calls go
  through the same-origin `/api/v1/[...path]` proxy.
- OG cards under `public/og/` are generated, not source.
- `/admin` cannot be edge-cached: `isPublicCacheable` requires an explicit
  `Cache-Control: public, max-age`, which Astro SSR pages don't emit, and
  authenticated traffic bypasses the cache entirely.
- The edge-cache namespace is derived from the build commit (#189), so deploys
  self-invalidate. `app.nemar.org` skips the cache entirely, which is why it and
  ww2 can disagree and why that reads like a host-specific bug.
- Notice levels are `tip | announcement | maintenance | warning | critical`.
  `presentationLevel()` maps anything unknown (including legacy `info`) to `tip`,
  so the site survives the website and API deploying out of step in either
  direction. Don't "simplify" it away.
- Notice messages are linkified from data, never HTML. The pattern is anchored on
  `https?://` — that is the security property, not a convenience.
