# ADR 0031: The cross-site form check is the site's own, with one exemption: the authorization-request POST

**Status:** accepted
**Date:** 2026-11-07
**Owner:** Seyed Yahya Shirazi

## Context

Astro's built-in origin check (`security.checkOrigin`, on by default) answers 403 to any non-safe request with a form content type whose `Origin` is not the site's own, before any page code runs.
It is the only cross-site request forgery (CSRF) defense of every cookie-authenticated form and endpoint on this site; the API relies on it for its writes that do not check `Origin` themselves (nemar-cli ADR 0119, Context).
NEMAR is an OpenID Connect provider, and OpenID Connect Core 3.1.2.1 requires the authorization endpoint (`/oauth/authorize`) to accept both GET and form-encoded POST.
The OpenID conformance suite's module `oidcc-ensure-post-request-succeeds` sends a cross-site form POST to that endpoint, and the built-in check refuses it.
The built-in has no exemption setting.

## Decision

Astro's check is switched off (`security: { checkOrigin: false }` in `astro.config.mjs`) and `src/middleware.ts` runs the site's own, `crossSiteFormRefusal` in `src/lib/origin-check.ts`, as the first thing `onRequest` does.
It is Astro 6.3.3's rule, line for line (a test sends 504 combinations of method, content type and Origin through both and compares them), with one exemption.

**The exemption** is a request that is all of: method `POST`; path exactly `/oauth/authorize` (as the URL parser spells it: no trailing slash, no other case, no encoding); media type exactly `application/x-www-form-urlencoded`.
Its `Origin` is not consulted, so a `null` Origin (a sandboxed frame, a cross-origin redirect hop, a `Referrer-Policy: no-referrer` page) is exempt too.
Every other request, including `multipart/form-data`, `text/plain`, a missing Content-Type, every other path and spelling, and every other method, gets the built-in's rule unchanged.

**The invariant: an authorization-request POST can only render.**
The consent form posts to the same path with the same content type, and the middleware cannot tell the two apart without reading the body.
So the page does: `readAuthorizeInput` (`src/lib/oidc-authorize.ts`) answers `forbidden` for any POST whose body names a consent field (`nemar_consent_token`, `nemar_request` or `nemar_decision`, in any number) unless its `Origin` equals the site's origin exactly and its `Sec-Fetch-Site`, when the browser sent one, is `same-origin`.
The page returns the built-in's 403 (same body) before any API call.
A cross-site POST therefore reads as an authorization request only, which the page forwards to the API's check route exactly as it would the same string in a GET; a consent decision can only come from this site's own screen.
The API cannot do this itself: the page pins its own `Origin` on the API calls (nemar-cli ADR 0119), so the API never sees the browser's.

## Consequences

- The conformance module can pass; no other route is any easier to forge.
- Turning `checkOrigin` back on breaks that module; deleting the middleware check while it is off opens every form endpoint. `test/origin-check-middleware.test.ts` pins both halves, and sweeps every file under `src/pages`, so a new form endpoint is covered the day it is added.
- A POST from another site is not signed in: the session cookie is `SameSite=Lax`, which a cross-site POST does not carry. The API answers `login`, the page redirects (303) to sign-in with `next` set to a GET of the same request, and the return trip is a GET. A POST from a sibling `nemar.org` subdomain is same-site and does carry the cookie; it is still only an authorization request, which a top-level GET from the same page would be as well, and its consent is refused (its Origin is not the site's).
- A path spelling that Astro routes to the page but the exemption does not match (`/oauth/authorize/`, `/oauth/%61uthorize`) gets the built-in's 403 when cross-site: fail closed. A client must use the exact registered endpoint path, which is what discovery publishes.
- The check runs before the host redirects, as the built-in did, so a cross-site form POST to `nemar.org` is refused before the 307 to the app host; the exempt POST is redirected with its method kept.
- Anything the built-in learns in a later Astro release (a new form content type, say) is not picked up. The copy is held to Astro by the comparison test, which fails when an upgrade changes the built-in's answer.
- No cookie, CORS, route or header changed.

## Alternatives considered

- **Leave `checkOrigin` on and have the conformance run skip the module:** the endpoint would still violate Core 3.1.2.1 for every real relying party that POSTs; owner decision W1 chose conformance.
- **Exempt `/oauth/authorize` entirely and rely on the API's consent token:** the token is bound to session and request, but the API never sees the browser's Origin, so a forged consent would rest on one control. The exemption is limited to what must be cross-site.
- **Read the body in the middleware to tell the two POSTs apart:** buffers a body before routing and duplicates the page's parser; the page already reads it, bounded, and is the one place that can refuse without a second parse.
- **Origin allow-list for the endpoint:** relying parties are arbitrary sites by design.

## Receipts

- OpenID Connect Core 3.1.2.1 (GET and POST); the conformance module `oidcc-ensure-post-request-succeeds`.
- Astro 6.3.3 `core/app/middlewares.js` (`createOriginCheckMiddleware`).
- nemar-cli ADR 0119 (the authorize rules; the consent token; the API pins the page's Origin); website ADR 0016 (the device-authorize page pins its own Origin).
- `src/lib/origin-check.ts`, `src/lib/oidc-authorize.ts`, `test/origin-check-middleware.test.ts`.
