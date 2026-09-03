# ADR 0004: Vanilla CSS with design tokens (no Tailwind, no CSS-in-JS)

**Status:** accepted
**Date:** 2026-05-18
**Owner:** Seyed Yahya Shirazi

## Context

The site is ~25 Astro components and must be fully theme-aware, with light and dark as equal
citizens. Styling approach affects every component and the theme system.
Backfilled 2026-07-07 from `.context/ideas.md`.

## Decision

Use vanilla CSS with custom-property tokens in `src/styles/tokens.css` and scoped `<style>`
blocks per Astro component. No Tailwind, no CSS-in-JS.

## Consequences

- Theme switching is straightforward via custom properties; no utility-class bundle weight.
- Astro scoped styles do not cross component boundaries, so shared styling is duplicated on
  purpose (e.g. `SiteNotices.astro` / `admin/notices.astro`'s matched notice-tone rules) with a
  sync comment. This is intentional, not a DRY violation.

## Alternatives considered

- **Tailwind:** utility classes add bundle weight without saving authoring time at ~25
  components. Rejected.
- **styled-components / CSS-in-JS:** ships a runtime and fights Astro's SSR model. Rejected.

## Receipts

- `.context/ideas.md` ("Vanilla CSS with tokens ..."); `AGENTS.md` Project-Specific Guidelines.
