# ADR 0003: Bun as the package manager and runtime

**Status:** accepted
**Date:** 2026-05-18
**Owner:** Seyed Yahya Shirazi

## Context

The project needs a JS/TS toolchain. `nemar-cli` already standardizes on Bun, and Cloudflare
Pages CI clones the repo and installs dependencies on every push, so cold-install speed
matters. Backfilled 2026-07-07 from `.context/ideas.md`.

## Decision

Use Bun for package management and scripts. The lockfile is `bun.lock`. Never use `npm`,
`pnpm`, or `npx`.

## Consequences

- Fast cold installs in CI; convention parity with `nemar-cli`.
- Contributors and CI must have Bun available.
- Mixing in npm/pnpm would desync the lockfile; it is disallowed in `AGENTS.md`.

## Alternatives considered

- **Node + npm/pnpm:** slower cold installs and diverges from the `nemar-cli` convention.
  Rejected.

## Receipts

- `.context/ideas.md` ("Bun over Node"); `AGENTS.md` Tech Stack + [NEVER DO THIS].
