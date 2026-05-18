# nemar.org

The redesigned NEMAR (Neuroelectromagnetic Data Archive and Tools Resource) website. Astro 6 on Cloudflare Pages. Reuses `api.nemar.org` (D1 catalog) and `data.nemar.org` (BIDS HTTPS view) as its backend.

## Quickstart

```bash
bun install
bun run dev      # http://localhost:4321
bun run build
bun run preview
```

## Test

```bash
bun run typecheck   # astro check (.astro + .ts)
bun run lint        # biome
bun run test        # vitest unit tests
RUN_E2E=1 bun run test:e2e   # playwright smoke (requires live API)
```

## Deploy

Cloudflare Pages, project `nemar-website`. Pushes to any branch get a preview; `main` gets production.

```bash
bun run build
bunx wrangler pages deploy dist
```

## Architecture

```
nemar.org
  ├─ api.nemar.org/datasets                 catalog list/search (D1)
  ├─ data.nemar.org/<id>/metadata.json      per-dataset neuroschema doc
  ├─ data.nemar.org/<id>/<ver>/manifest.json   BIDS file index
  ├─ data.nemar.org/<id>/<ver>/<path>       302 -> presigned S3
  └─ data.nemar.org/<id>/qa/*               QA artifacts (mirrored from hallu, Phase 3)
```

The site is mostly server-rendered at the edge (Cloudflare Workers via the Astro adapter) with islands of client-side interactivity for filters and modals.

## Repo layout

```
src/
  components/   shared .astro components
  layouts/      Base layout (nav, footer, theme)
  lib/          api client, filter state, formatters, types
  pages/        Astro routes
  styles/       tokens, reset, global
public/         static assets (logos, favicons)
```

See `CLAUDE.md` (when present) for dev conventions and the project epic.
