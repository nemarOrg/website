# ADR 0002: Cloudflare Pages as the deploy target

**Status:** accepted
**Date:** 2026-05-18
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR's backend already runs on Cloudflare Workers (`api.nemar.org`, `data.nemar.org`) plus
D1. The frontend needs a host that co-locates with those services and keeps operations
simple. Backfilled 2026-07-07 from `.context/ideas.md`.

## Decision

Host the frontend on Cloudflare Pages (project `nemar-website`, SCCN account), served as an
Advanced-Mode `_worker.js` from the Astro server build.

## Consequences

- Single Cloudflare account and bill; sub-region edge co-location with the API.
- Deploys go through `cfman wrangler --account sccn`; `CLOUDFLARE_ACCOUNT_ID` must be passed
  explicitly because the SCCN token lacks the memberships scope wrangler would otherwise call.
- Because every route is server-rendered through `_worker.js`, response headers (e.g. the
  CSP) live in middleware, not `public/_headers` (which Pages applies only to static assets).

## Alternatives considered

- **Vercel / Netlify:** a second account and bill, and no co-location with the CF Workers
  backend. Rejected.

## Receipts

- `.context/ideas.md` ("Cloudflare Pages over Vercel / Netlify"); `AGENTS.md` Deploy section.
