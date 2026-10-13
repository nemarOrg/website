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
   Previews and any project not wired yet call the public network and are counted by the shared address, exactly as before.
   `astro dev` does too, even when `wrangler.toml` declares the binding: the platform proxy gives dev a stub that answers 503 unless the API Worker runs beside it, so the middleware leaves the binding alone under `import.meta.env.DEV`.
   A built site under `wrangler pages dev` has the stub too, and needs `--service API=<worker>` or a config without the binding.
   The fallback is the normal path and the normal limiter, not a degraded mode, and there is no shared secret.
3. **Only the API's own origin takes the binding.**
   Any other URL is a plain `fetch` with the caller's own headers, so the visitor's address goes to no other host.
4. **Redirects are followed here for a GET or HEAD.**
   A binding sends a redirect target back to the bound Worker whatever its origin, which is wrong for a target on another host, so the call asks the binding for the redirect itself and follows it as `fetch` would: through the binding for the API's origin, on the public network (without `Authorization` or `Cookie`, and without the visitor) for another.
   `redirect: "manual"` is honored and returns the 3xx, as the ORCID proxy needs.
   A request that is not a GET or HEAD is not followed at all: its 3xx is the answer, because a body cannot be replayed and a binding left to follow it would send the target to the API Worker.
   (Measured under workerd on 2026-10-12: with the default redirect mode, a binding fetched a cross-origin redirect target from the bound Worker, and turned a POST into a GET there.)
   The `/api/v1` proxy, which copies no `Location` to the browser, turns such a 3xx into a logged 502 (`upstream_redirect`) instead of passing on a bare redirect.
   The responses of a followed redirect report `redirected: false`; no code here reads it.
5. **A failure of the binding is not retried on the public network.**
   It reaches the caller like any failed fetch.
   The same Worker answers the public network, so a retry would most likely fail the same way, later.
6. **The calls are watched for the ways the API's counting can fail without an error.**
   Each is logged from the headers on the answers, without an address, and the watching never changes a response or throws.
   - The first call of each kind in an isolate is classified by its `X-RateLimit-Bucket`: `site-ip` is logged quietly as the expected case; `ip` (counted under the shared address, so the API did not read the visitor), `site-unattributed`, and an answer with no rate-limit headers (the API's limiter did not run; a 5xx is exempt) are warnings.
     A strict route answers `auth-ip` and a data route `data-ip` for a visitor who was read, so those say nothing.
     Each line names the API host the build points at.
   - A visitor with no address the API would read (absent, or malformed by the API's own rules) is logged at most once a minute per isolate, with the reason, the path and a count, because the sign-in routes share one allowance for the whole site when that happens.
   - A failed call over the binding is logged at error level, at most once a minute with a count, so it is not read as the API being down (every caller's own message looks like a network failure of the API).
     An abort or a timeout is not a failure of the binding.
   - The API's counter may not persist for a call that arrives over a binding (Cloudflare's documentation does not say it does), and then nothing is limited and every answer looks healthy.
     For one visitor, calls one to ten seconds apart are compared, and three comparisons in a row in which `X-RateLimit-Remaining` did not fall log one error per isolate.
     Calls closer than a second are not compared, because a page's calls run in parallel and each can read the count before the others write it; calls farther apart than ten seconds may have crossed into a new window.
     The API sends the reset time only on a refusal, so the comparison does not use it.
   - `env.API` declared but not a service binding (a variable or a namespace that took the name) is logged once per isolate and the site stays on the public network.

The server-only call sites use it: the catalog reads (`api.ts`, `api-cache.ts`), the session lookup in the middleware, the sign-in, ORCID, news-media and generic `/api/v1` proxies, the notices feed (`/api/notices`, which every page view in a browser asks for), and the device-authorization, docs-grant and private-grant clients (page frontmatter only).

## Consequences

- A visitor's pages count against that visitor, not the pool, once the project declares the binding.
  Until then nothing changes, which is why this lands before the wiring: wiring first would put every call in the API's shared unattributed bucket, which is worse than today.
- The API's records of a caller's address (sign-in and session audit) become the visitor's, taken from `X-Forwarded-For` (nemar-cli `web-session.ts`), where they were the Worker's.
- Modules that also run in the browser cannot import `apiFetch`, because the request context needs `node:async_hooks`.
  `test/client-bundle-guard.test.ts` follows the imports of every client `<script>` in an `.astro` file and fails if one reaches `api-fetch.ts` or `request-context.ts`.
  They keep `fetch`: the dashboard, account, collaborators, admin, news and users-admin clients (a server caller can pass `apiFetch` as their `fetch` option, as `/api/notices` does), and the data and Zarr hosts' clients.
  Those calls still leave from the shared addresses; the data and Zarr hosts need a decision about zone-level caching in front of them first (website#449).
- **A call site left on `fetch` is invisible at runtime**: it still works and simply stays in the shared pool, and the first-call report is satisfied by any one site that is counted per visitor.
  `test/routes/api-binding-call-sites.test.ts` runs every converted site under a recording binding with a `fetch` that fails the test, so switching one back fails a test.
- **A broken binding fails closed.**
  There is no retry on the public network, so a misconfigured or failing binding fails every catalog read the cache cannot answer, and the session lookup, which treats an error as signed out, drops every signed-in visitor.
  The logs above say so; the stale copies (ADR 0025) keep the catalog pages up for up to three days.
- **The wiring is declared, and checked.**
  `wrangler.toml` binds `API` to `nemar-api` and `wrangler.test.toml` binds it to `nemar-api-dev`.
  Previews go without: `services` is not inherited into an environment, and a branch build runs unreviewed code that must not be able to name a visitor at the production API.
  A production host with no binding logs one warning per isolate (the way `EMBED_ANALYTICS` is checked, ADR 0024), since the site would otherwise work and quietly stay in the shared pool.
  The first-call lines above are read on test.nemar.org and then on nemar.org after each release.
  What to expect differs: the development API bypasses its limiter and sends no rate-limit headers, so on test.nemar.org the line is the warning that an answer carried none.
  That shows the binding applied (the watching runs only for calls over a binding) and says nothing about the visitor's address.
  The keying is confirmed only on nemar.org, by `site-ip` in the first-call line and a falling `X-RateLimit-Remaining` across two calls.
- Any Worker in the account that binds to the API can name any visitor (nemar-cli ADR 0098); the account is the trust boundary, as it is for the private-site binding.
  A binding call also reaches the API without the zone's WAF, rate-limiting rules and bot management, so the API's own counters are the only floor for these calls (nemar-cli ADR 0098).
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

## Update, 2026-10-12: the public news reads

The call-site list above left the public news reads on `fetch`, saying a server caller of the news client "can pass `apiFetch` as their `fetch` option".
Nothing did, so the home page (the most visited landing page) and every other server-rendered news request still left from the shared addresses and drew on the shared allowance, while the first-call report stayed satisfied by the sites that had been converted.
They pass it now: the news column on the home page, `/news`, `/news/<slug>` (the post and its "more news" list), the RSS feed, the sitemap's news list and the social-card redirect (`/news/feed.xml`, `/sitemap.xml`, `/og/news/<slug>.png`).
A request with no usable visitor address still reaches the API, in the unattributed bucket, with one warning a minute; for the feed, the sitemap and the card the visitor is the crawler, whose address is the one `apiFetch` forwards.
`news-api.ts` still defaults to `fetch`, because the news editor runs it in the browser, and its `fetch` option is typed as a URL string and a plain `RequestInit`, so `apiFetch` fits without an adapter.
`test/routes/api-binding-call-sites.test.ts` runs the three routes under the recording binding and reads every caller of `listNews`, `listAllNews` and `getNewsPost` as text, failing on one that does not pass `fetch: apiFetch`.
The authenticated clients (dashboard, account, collaborators, admin including the admin news pages, users-admin) and the data and Zarr hosts' clients are unchanged and still leave from the shared addresses.
The decision stands.
