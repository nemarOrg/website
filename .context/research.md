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
CLOUDFLARE_ACCOUNT_ID=da8d7a2a8680dab01592bbbc6f67f12c \
  bunx cfman wrangler --account sccn pages deploy dist \
  --project-name nemar-website --branch <branch> --commit-dirty=true
```

`CLOUDFLARE_ACCOUNT_ID` required because the SCCN API token lacks the `memberships` scope wrangler queries when enumerating accounts.

## Legacy nemar.org assets reused

- `public/hero-brain.png` (368KB) — wireframe brain illustration from legacy `/app/templates/nemar/img/brain-blue.png`
- `public/hero-bg.jpg` (42KB) — atmospheric backdrop from same path; currently unused (replaced with a CSS gradient + stars)
- `public/nemar-logo.svg` — text + brain + electrodes from legacy home page; uses `currentColor` for theming

Brain illustration is recolored per theme via CSS:
- Dark mode: `mix-blend-mode: screen` (teal glows through black)
- Light mode: `filter: invert(1) hue-rotate(180deg) saturate(0.7) brightness(0.85)` (dark navy outline)
