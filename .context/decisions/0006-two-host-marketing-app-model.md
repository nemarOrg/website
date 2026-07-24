# ADR 0006: Two-host model (marketing + authenticated) on one build with edge middleware

**Status:** accepted
**Date:** 2026-05-18
**Owner:** Seyed Yahya Shirazi

## Context

One Astro build must expose both an anonymous, cacheable marketing surface and an
authenticated surface, without the session cookie leaking to sibling hosts
(`data.nemar.org`, `api.nemar.org`, `docs.nemar.org`). The apex `nemar.org` is still on the
legacy F5 origin during the transition. Backfilled 2026-07-07 from `AGENTS.md` +
`.context/handoff.md`.

## Decision

Attach two custom domains to the one Pages project: `ww2.nemar.org` (marketing — anonymous,
cacheable, skips `/auth/me`) and `app.nemar.org` (authenticated — cookie-scoped to this host,
no edge cache). `src/middleware.ts` reads `Astro.url.hostname` and 301-redirects cross-host
mismatches; route classification lives in `src/lib/host.ts`. The eventual apex cutover is a
one-line `MARKETING_BASE_URL` flip plus a redeploy.

## Consequences

- Anonymous traffic never pays the `/auth/me` round-trip and can be edge-cached; the session
  cookie is scoped to `app.nemar.org`.
- Non-production hosts (localhost, `*.pages.dev` previews) run single-host with no redirects,
  so QA against a preview URL is cheap.
- Per-route/per-host response concerns (e.g. CSP, cache policy) are centralized in the
  middleware.

## Alternatives considered

- **Separate builds/Pages projects per surface:** more infrastructure and divergent deploys
  for what is one codebase. Rejected.

## Receipts

- `AGENTS.md` Project Context (two-host model); `src/middleware.ts`, `src/lib/host.ts`;
  memory `project_subdomain_split`.
