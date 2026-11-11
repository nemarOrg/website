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
- An overview needs a search of at least three words (the maintainer's rule of 2026-11-11; a one-word search such as "EEG" made the endpoint fail, OpenScience-Collective/osa#728).
  The browser counts words as OSA does (`countQueryWords` in `osa-overview.ts`: split the trimmed query on whitespace, count tokens with a letter or digit) and sends no request under three; the panel stays hidden, and one very small line under the search field says why (see "On by default, a settled field and a follow-up that sends nothing" below), while the toggle, the preference and `ai` are unchanged.
  OSA answers 422 for a query under three words, and the panel shows nothing for it either; the same line shows, so a server whose count disagrees reads the same to the visitor.
  Every example search the site offers in AI Mode (Home's "Try" row) has three words or more, and a test reads them from the source.
- The toggle appears only once the widget is on the page with an `open` method and the setting is set (`aiModeSearchAvailable`), so a widget that failed to load never offers the mode.
  "Ask a follow-up" needs `seed` on top of that (`aiModeSeedAvailable`), checked each time the panel is drawn: a widget with `open` and no `seed` (develop today) shows the toggle and the overview, and no follow-up button.
- AI Mode is on by default (website#525), and the reader's choice is remembered in `localStorage` (`nemar:ai-mode-search:v1`, `"on"` or `"off"`) and carried in the address, which overrides it.
  An absent, odd or unreadable stored value is on.
  `ai=1` is on and `ai=0` is off; either wins over what is stored and is written back to the store.
  A stored off with no `ai` in the address puts `ai=0` in it, so a copied link is honest: a link without `ai` is on for whoever opens it.
  The page never writes `ai=1`: on is what no parameter means.
  `ai` is a `FilterState` field (default on, serialised only as `ai=0`) that survives paging and filter links, like `exact`, and never changes what is searched.

### On by default, a settled field and a follow-up that sends nothing

Website#525 changed three things after the first test on staging.

1. **Default on, in a page that is cached for everyone.**
   The server cannot know the choice, so it renders the on state (the ring, the pressed toggle, Home's AI placeholder and label) and the browser switches it off for a reader who stored an off or opened `ai=0`.
   A reader who chose off sees the ring leave once the script has run.
   Where the widget did not load, the browser undoes the on state, so the field reads as plain search.
   **A no-script visitor** sees the on state's look and none of its controls: the toggle, the Try row, the disclosure and the line are all revealed by script, so nothing dead is offered.
   A search they submit carries no `ai`, which means on, and the page they land on says so; an address with `ai=0` renders off and its form carries a hidden `ai=0`, so a search submitted without scripts does not silently flip the state.
   The edge cache is keyed on the full URL, so `ai=0` pages are cached apart from the rest.
2. **The field does not move.**
   Hiding and showing the Try row, the disclosure and the new line (`hidden`, so `display: none`) moved the page, and Discover's field was 1 px taller with the ring than without.
   Each of the three is now a slot the server renders whenever the endpoint is set, always laid out and drawn with `visibility`, so it takes the same space whether it shows or not, at any width, with no height to keep in step with the text.
   The cost is that the space stays when AI Mode is off, and that on Discover the disclosure's rows are reserved too.
   Discover's field has a set height (44 px, 41 px for the input inside the 1.5 px ring) instead of one that follows the line height.
   A Playwright check (`e2e/ai-mode-field.spec.ts`, `bun run test:e2e`) measures it in a browser; CI does not run it, because it would have to install a browser and reach the API from the dev server.
3. **The follow-up sends nothing in the reader's name.**
   "Ask a follow-up" calls `OSAChatWidget.seed(text, {mode: "center"})` (OSA #730), which opens the dialog with the text as the assistant's own first reply; the reader writes the next message.
   The button is drawn only where `seed` is a function, checked each time the panel is drawn; there is no fallback to opening the dialog empty or sending the text as a question.
   The text is built by the pure `seedText(query, answer, origin)`: **AI overview** for the quoted search, the summary with each dataset id as an absolute link on the page's own origin (the widget draws http and https links only), and the top picks.
   The widget's Markdown has no backslash escapes, so the search's Markdown characters become spaces and neither the overview's prose, a pick's reason nor the quoted search can make a link, image, emphasis or code of its own, and a web address in them is broken (`https://x` reads `https x`) because the widget links any `http://` or `https://` run without Markdown around it; a model reading dataset descriptions must not be able to hand the page a link.
   The limit is `RESEED_TURN_MAX_CHARS`, 2,000 UTF-16 code units, which `seed` enforces by refusing a longer text (the issue said 4,000, the first brief 8,000); the message is at most that, shortened by dropping the picks' reasons, then the picks, then cutting the summary at a sentence, and if OSA raises its bound nothing here breaks.

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
- Where the widget has no `seed`, there is no follow-up button; production's older pinned widget has none, and the end-to-end check of the dialog (the overview as the reply, nothing sent until the reader writes) needs the OSA change deployed to develop.
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

- OpenScience-Collective/osa#728 (the three-words rule).
- nemarOrg/website#525 and OpenScience-Collective/osa#730 (default on, the line under the field, the settled field, the seeded follow-up).
- nemarOrg/website#518 and #519, parent OpenScience-Collective/osa#652 (plan item E6.4 and E6.5).
- OSA `docs/search-overview.md` (request limits, response, errors, caching, rate limits) and `docs/community-widget.md` (the host API the follow-up uses, `seed(text, {mode: "center"})`).
- ADR 0017 (the CSP allowances for the OSA hosts), ADR 0018 (the build-time `PUBLIC_OSA_*` values).
