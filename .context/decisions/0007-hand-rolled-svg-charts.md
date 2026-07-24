# ADR 0007: Hand-rolled SVG charts (no chart library)

**Status:** accepted
**Date:** 2026-05-18
**Owner:** Seyed Yahya Shirazi

## Context

The Phase 3/4 dashboards need a handful of essentially static charts (pipeline success, a few
histograms, age/gender). Backfilled 2026-07-07 from `.context/ideas.md`.

## Decision

Hand-author each chart as inline SVG (~80–150 lines each) rendered in the SSR HTML. No chart
library dependency.

## Consequences

- Charts inline into the server-rendered HTML with zero JS runtime cost.
- New chart types cost author time rather than a dependency.

## Alternatives considered

- **Chart.js / Recharts / similar:** 50–200 KB of JS shipped for visuals that are static.
  Rejected for a mostly server-rendered site.

## Receipts

- `.context/ideas.md` ("Charts are hand-rolled SVG"); `AGENTS.md` Tech Stack.
