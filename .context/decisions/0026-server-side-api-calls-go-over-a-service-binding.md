# ADR 0026: Server-side calls to the API go over a service binding that names the visitor

**Status:** accepted
**Date:** 2026-10-12
**Owner:** Seyed Yahya Shirazi

## Context

Every server-side call this site makes to `api.nemar.org` leaves a Cloudflare Worker, so every visitor reaches the API from one small pool of egress addresses.
The API limits each address (ADR 0025 has the measurements), so the pool is one client to it, and that is what produced the "Could not load datasets" errors on `/discover` (nemar-cli#1709).
Caching (ADR 0025) cuts the number of calls; it does not change who the API thinks is calling.
The strict sign-in bucket has the same property: ten requests a minute, shared by every visitor (nemar-cli#1354).

nemar-cli ADR 0098 gives the API a way to count the right party: a request with no `CF-Connecting-IP`, which is what a call over a Workers service binding is, is counted by the visitor named in the first entry of `X-Forwarded-For`, in buckets of its own.

## Decision

**Server-only code calls the API through `apiFetch` (`src/lib/api-fetch.ts`).**

1. **With a binding, an API URL goes over it.**
   The Pages project declares `[[services]]` with the binding name `API`, pointing at the API Worker of the matching environment (`wrangler.toml`: `nemar-api`; `wrangler.test.toml`: `nemar-api-dev`).
   The middleware puts the binding and the request's `CF-Connecting-IP` into the request context (`request-context.ts`), and `apiFetch` sets `X-Forwarded-For` to that address.
   It first deletes `X-Forwarded-For`, `X-Real-IP` and `CF-Connecting-IP` from the headers it was given, so nothing a browser sent reaches the API as the visitor.
2. **Without one, it is `fetch`.**
   `astro dev`, previews, and any project not wired yet call the public network and are counted by the shared address, exactly as before.
   The fallback is the normal path and the normal limiter, not a degraded mode, and there is no shared secret.
3. **Only the API's own origin takes the binding.**
   Any other URL is a plain `fetch` with the caller's own headers, so the visitor's address goes to no other host.
4. **Redirects are followed here for a GET or HEAD.**
   A binding sends a redirect target back to the bound Worker whatever its origin, which is wrong for a target on another host, so the call asks the binding for the redirect itself and follows it as `fetch` would: through the binding for the API's origin, on the public network (without `Authorization` or `Cookie`, and without the visitor) for another.
   `redirect: "manual"` is honored and returns the 3xx, as the ORCID proxy needs, and a request with a body is passed to the binding unchanged because it cannot be replayed.
5. **A failure of the binding is not retried on the public network.**
   It reaches the caller like any failed fetch.
   The same Worker answers the public network, so a retry would most likely fail the same way, later.
6. **The first call over the binding in an isolate is logged with the rate-limit bucket the API counted it in.**
   `site-ip` is the expected value; anything else, or none, is a warning, because it means the API did not read the visitor.
   A request that reaches the binding with no usable address is logged once and shares the API's unattributed bucket.

The server-only call sites use it: the catalog reads (`api.ts`, `api-cache.ts`), the session lookup in the middleware, and the sign-in, ORCID, news-media and generic `/api/v1` proxies.

## Consequences

- A visitor's pages count against that visitor, not the pool, once the project declares the binding.
  Until then nothing changes, which is why this lands before the wiring: wiring first would put every call in the API's shared unattributed bucket, which is worse than today.
- The API's records of a caller's address (sign-in and session audit) become the visitor's, taken from `X-Forwarded-For` (nemar-cli `web-session.ts`), where they were the Worker's.
- Modules that also run in the browser cannot import `apiFetch`, because the request context needs `node:async_hooks`.
  They keep `fetch`: the dashboard, account, collaborators, admin, news, users-admin and device-authorization clients, and the data and Zarr hosts' clients.
  Those calls still leave from the shared addresses; the data and Zarr hosts need a decision about zone-level caching in front of them first (website#449).
- Any Worker in the account that binds to the API can name any visitor (nemar-cli ADR 0098); the account is the trust boundary, as it is for the private-site binding.
- Local workerd shows the shape (a binding call carries no `CF-Connecting-IP` and the visitor in `X-Forwarded-For`), but the API's development Worker bypasses the limiter, so the keying itself can be confirmed only on production.

## Alternatives considered

- **A shared secret header on the public network.**
  Rejected for the reason nemar-cli ADR 0078 gives: a secret to rotate in two places, which works from anywhere if it leaks.
- **Turnstile, or any browser challenge.**
  Rejected: it authenticates a person in a browser, and this is a Worker calling a Worker.
- **Patching `globalThis.fetch` for the whole isolate.**
  Rejected: it changes every call, including third-party ones, and hides the decision from the call site.
- **Falling back to the public network when the binding throws.**
  Rejected, as decision 5 says.
