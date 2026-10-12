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

The numbers in Decision above (60 seconds fresh, 24 hours kept) are superseded by this section, and so is its claim that a 4xx "is never answered from a stale copy": that holds, and this section says how.
The data is public and changes slowly, and robots and people alike should find it, so the site answers from a stored copy far more often than it asks.

A stored body is in one of four states, by age:

| Age | What happens |
|---|---|
| under 10 minutes | served, no API call |
| 10 minutes to 6 hours | served at once, and refreshed after the response (`waitUntil`), so the next visitor gets the new data |
| 6 hours to 3 days | the API is asked first; if it fails with something that says the service is struggling, the stored copy is served |
| over 3 days, or never stored | the API is the only source |

Three days is a ceiling, not a target: it is checked in code as well as set as the cache entry's own lifetime.
Where there is no `waitUntil` (`astro dev`, unit tests) the second state does not exist and the entry is refreshed inline, with one warning per isolate, so a production request context that went missing would not be silent.

**What counts as the service struggling.**
A 429, a 5xx, a 408, a timeout, a network error, and a body that is not what the endpoint returns (not JSON, or JSON of the wrong shape such as `null` or an error envelope).
Anything else the API says (404, 400, 403, 410) means the request is wrong, so it is never masked by a stored copy: the inline path throws it, and a background refresh that receives one drops the copy and logs an error, so a withdrawn dataset is gone after the next refresh instead of lingering for hours.
A body that is not accepted is never stored and never replaces a good copy; each client call supplies the shape check for its endpoint.

**A page built from stale data does not stay at the edge for an hour.**
Whenever a request is answered from a body that was not fresh, the request is marked (`request-context.ts`), and the middleware answers with `x-nemar-data: stale` and `Cache-Control: public, max-age=0, s-maxage=60` in place of a public header (`response-cache-policy.ts`).
The Discover page also keeps a page with any card that failed to hydrate to a minute.
So the worst case a visitor can see is not seven hours: the first visitor after a quiet period gets a copy up to 6 hours old, once, and that page is kept for a minute; steady traffic sees a new dataset within about an hour and ten minutes (the page's hour, plus the data's ten minutes).
The browser's own `stale-while-revalidate` on Discover is ten minutes, because the edge cache treats `s-maxage` as a hard limit and only a browser would use the longer figure.

**A failing API is left alone.**
A 429 comes from the shared per-IP budget, so it predicts the next one for any URL: all calls pause for a minute, and a URL with no stored copy is answered with the same 429 without asking.
Any other failure pauses calls for that URL, with the memory per isolate and bounded to 2000 URLs, because a crawler can mint unlimited queries.
Without this, every visitor spends a request on an API that is already refusing them, which prolongs the outage the cache exists to hide.
A refresh that cannot be written to the cache counts as a failure too.
Concurrent calls for one URL share one request, and one that has been in flight past 30 seconds is presumed lost and replaced.

**Other decisions.**
- `waitUntil` reaches the cache through `src/lib/request-context.ts`: the middleware opens an `AsyncLocalStorage` scope around the render, because the lib has no Astro context of its own. The import is typed by hand, because this site's CI installs no Node types on purpose.
- A page that decides who may do what from a catalog row reads past the cache (`getDataset(id, { fresh: true })`; the collaborators page does).
- `listAllDatasets` reads its pages as separate entries, so they can come from different moments; each reports the catalog's size, and when they disagree the pages are read again past the cache.
- Signed-in HTML pages are sent `private, max-age=0, must-revalidate`, so a browser does not keep a page that names the visitor. Other responses, hashed assets included, are untouched.
- `/discover` pages are cached at the edge for an hour (30 minutes for a search), up from two minutes.
- **There is one purge**: stored bodies are not tied to a deploy, so a release that starts reading a new API field, or a bad body that got stored, is otherwise served until it ages out. `CACHE_GENERATION` in `api-cache.ts` is part of every stored key; bumping it orphans every body at once.

**What this costs and still leaves open.**
A withdrawn dataset can stay listed for up to 6 hours before a refresh drops it, and for a minute at the edge after that.
The cache is per data center, so a cold data center is as dependent on the API as before.
The only operator signal is console output, an error once a copy older than 6 hours is being served and a warning below that; whether those logs are retained is a question for the Cloudflare dashboard, since neither wrangler config enables observability.
Checked in local workerd with the timings shortened: a copy past fresh answered in 6 ms while a 1.5 s API call ran behind it, the next request had the new data, and with the API returning 429 two further requests made no API call.
