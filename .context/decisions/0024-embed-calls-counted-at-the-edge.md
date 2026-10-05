# ADR 0024: Embed calls are counted at the edge, from the request alone

**Status:** accepted
**Date:** 2026-10-05
**Owner:** Seyed Yahya Shirazi

## Context

The embeddable signal viewer (ADR 0023) puts a NEMAR page inside other sites.
We want to know how often it is called, from which sites, and for which datasets, and to report that on the observability dashboard (website#410).
Two things rule out the usual way of counting.
A tracker script inside the embed would run on a partner's visitors, who never chose NEMAR and never saw a NEMAR consent notice; ADR 0019's opt-out is a `SameSite=Lax` cookie scoped to `nemar.org`, which a browser neither sends to nor exposes in a frame on another site, so the embed could not honour it.
A script on the partner's page is not ours to ask for.

## Decision

Count at the Cloudflare edge, from the embed's own HTTP request.
No script runs in a partner's page or in the embed, and nothing is stored on the visitor's device.
For each `GET /dataset/<id>/embed` that `src/middleware.ts` answers with a 200, it writes one Analytics Engine data point, on every serve path (passthrough, cache HIT, cache MISS, no cache storage), from one helper called once per request.

Exactly this, and nothing else:

| Field | Value |
|---|---|
| `index1` | the dataset id from the path, percent-decoded (the `[id]` segment) |
| `blob1` | the same dataset id |
| `blob2` | the embedding site's hostname, from the `Referer` header, lowercased; empty when absent, unparseable, or longer than the 253 characters DNS allows |
| `blob3` | the request kind, from `Sec-Fetch-Dest`: `iframe` (a real embed), `document` (the embed URL opened directly), `none` (no header: scripts, crawlers, link checkers), `other` (any other value) |
| `double1` | 1 |

Analytics Engine adds its own timestamp to each point.

Not recorded: the IP address, user agent, country, cookie, the query string (so not `?view=` or `?theme=`, which means not the recording either), the `Referer`'s scheme, port, userinfo, path or query, and any account or session information.
Not counted: a request that is not a `GET` (so `HEAD`), a prefetch (`Sec-Purpose` containing `prefetch`, or `Purpose: prefetch`), and any response that is not a 200.
The `ds*` to `on*` redirect is a 301 and is not counted; the 200 it leads to is.
The dataset id is the one in the path, percent-decoded, and not re-resolved, so a mirror and its source can never be double counted from one load.

A 200 also covers the embed's own message pages: the one for a dataset with no published version yet, and the one for a `?view=` that matches nothing.
The middleware cannot tell those from a loaded viewer without reading the response body, which it must not do, so they count as calls too.

A change that adds a field to this list needs a new ADR, because the privacy policy states this list (nemarOrg/docs#60).

Where it lives:

- `src/lib/embed-analytics.ts` is pure and unit-tested.
  `embedCallPoint(request, status)` decides whether a response counts (exactly 200, the embed route, the percent-decoded id, no `HEAD`, no prefetch) and returns the point or null; `embedDataPoint` builds it.
- `src/middleware.ts` has `countEmbedCall`, which `onRequest` calls once on the response the rest of the middleware produced.
  It is only the lookup, the write and the catch: it reads the binding from `locals.runtime.env.EMBED_ANALYTICS` and calls the synchronous, fire-and-forget `writeDataPoint`, and never waits on it.
  With no binding it does nothing, silently under `astro dev`, on a preview and on staging.
  On a production host, where a missing binding is a deploy fault, it logs once per isolate that embed calls are not being counted.
  A write that throws is logged once per isolate, with the dataset id, and dropped, and never changes the response.
- `wrangler.toml` binds `EMBED_ANALYTICS` to `nemar_website_embeds` for production and to `nemar_website_embeds_dev` for the preview environment, so a branch deploy never adds rows to production's counts.
  `wrangler.test.toml` binds the staging project to `nemar_website_embeds_dev`.
  Analytics Engine creates a dataset on its first write, so there is nothing to provision.

### Why `referrerpolicy="origin"` is in the snippet

Which site embeds the viewer is the one thing we want from the visitor's browser, and a browser sends it only if the embedder's referrer policy allows.
A partner page with `Referrer-Policy: no-referrer` would otherwise send nothing, and one with `unsafe-url` would send the full path of the page the visitor is reading, which is more than we want to receive.
The snippet's `referrerpolicy="origin"` on the iframe overrides the page's policy for that request: the browser sends the origin only (`https://partner.example/`), never a path or query.
The edge then keeps the hostname alone, so the path is dropped even if a partner's own markup sends one.
A partner who writes their own iframe and omits the attribute is counted with whatever their policy sends, or as an empty host.

### Why Analytics Engine and not Cloudflare's zone analytics

Zone analytics needs no code, and was considered first.
It has no `Sec-Fetch-Dest` dimension, so it cannot tell a partner's iframe from a crawler or a person who opened the URL, which is the distinction the third-party count exists for.
Its adaptive dataset is sampled, and it is limited to one-day query windows, so a per-dataset, per-site history cannot be built from it directly.
Analytics Engine costs one non-blocking call on one route, and keeps every point.
The dataset id is the index, which is Analytics Engine's sampling key, so a busy dataset is the only thing that could ever be sampled; queries should weight by `_sample_interval` (`SUM(_sample_interval * double1)`) so a sampled row is still counted correctly.

### Relation to ADR 0019

ADR 0019's Umami tracker, cookie and opt-out are untouched.
The embed sends nothing to Umami: it has no tracker (ADR 0023), so the existing `viewer_open` and `viewer_interaction` series are first-party by construction, and the edge count is the only measure of third-party use.
The two measure different things, viewer mounts on our pages and embed page loads on partner pages, and the dashboard labels them as such instead of adding them together.

### Visitors cannot opt out of this, and the policy says so

There is nothing to opt out of on the visitor's side: no script runs, no cookie is set, and nothing is written to their device.
The edge handles the request it was already given, and the count keeps only the fields in the table above.
Cloudflare's own infrastructure and Workers logs are outside this record: Cloudflare, like any host, sees the request, and what it logs is governed by its own terms, not by this count.
A hostname can identify a person when the site is a personal one, so the privacy policy states the fields rather than calling the count anonymous.
So the embed carries no consent control.
It carries a small privacy icon whose accessible name is a statement, "Privacy: how NEMAR counts embedded views", linking to the policy, rather than "Your Privacy Choices", because there is no choice to make there.
The privacy policy discloses the count (nemarOrg/docs#60), and that page merges before this one reaches production.

## Consequences

NEMAR can report embed loads per day, per dataset and per embedding site, split into embedded, opened directly and other, from `nemar_website_embeds`, without any code in a partner's page.
Analytics Engine keeps three months of data, so the observability dashboard (phase 4) accumulates daily rows into its own storage to keep a longer history.
The count is of requests that reached the edge, not of people or of views.
A browser may serve the embed from its own HTTP cache for 60 seconds (`Cache-Control: public, max-age=60`), so rapid repeat views by one browser count once; a load after that counts again, and a cache HIT at the edge counts like any other request.
The message pages (no published version yet, a `?view=` that matches nothing) count too, because they are 200s.
A request that sends no `Referer` is counted with an empty host; browsers drop it on some downgrades and under some policies, so the host list undercounts what it can name, and the `iframe` kind is the reliable total.
`Sec-Fetch-Dest` can be set by anything that is not a browser, so the kinds are a classification of what the request says, not proof; the count is for usage reporting, not for anything that depends on it being tamper-proof.
Production deployments write to `nemar_website_embeds`, so it holds only traffic that production serves.
Previews and staging both write to `nemar_website_embeds_dev`, and local runs write nothing, so a query on `_dev` should filter by time or host to pick out the traffic it means.
The hook sits on the whole `onRequest` return value, so a future serve path added to the middleware is counted without anyone remembering to.
A binding that is missing or broken fails quietly for visitors by design, so the check after the release that ships this is by hand: load `https://nemar.org/dataset/<id>/embed` once with `Sec-Fetch-Dest: iframe` and `Referer: https://smoke.invalid/`, then query `nemar_website_embeds` for `blob2 = 'smoke.invalid'` (AGENTS.md, step 9 of the development workflow).
The two warnings above are the other signal, and each is logged once per isolate.

## Alternatives considered

- **Cloudflare zone analytics.** No code, but no `Sec-Fetch-Dest`, sampled, and one-day windows; see above.
- **A tracker script in the embed.** It would run on partners' visitors and could not honour ADR 0019's first-party opt-out inside a third-party frame; ADR 0023 keeps the embed script-free.
- **A script or pixel the partner adds to their own page.** Not ours to require, and it would count nothing for a partner who skips it.
- **A beacon from the embed to a first-party endpoint.** It needs the viewer to run first, so it undercounts loads that fail, and it adds a second request to every embed for a number the first request already carries.
- **Recording the `?view=` value.** It would give per-recording counts, but the value can name a subject and a task, and the product decision (judgment call 7 in #410) is to keep dataset and site only.
- **Recording country or user agent.** Both would help tell a crawler from a person; the `Sec-Fetch-Dest` kind answers that without describing a visitor.
- **An allowlist of embedding sites.** Counts every site that frames the route, the same reason ADR 0023 has no allowlist for framing.

## Receipts

- nemarOrg/website#410 (the plan of record) and #412 (this phase).
- ADR 0023 (the embed route, which has no script) and ADR 0019 (the Umami tracker and its opt-out, unchanged).
- nemarOrg/docs#60: the privacy policy paragraph and the embedding section on the viewer-links page.
- Analytics Engine: `writeDataPoint`, the limits (one index of up to 96 bytes, 16 KB of blobs per point) and the three-month retention are in Cloudflare's Workers Analytics Engine documentation.
