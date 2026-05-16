# nemar-website Design Ideas

Captures the design decisions made during the redesign. Not a backlog — that's `plan.md`. Not a session journal — that's `handoff.md`. This is *why we chose this approach*.

## Vision

Modern, content-first, theme-aware front door for NEMAR. The legacy Joomla site works but is dated and hard to evolve. The redesign keeps NEMAR's visual identity (brain motif, deep navy + teal accents) while bringing the underlying stack to something the team can actually iterate on.

Three audiences, three jobs:

1. **Researchers** browsing datasets — Discover + detail page must surface enough metadata in 5 seconds to decide "is this worth downloading"
2. **Programmatic users** (rclone, aria2c, scripts) — every URL is a stable contract; downloads keep BIDS filenames; pagination is predictable
3. **Dataset uploaders** — currently sent to nemar-cli; new researcher dashboard epic (website#10) will give them a web flow

## Stack decisions

### Astro over Next.js / SvelteKit
Astro's SSR + selective hydration matches the use case: mostly server-rendered marketing-and-catalog pages with islands of interactivity (modals, theme toggle). No JS framework runtime ships unless a component asks for it.

The competition: Next.js wanted to ship a runtime for every page; SvelteKit's edge story on Cloudflare is less mature than Astro's.

### Bun over Node
Lockfile is `bun.lock`. Match the convention in `nemar-cli`. Fast cold installs matter when Pages CI clones the repo on every push.

### Vanilla CSS with tokens over Tailwind / styled-components
Tokens in `src/styles/tokens.css`, scoped `<style>` blocks per Astro component. The site has ~25 components total — Tailwind's utility classes would add bundle weight without saving authoring time at this scale. Theme switching is straightforward with custom properties.

### Cloudflare Pages over Vercel / Netlify
NEMAR's backend already lives on Cloudflare Workers (`api.nemar.org`, `data.nemar.org`). Putting the frontend on Pages means single account, single bill, sub-region edge co-location with the API.

## Component-level decisions

### ProvenanceToggle replaced ProvenanceCard
First iteration shipped a large card explaining the OpenNeuro→NEMAR lineage with DOI parity grid and two CTAs. User feedback: too much real-estate for what's effectively "this is a copy, here's how to switch view".

Replaced with a compact chip ("NEMAR copy of ds00xxxx") next to the dataset ID. Click reveals a small popover with the same info. Same content, ~10x less visual weight.

### Brain hero in light mode
Same `hero-brain.png` asset (legacy teal-on-black wireframe) in both themes. Dark mode: `mix-blend-mode: screen` lets the teal glow through. Light mode: `filter: invert + multiply` recolors to dark-navy outline. One asset, two looks.

Alternative considered: two separate brain assets. Rejected because the filter trick produces a coherent look across themes and saves a download.

### Charts are hand-rolled SVG (no chart-lib)
Phase 3 has 4 charts (pipeline success, 3 histograms, age/gender). Each is ~80-150 lines of inline SVG. Total chart code: ~500 lines.

A chart library (Chart.js, Recharts, etc.) would ship 50-200KB of JS for visuals that are static. The hand-rolled approach inlines them into the SSR HTML — zero JS runtime cost.

### Sparkles via CSS-only radial gradients
The legacy hero uses particles.js. We replaced it with two stacked layers of radial-gradient dots with offset twinkle animations. No JS dependency, respects `prefers-reduced-motion`.

### Download links route through `data.nemar.org` even though the manifest has direct presigned URLs
Putting the Worker in the chain lets the upstream `response-content-disposition` fix (nemar-cli#513) take effect without a frontend change. Costs one extra HTTP redirect; saves an entire migration when the backend lands.

## Backend integration patterns

### Three-tier fallback for the right rail
Neuroschema metadata.json is sometimes sparse on `on*` datasets. We fall back to:
1. `metadata.json` fields (preferred — version-locked)
2. `api.nemar.org/datasets/<id>` catalog row (for fields the catalog has but metadata.json doesn't — modalities, tasks, authors)
3. Hardcoded empty state if both fail

This pattern (specific → general → graceful empty) extends to the README (manifest → GitHub raw → metadata.description) and QA (live → fixture in dev → empty state).

### `parseAnnexPointer` lives in nemar-cli, not here
Manifest entries arrive pre-resolved. The frontend never sees git-annex pointer format. If a new backend changes that contract, file an upstream issue rather than parsing pointer files in the website.

## Decisions we didn't take (yet)

### Service worker / offline
NEMAR is research infra, not a PWA. Skip.

### Real-time collaboration on dataset pages
Out of scope for the redesign. The researcher dashboard epic might revisit this for in-progress uploads.

### A11y testing in CI
Manual via `/design-review` for now. Could add `@axe-core/playwright` once the test infrastructure matures.

### i18n
Single locale (en-US) for now. The legacy site is English-only. If demand surfaces, Astro has solid i18n support.

## Design tokens evolved this session

- `--brand-navy: #0b1a3a`, `--brand-teal: #5bbad5`, `--brand-purple: #603cba` (extracted from legacy)
- Type: Rubik for display, Inter for body, JetBrains Mono for code
- Spacing: `4px` base, scale 1-24
- Touch targets: 44px minimum (WCAG)
- Border radius: 4 / 8 / 12 / 20 / pill — semantic, not uniform
