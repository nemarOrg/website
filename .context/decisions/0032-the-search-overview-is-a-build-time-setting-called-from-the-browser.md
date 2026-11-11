# ADR 0032: The search overview is a build-time setting, called from the browser

**Status:** accepted
**Date:** 2026-11-11
**Owner:** Seyed Yahya Shirazi

## Context

Discover and the Home hero get an AI Mode toggle (website#518, #519; boards D2 and D1 of the NEMAR AI plan).
With it on, a panel above Discover's results reads the top ten matches and answers in about a hundred words with links to the datasets, from the Open Science Assistant's (OSA) `POST /nemar/overview` (OSA `docs/search-overview.md`).

Four facts shape where that call is made and how it is switched on.

1. Discover is rendered at request time and cached at the edge for 30 minutes per URL, for every visitor.
   The page cannot know who has AI Mode on, and an overview written into it would be written for, and paid by, nobody in particular.
2. The overview endpoint is on the OSA worker hosts that `connect-src` in `src/middleware.ts` already allows for the widget (`widget.osc.earth`, `develop-widget.osc.earth`).
   A fetch to any other host is blocked in the browser without a message.
   OSA's docs show `edge.osc.earth`, whose worker route is not deployed and which the policy does not list.
3. Production pins an older widget release (`wrangler.toml`), and the worker route answers only after a maintainer has deployed the worker.
   Production already sets `PUBLIC_OSA_API_ENDPOINT`, so deriving the overview URL from it would turn the feature on in production the day this merges.
4. A `PUBLIC_*` value is inlined by Vite when the site is built (ADR 0018), so a build knows its setting and a running page cannot change it.

## Decision

**One build-time setting, `PUBLIC_OSA_OVERVIEW_URL`, read in `src/lib/osa-overview.ts`, and the call is made by the visitor's browser.**

- The value must be exactly `https://develop-widget.osc.earth/osa/nemar/overview` or `https://widget.osc.earth/osa/nemar/overview`.
  Unset or blank means the feature is off: no toggle in either field, no panel, no data island.
  Anything else is refused with a reason and a `console.warn`, and also means off.
  `edge.osc.earth` stays refused until a release adds it to the policy.
- `deploy-test.yml` sets it to the develop URL (staging only); `wrangler.test.toml` mirrors it for reference.
  `wrangler.toml` does not mention it, so production has no toggle until a release adds the production URL there.
  A test pins both.
- Discover embeds the request (query, filters, count, up to ten rows with the dataset's own description or the search snippet) as a JSON data island, only when a search ran, nothing failed, the page is the first and cards exist.
  The browser reads it and posts it when AI Mode is on.
  The server never calls the overview.
- The toggle appears only once the widget is on the page with an `open` method and the setting is set (`aiModeSearchAvailable`), so a build or a browser that cannot follow up never offers the mode.
- The reader's choice is remembered in `localStorage` (`nemar:ai-mode-search:v1`) and carried as `ai=1`, which `ai=1` in the address overrides.
  `ai` is a `FilterState` field that survives paging and filter links, like `exact`, and never changes what is searched.

## Consequences

- Turning the feature on in production is a one-line change in `wrangler.toml` in a release, and needs the production worker to serve the route first.
  Turning it off anywhere is removing the line.
- The page code has no key, no token and no cost: the overview is paid under OSA's per-address limits (hourly, and the per-minute limit shared with chat) and cached by OSA for 24 hours per normalized query, filters and results.
  A visitor behind a shared address shares those limits; a 429 is shown with its own wording.
- A different host, or edge.osc.earth, needs a code change (the list in `osa-overview.ts`) and a policy change (`middleware.ts`) together; this was the intent, since either alone fails silently in a browser.
- `ai=1` URLs will be shared and bookmarked, and the `localStorage` key is read by every future visit, so the parameter name and the key are hard to take back; a change of meaning bumps the key's version.
- The panel's wording is the site's, not the model's: text segments are set as plain text and ids link to `/dataset/<id>`, and an answer that names an id outside the request is shown as an error.
- With AI Mode on, the visitor's search words and the titles and descriptions of the top results leave the site for the Open Science Assistant service and, through it, an AI model provider.
  A visible line under each search field says so while AI Mode is on (a `title` tooltip alone does not reach touch, keyboard focus or most screen readers; the toggle keeps the `title` as a bonus).
  The privacy policy is the docs site's page (`/privacy` redirects there), so its wording must name this before the production line is added to `wrangler.toml` (nemarOrg/website#523).
- Because the call is the browser's, a visitor who blocks the worker, or whose network refuses it, sees the panel's error state with Try again; the results below are unaffected.

## Alternatives considered

- **Call the overview from the server while rendering Discover.**
  Rejected: the page is cached per URL for all visitors, so the call would run for crawlers and every first visitor, would have to carry the site's own credentials or address as the rate-limit identity, and would hold the render for seconds on the model.
- **Derive the URL from `PUBLIC_OSA_API_ENDPOINT`.**
  Rejected: production sets that value for the widget, so the toggle would appear there before its worker route exists (fact 3).
- **A runtime setting, such as a feature flag read per request.**
  Rejected: the flag code in `src/lib/flags.ts` is itself build-time, and the page is cached, so a per-request flag would be wrong for up to 30 minutes.
- **Accept any `https:` URL.**
  Rejected: a host the policy does not list fails with no message in the browser, which is the worst way to learn of a typo.

## Receipts

- nemarOrg/website#518 and #519, parent OpenScience-Collective/osa#652 (plan item E6.4 and E6.5).
- OSA `docs/search-overview.md` (request limits, response, errors, caching, rate limits) and `docs/community-widget.md` (the host API the follow-up uses, `ask(text, {mode: "center"})`).
- ADR 0017 (the CSP allowances for the OSA hosts), ADR 0018 (the build-time `PUBLIC_OSA_*` values).
