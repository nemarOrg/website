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

## Scheduled OG rebuilds

Dataset OG PNGs are generated during `bun run build` from the live
`api.nemar.org/datasets` catalog. New datasets that appear between website
commits need a scheduled Pages rebuild so their missing
`public/og/dataset-card/{id}.png` files are rendered into the next deployment.

Cloudflare setup:

1. In the `nemar-website` Pages project, create a Deploy Hook named
   `dataset-og-rebuild` for the `main` branch.
2. Store that hook URL as the scheduled Worker secret:

   ```bash
   bun wrangler secret put NEMAR_PAGES_DEPLOY_HOOK_URL -c wrangler.og-cron.toml
   ```

3. Deploy the Worker cron trigger:

   ```bash
   bun run deploy:og-cron
   ```

The cron lives in `wrangler.og-cron.toml` and runs every four hours. Cloudflare
cron expressions use UTC.

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

## Community and policies

- [NEMAR policies](https://docs.nemar.org/policies/): privacy policy, data contributor terms, GDPR position statement, takedown procedure
- [Code of Conduct](https://github.com/nemarOrg/.github/blob/main/CODE_OF_CONDUCT.md), [Contributing](https://github.com/nemarOrg/.github/blob/main/CONTRIBUTING.md), and [Security policy](https://github.com/nemarOrg/.github/blob/main/SECURITY.md) apply org-wide from [nemarOrg/.github](https://github.com/nemarOrg/.github).
- Help using NEMAR: support@nemar.org. Bugs and feature requests: open an issue on this repository.
