# ADR 0005: Reuse the api/data.nemar.org backends; never reimplement them

**Status:** accepted
**Date:** 2026-05-18
**Owner:** Seyed Yahya Shirazi

## Context

`api.nemar.org` (D1 catalog) and `data.nemar.org` (neuroschema metadata, BIDS manifests,
byte access) are the source of truth for dataset data. They are sometimes sparse (null
timestamps/modalities on `ds*` and unsynced `on*` rows). The frontend must not fork this
logic. Backfilled 2026-07-07 from `.context/ideas.md`.

## Decision

Consume the backends; never reimplement them in the frontend. Where the upstream is sparse,
fall back gracefully (specific → general → graceful empty) and file a `nemarOrg/nemar-cli`
issue for the gap. Download links always route through `data.nemar.org/<id>/<v>/<bids-path>`,
never the manifest's direct presigned `url`.

## Consequences

- The site ships standalone with fallbacks; when an upstream fix lands, no frontend change is
  needed (fields like `Dataset.license` are already wired through the correct path).
- Routing downloads through the Worker lets the upstream `Content-Disposition` fix
  (nemar-cli#513) take effect later at the cost of one extra redirect today.
- Null-safe helpers (`formatDate(null) === ""`, etc.) must not be tightened, or Astro will
  silently drop cards whose render throws.

## Alternatives considered

- **Synthesize/parse missing data in the frontend** (e.g. git-annex pointer parsing, direct
  presigned downloads): duplicates backend logic and drifts from the contract. Rejected;
  `parseAnnexPointer` stays in `nemar-cli`.

## Receipts

- `.context/ideas.md` ("Backend integration patterns", "Download links route through
  data.nemar.org"); `AGENTS.md` [CRITICAL] Core Principles + backend dependency map.
