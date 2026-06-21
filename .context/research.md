# nemar-website Research

Technical explorations done while building. Pin findings here so they survive across sessions.

## Backend API shapes (verified live, 2026-05-15)

### `api.nemar.org/datasets`

```
GET /datasets?limit=10&offset=0&sort=newest
→ { datasets: [...], count: 10, total_count: 645, limit: 10, offset: 0 }
```

Sort options: `newest` | `oldest` | `name` | `participants` | `size`. Filters: `modality` (single, LIKE substring), `author`, `task`, `has_doi`, `recent=<days>`. Total dataset count was 645 at end of session.

### `api.nemar.org/datasets/<id>`

Returns `{ dataset: {...} }` (wrapped). `getDataset()` in `src/lib/api.ts` unwraps to a bare Dataset shape.

### `data.nemar.org/<id>/`

```json
{
  "dataset_id": "nm000104",
  "latest": "v2.0.0",
  "metadata_url": "/nm000104/metadata.json",
  "versions": [
    { "version": "v2.0.0", "doi": "...", "created_at": "...", "manifest_url": "...", "browse_url": "..." }
  ]
}
```

### `data.nemar.org/<id>/metadata.json` (neuroschema v0.3.0)

Top-level fields when populated: `schema_version`, `dataset_id`, `name`, `description`, `source`, `recording_modality[]`, `bids_version`, `license`, `authors[]` (with ORCID + affiliations), `keywords[]` (object-shaped `{term, value_uri, subject_scheme}`), `related_identifiers[]`, `rights[]`, `funding[]`, `tasks[]`, `datatypes[]`, `sessions_count`, `provenance{latest_snapshot, publish_date}`, `external_links{dataset_doi, github_url}`.

**Sparseness:** `on*` datasets often ship with nulls/empty arrays for everything except `sessions_count`. See nemar-cli#512.

### `data.nemar.org/<id>/<version>/manifest.json`

Array of `{ path, size, checksum_algorithm, checksum, url }` entries. Presigned URL TTL = 3600s.

**Gap:** small (<500B) root files were silently dropped — fixed in nemar-cli#510 (merged 2026-05-15).

## Hallu QA artifacts layout (planned for nemar-cli#511)

Source on hallu: `/data/qumulo/openneuro/processed/<id>/`. 269 dataset directories. Target S3 prefix: `s3://nemar/<id>/qa/`. Worker route: `data.nemar.org/<id>/qa/*`.

Per-file shape:

```json
{
  "nGoodData": "609,120",
  "goodDataPercentRaw": "81",
  "nGoodChans": 61,
  "goodChansPercentRaw": "87",
  "icaFail": 0,
  "nICs": 60,
  "goodICAPercentRaw": "90",
  "linenoise_magn": "14.40dB"
}
```

`parseLinenoiseDb` parses "14.40dB" → 14.4.

The website's `QaAggregates` type defines a richer shape than the bare `dataqual.json` from hallu. The sync script in nemar-cli#511 should precompute aggregates into `qa/aggregates.json`.

## NEMAR versioning policy for `on*` mirrors

Per [nemar-cli#448 comment](https://github.com/nemarOrg/nemar-cli/issues/448#issuecomment-4463685705):

> Each pull from OpenNeuro bumps the NEMAR major version. Intermediate `vN.x.y` versions are NEMAR-side fixes between pulls.

So `v1.0.0` = first OpenNeuro import, `v1.0.1` / `v1.1.0` = NEMAR fixes, `v2.0.0` = next pull. `listMirrorVersions()` filters to the `vN.0.0` set. ProvenanceToggle's "View as-imported mirror" CTA points at the highest `vN.0.0`.

## Cloudflare adapter gotchas

`@astrojs/cloudflare` with `imageService: "compile"` still bundles sharp into the SSR worker. Workers runtime can't execute it → `process.report.getReport is not implemented`. Set to `"passthrough"`. We don't use `<Image>` / `astro:assets` anywhere.

Other observed gotchas:
- `<dialog>` element needs explicit `inset:0 + margin:auto` declarations to center if any other rule overrides
- `new Date(null).getTime()` throws — null-guard before passing to date helpers
- Astro silently absorbs render-time exceptions per component; partial pages are easy to miss

## Pagination tradeoffs

Server-side `?limit=N&offset=M` reaches all 645 datasets. Multi-modality AND/OR is applied client-side per page, so `total_count` reflects server-side hits (inflated for AND across 2+ modalities). Right fix is moving AND/OR server-side (would need an `api.nemar.org` change).

## Search (LIKE currently, Meilisearch proposed)

LIKE-based search hits the catalog's `search_text` precomputed column. Doesn't handle typos, stemming, phrase proximity, or README content. [website#12](https://github.com/nemarOrg/website/issues/12) proposes Meilisearch (Rust, MIT, ~50ms p99) indexing name + description + README + authors + keywords.

## Deploy auth on the SCCN Cloudflare account

```bash
CLOUDFLARE_ACCOUNT_ID=<sccn-account-id> \
  bunx cfman wrangler --account sccn pages deploy dist \
  --project-name nemar-website --branch <branch> --commit-dirty=true
```

`CLOUDFLARE_ACCOUNT_ID` required because the SCCN API token lacks the `memberships` scope wrangler queries when enumerating accounts.

## ORCID SSO integration research (2026-06-21)

Three parallel agents researched OAuth flow, UX patterns, and backend architecture. Key findings below.

### Critical constraint: ORCID does not return email via OAuth

Email is private by default on ORCID records. The token response, id_token, and `/oauth/userinfo` endpoint do not include an email claim. The backend must **link accounts by ORCID iD (`sub`)**, not email. On first ORCID login, collect email via a form field (ORCID's own recommended practice).

### OAuth flow

- **Public API / free tier** is sufficient — no Member API needed for SSO
- Scope: `/authenticate openid`
- Authorize: `https://orcid.org/oauth/authorize`
- Token: `https://orcid.org/oauth/token` (form-urlencoded POST with client_secret)
- Token response body includes `orcid` (the iD) and `name` directly — no extra API call needed
- id_token (RS256): claims are `sub`, `name`, `given_name`, `family_name` — **no email claim**
- **No PKCE** (ORCID deliberately doesn't support it — issue #5977, closed 2022-11-28)
- Use server-side confidential client, `client_secret` in Worker env + `state`/`nonce` for CSRF/replay
- Stack: raw `fetch` + `jose` for id_token verification (both Web Crypto, Workers-compatible)
- Redirect URI must be `app.nemar.org/...` only (authenticated host)
- Dev/test against `sandbox.orcid.org` (HTTP redirects allowed there)
- ORCID access tokens expire in ~20 years — don't tie session lifetime to them; discard after use

### What already exists in nemar-cli (verified by reading codebase)

- **`users.orcid` column exists** (migration `0026_passwordless_auth.sql:72`) but holds DOI-**discovered** ORCIDs, not OAuth-verified. Must add `orcid_verified` flag to distinguish.
- **Session system is built** (`backend/src/services/web-session.ts`) — 256-bit opaque cookies, SHA-256 hash in `web_sessions`, sliding expiry, DB revocation. ORCID login should call `issueSession()` exactly like the email-code flow.
- **`github-auth.ts`** exists as a template to mirror.
- **Next migration number: 0050**

### DB schema (migration 0050)

```sql
CREATE TABLE oauth_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('orcid')),
  provider_subject TEXT NOT NULL,   -- ORCID iD e.g. 0000-0001-2345-6789
  provider_email TEXT,              -- may be NULL (private by default)
  display_name TEXT,
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  UNIQUE (provider, provider_subject)
);
CREATE INDEX idx_oauth_identities_user ON oauth_identities(user_id);
ALTER TABLE users ADD COLUMN orcid_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE web_sessions ADD COLUMN auth_method TEXT; -- 'email_code'|'orcid'
```

**Email collision rule:** if ORCID email matches an existing `users.email`, do NOT auto-link — require sign-in via existing method first. Auto-linking on email match is an account-takeover vector.

**Discovered vs. verified:** if OAuth `provider_subject` matches existing `users.orcid` (DOI-discovered), set `orcid_verified=1`. If it differs, log for admin review — don't overwrite the citation-facing value.

### Routes (4, mirror existing /auth/* Hono mount)

```
GET  /auth/orcid/start     → set state cookie, 302 to orcid.org/oauth/authorize
GET  /auth/orcid/callback  → verify state, exchange code, find-or-create, issueSession
POST /auth/orcid/link      → (authed) link ORCID to current account
POST /auth/orcid/unlink    → (authed) remove oauth_identities row
```

New Worker secrets: `ORCID_CLIENT_ID`, `ORCID_CLIENT_SECRET`, `ORCID_API_BASE`.

### Session strategy

Reuse `issueSession()` — opaque cookie, no JWT. Don't store the ORCID access token (20-year expiry = worst-case exfil item). Read `orcid` + `name` from token body, discard the rest.

### UX decision

- **ORCID-primary** (OpenNeuro model — migrated to ORCID-only May 2025, closest peer)
- ~90–93% of neuroscience/biomedical researchers have ORCID iDs — requiring it is a provenance signal
- Button: "Sign in with ORCID", unaltered green SVG from ORCID Brand Library (not hardcoded hex — `#A6CE39` is community convention, not official)
- iD display: green icon + full `https://orcid.org/0000-...` URI hyperlinked, 24×24px icon, on profile and dataset detail rail
- First login: OAuth gives iD + name → ask for email via form → create account

### First PR scope (thinnest correct slice)

Migration 0050 + 4 routes + `/authenticate` scope only (no token storage) + find-or-create with no email auto-merge + email-collection onboarding for new signups. Defer profile enrichment (employment/affiliations) to a follow-up.

**Confirm before building:** Public API (free/developer) or Member API credentials? Login works on either; `/read-limited` enrichment requires Member tier.

## Legacy nemar.org assets reused

- `public/hero-brain.png` (368KB) — wireframe brain illustration from legacy `/app/templates/nemar/img/brain-blue.png`
- `public/hero-bg.jpg` (42KB) — atmospheric backdrop from same path; currently unused (replaced with a CSS gradient + stars)
- `public/nemar-logo.svg` — text + brain + electrodes from legacy home page; uses `currentColor` for theming

Brain illustration is recolored per theme via CSS:
- Dark mode: `mix-blend-mode: screen` (teal glows through black)
- Light mode: `filter: invert(1) hue-rotate(180deg) saturate(0.7) brightness(0.85)` (dark navy outline)
