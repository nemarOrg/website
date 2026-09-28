# ADR 0019: Default-on anonymous analytics with a shared opt-out

**Status:** accepted
**Date:** 2026-09-28
**Owner:** Seyed Yahya Shirazi

## Context

The NEMAR website uses one Astro build across public marketing hosts and the authenticated
`app.nemar.org` host. Umami pageviews and fixed, identifier-free interaction events need one
consistent privacy choice across those origins; origin-scoped browser storage alone would allow
tracking to resume after a visitor opts out on another NEMAR site.

## Decision

Enable the allowlisted anonymous analytics by default on configured production hosts, and honor a
visitor's saved opt-out. Store the choice in a one-year Secure, SameSite=Lax first-party cookie
scoped to `nemar.org`, with timestamped local and tab storage fallbacks; keep legacy `accepted` and
`strict` choices readable.

## Consequences

- The preference carries between the public website and `app.nemar.org`; the cookie is visible to
  browser JavaScript and is sent to NEMAR subdomains, so it contains only the non-secret choice and
  its change time.
- A cookie write failure cannot let an older stored choice override a newer selection. If the
  shared cookie is unavailable, origin- or tab-scoped storage is the fallback; if all storage is
  unavailable, the choice lasts only for the current page.
- The tracker remains limited to fixed public page categories, the signed-in upload flow, and the
  five approved interaction names.
  It receives no dataset, search, file, account, or user identifiers.
- The first-visit notice and Privacy settings controls must disclose the default and allow visitors
  to opt out or turn analytics back on. The published privacy policy must match the deployed
  behavior.

## Alternatives considered

- **Origin-scoped `localStorage` only:** rejected because a choice on the marketing host would not
  carry to the authenticated host.
- **Default off until acceptance:** rejected by the product owner in favor of default-on anonymous
  usage reporting with a clear opt-out.

## Receipts

- `src/lib/cookie-consent.ts`, `src/lib/umami-analytics.ts`, and website issue #345.
- Canonical policy update in `nemarOrg/docs` privacy policy.
