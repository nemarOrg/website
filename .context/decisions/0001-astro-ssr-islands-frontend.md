# ADR 0001: Astro (server output + islands) as the frontend framework

**Status:** accepted
**Date:** 2026-05-18
**Owner:** Seyed Yahya Shirazi

## Context

The redesign replaces the legacy Joomla nemar.org with a modern front door. The surface is
mostly server-rendered marketing-and-catalog pages with small islands of interactivity
(theme toggle, modals, the signal viewer). The backend already lives on Cloudflare Workers.
Backfilled 2026-07-07 from `.context/ideas.md`.

## Decision

Use Astro 6 with the `@astrojs/cloudflare` adapter, `output: "server"`, and selective
hydration. No JS framework runtime ships unless a component asks for it.

## Consequences

- Pages are server-rendered at the Worker edge; interactivity is opt-in per component.
- `imageService: "passthrough"` is a forced constraint (sharp does not run in the Workers
  runtime); it must not be changed.
- The team iterates in a stack close to the Workers backend it consumes.

## Alternatives considered

- **Next.js:** wanted to ship a JS runtime for every page. Rejected for a mostly-static site.
- **SvelteKit:** its Cloudflare edge story was less mature than Astro's at decision time.

## Receipts

- `.context/ideas.md` ("Astro over Next.js / SvelteKit"); `AGENTS.md` Tech Stack section.
