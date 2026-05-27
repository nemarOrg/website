# NEMAR Website Design Language

Single source of truth for the website's visual vocabulary. When a PR
introduces a new interactive element, check this doc first; if the new
element doesn't fit any of the three shape families below, write up why
in the PR description before merging.

Token values (colors, spacing, radii, typography) live in
`src/styles/tokens.css`. This document is about **when and how** to use
those tokens, not what they are.

## Tokens

Categories used most often:

- **Palette:** `--color-bg`, `--color-bg-elevated`, `--color-bg-subtle`,
  `--color-fg`, `--color-fg-muted`, `--color-fg-subtle`,
  `--color-border`, `--color-border-strong`,
  `--brand-teal`, `--brand-purple`, `--brand-navy`,
  `--color-link`, `--color-warning`.
- **Spacing:** `--space-1` (0.25rem) through `--space-24` (6rem).
- **Radii:** `--radius-sm` (4px), `--radius-md` (8px), `--radius-lg` (12px),
  `--radius-xl` (20px), `--radius-pill` (999px).
- **Typography:** `--fs-xs` through `--fs-6xl`; `--fw-medium`, `--fw-semibold`,
  `--fw-bold`; `--font-sans`, `--font-mono`, `--font-display`.

Rule: **never hardcode a hex, rem, or pixel value in component CSS**. If
the value doesn't exist as a token, add it to `tokens.css` first with a
short comment explaining the semantic. The only exception is `color-mix()`
that blends two existing tokens.

## Three shape families

The site has three interactive shape vocabularies. Each has a defined
semantic. Mixing them for the wrong semantic is a design error.

### Pills

Shape: `border-radius: var(--radius-pill)`. Visible border in the inactive
state. Active / primary state: filled background, contrasting text.

Semantic: clicking a pill **selects a mode or triggers an action**. The
pill does not represent where you are in a hierarchy. It represents what
you choose to do or view.

Use for:

- Primary page actions (download, submit, close dialog) — see
  `src/components/ActionBar.astro`.
- Secondary actions (ghost variant with border, no fill) — same file.
- Category selection within a panel — see
  `src/components/DatasetTabs.astro` (Demographics vs Data quality).
- Dialog close / form submit buttons.

Active state contract: `background: var(--color-fg)`, `color: var(--color-bg)`,
`border-color: var(--color-fg)`. Inactive: `background: var(--color-bg)`,
`border: 1px solid var(--color-border-strong)`, muted text.

Sizing: 36 px min-height inside panels (`DatasetTabs`); 44 px min-height
for top-level page actions (`ActionBar`). The 44 px target matches WCAG
2.5.5 for primary affordances; 36 px is acceptable for nested controls
where the surrounding density is already compact.

Do:

```html
<button class="dtabs__tab" role="tab" aria-selected="true">Demographics</button>
```

Don't:

```html
<!-- Wrong: pill for navigating between dataset versions. Versions are a
     timeline — use the underline tab pattern. -->
<a class="dtabs__tab" href="?v=1.1.0">v1.1.0</a>
```

### Chips / tags

Shape: same `--radius-pill` as pills, but smaller padding (~1px 6px),
smaller font (`--fs-xs`), filled subtle background, no border. **Non-
interactive**: chips are labels, not buttons.

Semantic: taxonomy. A chip communicates metadata about something
(file type, modality, license tier). It is read, not clicked.

Use for:

- Modality badges (`ModalityBadge.astro`).
- File-type hints on tree rows ("JSON", "README", "Vis · soon") —
  `.tree__tag` in `BidsTree.astro`.
- Version-mirror marker (`vsw__mirror` in `VersionSwitcher.astro`).
- Keyword chips on dataset detail pages.

Size distinction from pills: if it's something a user taps, it's a pill
and needs a touch target ≥ 36 px. If it's a label they read, it's a chip
and the geometry is whatever reads compactly (~24 px tall is common).

Do:

```html
<span class="tree__tag">JSON</span>
```

Don't:

```html
<!-- Wrong: chip on an interactive element. If clicking it does something,
     use a pill and a 36 px+ touch target. -->
<button class="tree__tag">Filter by JSON</button>
```

### Underline tabs

Shape: button or link, no background, no border, 2 px `border-block-end`
in the active state. The underline is the only active indicator.

Semantic: **navigation within a dimension that has a natural sequence or
identity**. Used when tabs represent _instances_ of the same thing
(versions, time slices), not _categories_ to choose between. The
underline signals "this is the current position in a linear set."

Use for:

- Dataset version navigation — `VersionSwitcher.astro`.
- A future "view as list / view as grid" toggle on a homogeneous set.

Do NOT use underline tabs for:

- Mode switching within a panel (Demographics vs Data quality) — use pills.
- Action triggers — use pills.
- Taxonomy filtering — use pills or chips.

Do:

```html
<a class="vsw__tab vsw__tab--active" role="tab" aria-selected="true" href="?v=1.1.0">
  <span class="vsw__ver">v1.1.0</span>
  <span class="vsw__date">2025-01-10</span>
</a>
```

Don't:

```html
<!-- Wrong: underline tab for category selection within a panel.
     Use pills (DatasetTabs pattern). -->
<button class="vsw__tab vsw__tab--active">Data quality</button>
```

## Decision tree

```
Is the element interactive (clickable / focusable)?
├── No  → Chip (span, not button/link)
└── Yes → Does clicking move along a sequence / timeline of like-kind items?
    ├── Yes → Underline tab
    └── No  → Pill
        ├── Primary action / category currently selected → filled
        └── Secondary action / unselected → ghost outlined
```

Heuristic when the answer isn't obvious: if you'd describe the items as
"choose one option from a set of categories," it's pills. If you'd
describe them as "go to a specific version of this thing," it's underline
tabs.

## Theming rules

### Light and dark are equal citizens

Every CSS rule must resolve in both themes. Test both before commit. The
theme bootstrap in `src/layouts/Base.astro` reads `localStorage` and sets
`[data-theme]` synchronously before first paint — don't move it, don't
add delay.

### Token-only color values

Never use a hardcoded hex / rgb in component styles. If you need a color
that doesn't exist, add it to `tokens.css` first.

Exception: `color-mix()` that blends two existing tokens is fine:

```css
background: color-mix(in srgb, var(--color-warning) 8%, var(--color-bg));
```

### Adding a new theme-conditional value

In scoped `<style>` blocks (Astro components where styles are NOT injected
via `innerHTML`):

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .my-component { ... }
}
:root[data-theme="dark"] .my-component { ... }
```

Both branches are required: the media query for OS-default users, the
data-theme branch for users who explicitly toggled.

In `<style is:global>` blocks (when the HTML is injected via `innerHTML`),
only the token variables are needed — they already resolve correctly from
the `<html>` element's `[data-theme]` attribute, set by the bootstrap
script.

## Checklist for new elements

Before adding a new interactive element:

1. Identify the semantic: action, category selection, taxonomy label, or
   navigation.
2. Map to a shape using the decision tree above.
3. Reuse an existing component class if the shape already exists. Don't
   create a one-off variant — extend the BEM block or add a modifier.
4. Verify both themes via `/browse` against a preview deploy.
5. If you needed to add a new color/spacing/radius/font token, add it to
   `tokens.css` and put a one-line comment explaining the semantic.

When in doubt, match an existing pattern before inventing a new one. The
goal of this document is consistency, not novelty.
