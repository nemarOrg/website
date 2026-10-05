# ADR 0021: A page-set `no-referrer` survives the middleware's security headers

**Status:** accepted
**Date:** 2026-09-30
**Owner:** Seyed Yahya Shirazi

## Context

`applySecurityHeaders` in `src/middleware.ts` runs after every page and sets one site-wide header set, including `Referrer-Policy: strict-origin-when-cross-origin`.
`/auth/private/authorize`, the sign-in hop for `private.nemar.org` (NEMAR's site for access-controlled features), carries a `state` in its own URL, and nemar-cli's `shared/contract/private-site.ts` requires that page to be served with `Referrer-Policy: no-referrer` so the `state` never leaves in a `Referer`.
The page sets that header itself, and the middleware overwrote it.
A first fix keyed the exception on the path, the way ADR 0009 keys `'unsafe-eval'`; review showed it failed open, because Astro decodes a request path before routing, so `/auth/private/%61uthorize` and `/auth/%70rivate/authorize` render the page while a path comparison in the middleware does not recognize them.

## Decision

The middleware reads the response's `Referrer-Policy` before applying its own headers, and when the page already set `no-referrer` it keeps it; any other value, or none, gets the site-wide policy.
Only `no-referrer` is honored, so a page can make the policy stricter and never looser.

## Consequences

- The header follows the code that knows the URL is sensitive, whatever spelling of the path reached it; there is no path list to keep in step with routing.
- Any page can opt in by setting the header on its responses, redirects included (`Astro.redirect()` does not carry page headers, so such a page builds its own redirect responses).
- A page cannot weaken the policy by setting a looser value; the middleware replaces it.
- The behavior is pinned by `src/middleware.test.ts`, including both percent-encoded spellings, and by the page-source test for `/auth/private/authorize`, which asserts the page sets the header on every response.

## Alternatives considered

- **Path-keyed exception in the middleware:** the first version. Fails open for percent-encoded paths, as above; normalizing the path in the middleware would mean re-implementing Astro's routing decode and keeping it in step.
- **Honor whatever `Referrer-Policy` a page sets:** simpler, but lets a page loosen the site-wide policy without anyone noticing.
- **Set `<meta name="referrer">` in the page instead:** covers rendered panels but not the 302 responses, which carry no document, and the redirect to the private site's callback is the request that matters.

## Receipts

- nemar-cli `shared/contract/private-site.ts` (the website MUST serve the authorize page with `Referrer-Policy: no-referrer`).
- ADR 0009, the route-scoped CSP exception this departs from.
