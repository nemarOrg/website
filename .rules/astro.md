# Astro + Bun + Cloudflare Pages Standards

## Stack assumptions

- **Astro 6** with `@astrojs/cloudflare` adapter
- **Bun** for package management — never `npm`, `npx`, `pnpm`
- **Biome** for lint + format (`biome.json` at root)
- **Vitest** for unit tests
- **Cloudflare Pages** as the deploy target

## Critical config — don't change without measuring

In `astro.config.mjs`:

```js
adapter: cloudflare({
  imageService: "passthrough",   // NOT "compile" — sharp doesn't run in Workers
})
```

The `compile` option pulls sharp into the SSR bundle. The Workers runtime can't execute it (`process.report.getReport is not implemented`). The whole deploy fails. We don't use `<Image>` / `astro:assets` anywhere — every visual is a plain `<img>` referencing `/public/*.{svg,jpg,png}`. Passthrough is correct.

`output: "server"` for SSR routing. The detail page and Discover need to render at request time because they consume live API data.

## Component conventions

### Scoped styles don't cross components
Astro scopes every `<style>` block to its component file. If `ComponentA.astro` imports `ComponentB.astro` and ComponentB has a `.row` class, ComponentA's `.row` styles won't apply.

**Implication:** when two components share layout (recursive rendering, common rows), **duplicate the CSS** in both files with a sync comment. Don't try to "DRY" with a global stylesheet — the per-file scoping is the feature, not the bug.

Example: `SiteNotices.astro` and `src/pages/admin/notices.astro` each declare their own matched notice-tone rules (`.site-notice--tip` / `.notice-badge--tip`, and the other levels) independently, with a comment on each side pointing at the other.

### Component file layout

```astro
---
// 1. Imports + props interface
import type { Foo } from "../lib/foo";
interface Props { foo: Foo; }
const { foo } = Astro.props;

// 2. Server-side computations
const derived = compute(foo);
---

<!-- 3. Markup -->
<div class="component">
  ...
</div>

<style>
  /* 4. Scoped styles */
  .component { ... }
</style>

<script>
  /* 5. Browser scripts (if any) — vanilla TS, no client framework */
</script>
```

### When to add a client script

Only for interactions that need browser behavior: modals, theme toggle, dropdowns. Use vanilla TS, attach via `document.addEventListener` + `closest()` querySelector to support delegation. Don't reach for React / Vue / etc. — adding a UI framework breaks the bundle size budget.

## File structure

```
src/
  layouts/    shared HTML shells (.astro) — must include <Base> import
  pages/      routes; one .astro per URL
  components/ reusable .astro components (scoped <style>)
  lib/        typed helpers + clients (.ts); co-located .test.ts via vitest
  styles/     tokens.css, reset.css, global.css
public/       static assets served verbatim
test/         vitest config + fixtures
```

## Theme tokens

All UI colors, spacing, and type live in `src/styles/tokens.css` as CSS custom properties. Light theme defaults, dark theme via:

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* dark overrides */ }
}
:root[data-theme="dark"] { /* same dark overrides for explicit toggle */ }
```

A small FOUC-prevention script in `Base.astro` sets `[data-theme]` from localStorage *before* paint. Don't move it.

**Never** hardcode colors. Always `var(--color-fg)`, `var(--space-3)`, etc.

## Testing

- **Pure helpers** (`src/lib/*.ts`): vitest co-located `*.test.ts`. Test the real shape from fixtures under `test/fixtures/` — these were captured from live APIs, not synthesized.
- **Page rendering**: use the `/browse` skill against the dev server or a Cloudflare Pages preview deploy. Don't write Playwright suites that mock the backend.
- **Typecheck must stay green**: `bun run typecheck` (which runs `astro check`) is a pre-commit gate.

## Test patterns

Co-locate tests: `src/lib/foo.ts` ↔ `src/lib/foo.test.ts`. Import the function directly:

```ts
import { describe, expect, it } from "vitest";
import { foo } from "./foo";

describe("foo", () => {
  it("does X with real input", () => {
    expect(foo({...realShape})).toBe(expected);
  });
});
```

No mocks. If a helper calls `fetch()`, write the test against a captured fixture in the test body, not a mocked global.

## Bun commands

```bash
bun install                # never npm; lockfile is bun.lock
bun run dev                # http://localhost:4321
bun run build              # outputs dist/
bun run preview            # serves dist/ locally
bun run test               # vitest
bun run typecheck          # astro check
bun run lint               # biome check
bun run format             # biome format --write src
```

## Cloudflare Pages deploy

Use `cfman wrangler` (the multi-account wrapper) — never bare `wrangler`. The current production target is the SCCN account:

```bash
CLOUDFLARE_ACCOUNT_ID=<sccn-account-id> \
  bunx cfman wrangler --account sccn pages deploy dist \
  --project-name <name> --branch <production-branch>
```

The `CLOUDFLARE_ACCOUNT_ID` is required because the SCCN API token lacks the `memberships` scope.

`wrangler.toml` declares the env vars consumed at build time (`PUBLIC_API_BASE_URL`, `PUBLIC_DATA_BASE_URL`). Production env vars also need to be set in the Pages dashboard — building locally vs Pages CI uses two different paths to env.

## Performance budget

- Each route's SSR bundle should stay under a Worker's 1MB CPU + 50MB heap.
- Avoid pulling Node-only deps; if a transitive dep needs `process.report`, the deploy fails (see sharp gotcha above).
- Server-side fetch fan-out via `Promise.all` for parallel requests. Individual fetches use 3-5s timeouts and return `null` on 404/429/5xx — never throw in render-path code unless you're ready to render a 500.
