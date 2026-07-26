# Handoff — nemar.org website

**Last session:** 2026-07-25.

## ⛔ ACTIVE: apex cutover, blocked on SDSC (read this first)

`ww2.nemar.org` becomes `nemar.org`; the legacy HUBzero site moves to
`ww1.nemar.org`. **Everything on our side is done. The blocker is a change on
the legacy server that was requested by email on 2026-07-25.** Do not start the
cutover until that lands and is verified.

### Waiting on: two changes on the SDSC legacy box (`132.249.225.118`, Apache)

1. **`ServerAlias ww1.nemar.org`.** The vhost serves exactly one hostname and
   302-redirects everything else to `nemar.org`. Verified by hitting the origin
   IP directly and varying only the `Host` header:

   ```
   Host: nemar.org              -> 200
   Host: ww1.nemar.org          -> 302 -> https://nemar.org/...
   Host: totallyfake.nemar.org  -> 302 -> https://nemar.org/...
   ```

   `ww1` isn't singled out — it's a catch-all canonical redirect. **This is the
   origin, not Cloudflare** (`Server: Apache`, no `cf-ray`). The only CF
   redirect rule on the zone is apex-only + `/dataset/*`-only.

2. **Base URL must follow the request host.** Pages emit
   `<base href="https://nemar.org/dataexplorer" />`, so all 36 root-relative
   links resolve against the apex no matter which hostname served the page.
   Without this, ww1 would render but eject visitors to the apex on the first
   click — i.e. to the *new* site. Generator is **HUBzero** (Joomla-derived);
   the setting is `$live_site` in `configuration.php`, empty string = derive
   from request. This also means a Cloudflare-only Host-header override is
   **not** sufficient on its own.

Verify when they reply:

```bash
curl -k -o /dev/null -w '%{http_code}\n' -H 'Host: ww1.nemar.org' https://132.249.225.118/dataexplorer   # want 200
curl -k -s -H 'Host: ww1.nemar.org' https://132.249.225.118/dataexplorer | grep -i '<base'                # want ww1
```

### Already done (don't redo)

- **`ww1.nemar.org` DNS exists** — A → `132.249.225.118`, proxied. Created via
  the Cloudflare API using the `sccn` token from `~/.config/cfman/tokens.json`
  (zone `e684135de46029c91fd6c93715ace4ce`). That token can read/write DNS but
  is **not** authorized for the origin-rules phase.
- **Legacy URL rewrite shipped** (#192, #193) and is live but inert until the
  apex moves. `/dataexplorer/detail?dataset_id=X` → `/dataset/X` (301);
  `/dataexplorer*` → `/discover` (301); `/resources` `/tools` `/members`
  `/groups` `/citations` → ww1 (302). `/about` `/support` `/login` are
  deliberately untouched — they exist on **both** sites.
- **Constants branch prepared, deliberately unmerged**:
  `feat/apex-cutover-constants` flips `MARKETING_BASE_URL` (host.ts) and `site`
  (astro.config.mjs) to `https://nemar.org`. **Merging it before DNS moves
  breaks app.nemar.org**, which would then redirect marketing routes to a
  legacy origin.

### Cutover sequence, once SDSC confirms

1. Verify ww1 serves 200 with a ww1-scoped `<base>` (commands above)
2. Merge `feat/apex-cutover-constants`
3. Add `nemar.org` **and** `www.nemar.org` as Pages custom domains on
   `nemar-website` — Pages is Host-strict, and `www` is a CNAME to the apex, so
   it breaks without its own entry
4. Delete the CF dynamic-redirect rule `DOI canonical /dataset/<id> -> ww2`
   (ruleset `5a4775f9fd6a4465ae4434b48dca0ef7`) — **while it exists the apex can
   never serve**, it just bounces
5. **Leave `ww2.nemar.org` serving. Do NOT redirect it to the apex.**

### Why step 5 is not optional

The current apex → ww2 bridge is a bare `301` with no `Cache-Control`, so
browsers have cached it persistently. If ww2 then redirects back to the apex,
those clients loop (`apex → ww2 → apex → …`) and **no server-side change can
reach them**. Leaving ww2 serving means a poisoned cache lands on a working
page. Retire ww2 only after those entries age out. Canonical tags already point
at `MARKETING_BASE_URL`, so ww2 won't compete for rankings once the constant
flips.

### Verified facts worth not re-deriving

- DOIs already resolve to the apex in the new format
  (`10.82901/nemar.on007964` → `nemar.org/dataset/on007964`), so the cutover
  *removes* a hop rather than threatening them. Nothing to re-register.
- `on` ⇄ `ds` is a **contract** (owner-confirmed), now enforced at the import
  endpoint (nemar-cli#1030/#1031, on `dev`). But the rewrite doesn't depend on
  it: `/dataset/ds*` already resolves via a real catalog lookup
  (`resolveCanonical` → `GET /datasets/resolve/<id>`), which declines when no
  mirror exists instead of inventing an id.
- `nm` datasets have `source`/`source_id` NULL — no mapping, and none needed.
- The legacy site is **healthy** (200). An earlier 521 was transient; don't
  repeat the mistake of concluding legacy is already broken.

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
(`tip`, pointing at ww1.nemar.org, expiring 2026-10-01). Note that link only
works today by redirecting to the apex — see the cutover section above.

**The active thread is the apex cutover**, blocked on SDSC. Read that section
first; it is the only thing in flight.

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
7. **Cutover prep:** #192 (deadlines on `api.ts` + the legacy dataset rewrite),
   #193 (the rest of the legacy paths), nemar-cli#1030/#1031 (`ds`/`on` contract
   enforced per-source, unregistered sources fail closed).

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

- **Apex cutover — website#190.** See the ACTIVE section at the top of this
  file. Blocked on SDSC; do not start it before their reply is verified.
- **Promote nemar-cli `dev` → `main`** when convenient. `dev` carries the
  `ds`/`on` contract enforcement (#1031) and nothing else since the 0.9.6
  promotion. Not urgent: it protects the *future* apex rewrite and there are no
  violating rows today.
- **Finish the `AbortSignal` audit — website#173.** `api.ts` was done in #192
  (4 fetches). Ten instances remain in `admin-api.ts`, `collaborators-api.ts`,
  `dashboard-api.ts` and `dir-listing.ts` — authenticated surfaces, smaller blast
  radius, same one-line fix.
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
