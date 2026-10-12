# ADR 0025: Catalog reads are cached for a minute and fall back to a stale copy

**Status:** accepted
**Date:** 2026-10-11
**Owner:** Seyed Yahya Shirazi

## Context

Pages that render on the server call api.nemar.org from inside a Cloudflare Worker, so every visitor reaches the API from one small pool of Cloudflare egress IPs.
The API rate-limits anonymous requests per IP (`backend/src/middleware/rateLimit.ts` in nemar-cli, 500 requests per 60 seconds, counted in the per-data-center Cache API), which turns that pool into one shared budget.
When it is spent the API answers `429 Too Many Requests`, and `/discover` showed "Could not load datasets" to everyone, for minutes at a time.
A sample of the production log on 2026-10-11 caught 18 of 43 `/discover` requests in 86 seconds failing this way, and dataset pages degrading the same way.
The API Worker also runs with Smart Placement (`cf-placement: local-LAX` on its responses), which can concentrate its requests, and so its counters, in fewer data centers.
The real fix is on the API side (nemar-cli#1709 asks for the website's server-side traffic to stop sharing the anonymous bucket), and this site cannot make it alone.

## Decision

Public catalog reads in `src/lib/api.ts` (list, search, dataset detail) go through `src/lib/api-cache.ts`.
A response fetched in the last 60 seconds is served from `caches.default` without calling the API.
When the API fails (429, 5xx, timeout, network error) and a stored copy exists, up to 24 hours old, the copy is served and a warning is logged.
A 4xx other than 429 is never answered from a stale copy, so a removed dataset stays removed.
Only successful JSON bodies are stored.
`/discover` answers `503` with `Retry-After` when it has nothing to show, and says the service is busy on a 429.

## Consequences

Repeat visits to the same data stop spending the shared budget: a search page's ten dataset hydrations and a client-filtered browse page's five catalog pages are now mostly cache hits.
A catalog change takes up to a minute to show, on top of the existing page cache.
During an API outage visitors see data that may be hours old instead of an error, and nothing on the page says so; the log line is the only signal.
A stale entry that is never refreshed because the API stays down keeps being served for up to a day.
The cache is per data center, so a cold data center still depends on the API.
`caches.default` does not exist under `astro dev`, so dev never caches; the behavior was checked in a built site under local workerd.

## Alternatives considered

- **Retry on 429:** the API's `Retry-After` is 60 seconds, longer than a render can wait.
- **Raise the API's cap:** a safety floor against runaway loops, and the wrong place to absorb server-side fan-out; tracked as nemar-cli#1709.
- **Cache the rendered `/discover` HTML longer:** crawlers walk unique filter and page URLs, so most requests would still miss.

## Receipts

- website: the commits for this ADR.
- nemar-cli `backend/src/middleware/rateLimit.ts` (the bucket policy and its comment on the shared egress IPs).

## Update 2026-10-12: longer lives, refresh behind the response

The numbers in Decision above (60 seconds fresh, 24 hours kept) are superseded by this section.
The data is public and changes slowly, and robots and people alike should find it, so the site answers from a stored copy far more often than it asks.

A stored body is now in one of four states, by age:

| Age | What happens |
|---|---|
| under 10 minutes | served, no API call |
| 10 minutes to 6 hours | served at once, and refreshed after the response (`waitUntil`), so the next visitor gets the new data |
| 6 hours to 3 days | the API is asked first; on 429, 5xx, timeout, or network error the stored copy is served |
| over 3 days, or never stored | the API is the only source |

Three days is a ceiling, not a target: it is checked in code as well as set as the cache entry's own lifetime.
Where there is no `waitUntil` (`astro dev`, unit tests) the second state does not exist and the entry is refreshed inline.

- **`waitUntil` reaches the cache through `src/lib/request-context.ts`.** The middleware opens an `AsyncLocalStorage` scope around the render; the lib has no Astro context of its own.
- **A failing API is left alone.** When a refresh or an inline call fails, a stale entry is served for the next minute without calling the API again. Without this, every visitor spends a request on an API that is already refusing them, which prolongs the outage the cache exists to hide. The memory is per isolate and bounded to 500 keys, because a crawler can mint unlimited queries.
- **One refresh per key per isolate at a time**, so a burst of visitors starts one call.
- **`/discover` pages are cached at the edge for an hour** (30 minutes for a search), up from two minutes. A new dataset therefore reaches a page within about an hour and ten minutes at most.

Consequences added: the first visitor after a quiet period can see data up to 6 hours old, once; a dataset withdrawn from the catalog can still be listed for the same period; the cache is per data center, so a cold data center is as dependent on the API as before.
Checked in local workerd with the timings shortened: a copy past fresh answered in 6 ms while a 1.5 s API call ran behind it, the next request had the new data, and with the API returning 429 two further requests made no API call.

