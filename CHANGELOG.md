# Changelog

All notable changes to the NEMAR website are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows
[Semantic Versioning](https://semver.org/).

This file starts at `0.2.15`. For prior releases, see
[GitHub Releases](https://github.com/nemarOrg/website/releases), which
`release.yml` has generated automatically for every tag since `v0.2.0`.

Each pull request adds its entry under `[Unreleased]`.
The release pull request from `staging` to `main` moves those entries under the new version heading, because `release.yml` does not edit this file.

## [Unreleased]

### Added

- **An embeddable signal viewer** at `/dataset/<id>/embed`, for partner sites to put in an iframe.
  It takes the dataset page's `?view=` and `?v=`, plus `?theme=light|dark`; it has no nav, footer, notices, assistant widget or analytics, and carries a NEMAR mark on the plot that links back to the dataset.
  It is the only route another site may frame: `frame-ancestors *` and no `X-Frame-Options` there, `'self'` and `SAMEORIGIN` everywhere else (ADR 0023).
  Its privacy icon links to the privacy policy's "Embedded viewer" section (`/privacy#embedded-viewer`).
  Refs #411, part of #410.
- **An Embed control in the signal viewer dialog**, next to Copy link, that copies the `<iframe>` snippet for the recording on screen; when the clipboard refuses, the snippet appears selected in a read-only box (Refs #411).
- **Embed calls are counted at the edge.**
  Each `GET /dataset/<id>/embed` answered with a 200 writes one Analytics Engine data point from the middleware, on every serve path: the dataset, the embedding site's hostname from `Referer`, and the kind of request from `Sec-Fetch-Dest` (`iframe`, `document`, `none` or `other`).
  Nothing runs on a partner's page or the visitor's device, and no IP address, user agent, country, cookie, query string or recording is recorded; `HEAD` requests and prefetches are not counted.
  The binding is `EMBED_ANALYTICS`: `nemar_website_embeds` on production and `nemar_website_embeds_dev` on previews and staging, and with no binding the count is skipped, with one logged warning per isolate on a production host (ADR 0024).
  Refs #412, part of #410.
- **A sign-in handoff page for `private.nemar.org`** at `/auth/private/authorize`.
  The private site sends a visitor there with a `state` it generated; the page checks the visitor is signed in, asks the backend for a one-time code bound to that `state`, and redirects to the private site's callback with the code alone.
  The target host comes from `PRIVATE_SITE_BASE` (`https://private-test.nemar.org` on staging); a deployment other than production refuses with 501 when it is unset.
  Every response carries `no-store`, `no-referrer` and `noindex`, and a drift test pins the paths to nemar-cli's `shared/contract/private-site.ts` (#396).

### Changed

- **A recording whose Zarr copy exists but would not load now says "The viewer could not load this recording."**, on the dataset page and in the embed, instead of claiming the copy "may still be generating", which is now said only of a store that is not there (Refs #411; a retry control is #416).
- **The footer's "Privacy settings" control is now "Your Privacy Choices"**, with the standard toggle icon, and moves from the Project links to the end of the copyright line.
  It is still a button and opens the same analytics preference as before (ADR 0019).
  The icon is a shared component, `PrivacyChoicesIcon.astro`, for the embedded viewer page to reuse (#413, part of #410).
- **The middleware keeps a page-set `Referrer-Policy: no-referrer`** instead of overwriting it with the site-wide policy, whatever spelling of the path reached the page (ADR 0021, #396).
- **The docs handoff's grant call no longer follows redirects** (#396).

## [0.2.27] - 2026-10-01

### Changed

- **Production's Open Science Assistant is pinned to OSA 0.8.16** (`v0.8.16`, `0e966d60`), with a new integrity value (ADR 0018, update 2026-10-01).
  It adds launcher position, size and offset settings; this site sets none of them, and NEMAR's community config in OSA writes out the desktop values at what the launcher already had, so nothing moves.
  The new test, "the production pin in wrangler.toml", fails CI if a repin leaves `wrangler.toml` malformed, where before that degraded silently to no widget.
  Staging follows OSA's `develop` and is unchanged (#398).

### Fixed

- **Sign in and the account menu show on phones.**
  At 880 px and below the header hid its whole actions group, so a phone had no Sign in link and a signed-in person could not reach Upload dataset, My datasets, Settings or Admin.
  The account control now stays in the header row, just left of the hamburger.
  On a phone (640 px and below) its panel spans the page gutters; from 641 to 880 px it is a 22 rem panel at the right edge.
  The hamburger panel and the account menu close each other, the controls are 44 px tall, and the Sign in label no longer wraps at 320 px.
  The theme toggle stays desktop-only; signed-out phones have no theme control (#401) (#397).
- **The phone header's panels hold up in two edge cases, and answer Escape.**
  A long email address no longer widens the account panel past the left edge of a 320 px screen, which it did from about 30 characters.
  On a short landscape phone the panel scrolls instead of running off the bottom, where "Sign out" was cut off.
  Escape closes either panel and hands focus back to its button (#404).

## [0.2.26] - 2026-09-30

### Added

- **The footer links the observability dashboard.**
  "Observability" sits under Explore, after Citations, and opens `dashboard.nemar.org/observability/` in a new tab like the other dashboards and the documentation (#394).

### Fixed

- **The three landing columns share one height.**
  The news, most cited and latest datasets columns under the hero were sized by item count: each list showed a fixed five rows while the news column, with its banner, ran about 650 px, so the columns ended at different heights and the three links at the bottom sat at three different positions.
  From 1024 px the three columns now share one grid row; from 720 to 1023 px the news column spans the top and the two lists share the row below.
  The lists fill the height they are given with as many whole rows as fit, and the links are pinned to the bottom so they line up; rows with no room are taken out of the tab order.
  Stacked on a phone each list still shows five rows (#394).

## [0.2.25] - 2026-09-30

### Fixed

- **The front page's "Most cited datasets" card ranks from the citation dashboard's own counts.**
  It read `num_citations` from the catalog, which nemar-cli copies in once a day and which trails a nightly run by most of a day; a dataset that left the dashboard's counts also kept its old count there, so the card still showed BCCWJ-MEG at 335 after the gate left it none.
  The page now reads `dashboard.nemar.org/citations/api/index.json` for the counts and takes the names from the catalog rows it already downloads for the hero stats (so a dataset that is not public cannot reach the card, and no extra request is made).
  When the dashboard cannot be read, the same rows rank by the catalog's own counts, and that render gets the short cache window (#390).

## [0.2.24] - 2026-09-30

### Fixed

- **A dataset card's "Updated" date is now the latest release date.**
  It read the catalog row's `updated_at`, which any write to the row bumps (an enrichment reindex, a DOI sync), so a catalog-wide sweep made every card read the day of the sweep.
  It now reads the `latest_version_at` field from api.nemar.org, which the API serves, and shows nothing when a row carries none (#384).
- **Signing out lands on the login page.**
  The sign-out form redirected to `/`, which the middleware sends to `https://nemar.org/` once the session cookie is gone.
  Chrome's documented behavior is to apply the CSP `form-action 'self'` to every hop of a form redirect chain, so that cross-host hop is refused and the person is signed out but the page does not move (inferred from that behavior, not reproduced in a signed-in browser).
  It now redirects to `/login`, an app route, so the chain ends on the app host, and a test pins the target (#385, #388).

## [0.2.23] - 2026-09-29

### Changed

- **The article banner sits beside the header, and the landing columns have more room.**
  From 900 px up, an article with a banner puts the header and the banner in one wide band, text on the left and the picture anchored right, each banner keeping its own shape inside a box up to 30 rem tall instead of a full-width picture.
  On the landing page the gutters between the three columns widen (4 rem, from 2.5 rem), the news column narrows a little (1.15fr, from 1.3fr), the lead banner is shorter (2:1, from 16:10), the column titles, lead title and summary, and briefs drop one type step, and the rows in the cited and latest lists are tighter (#382).

### Fixed

- **News social cards now render.**
  0.2.22 shipped with no news OG cards, so `/og/news/<slug>.png` fell back to the WebP banner, which several link-preview services do not show.
  The generator script declared two constants below the loop that used them, so every card threw before it was drawn.
  The declarations moved above the loop, a failed card now prints a WARNING, and a regression test renders five real 1200x630 cards (#380, #381).

## [0.2.22] - 2026-09-29

### Added

- **A news section.**
  `/news` lists posts and `/news/<slug>` shows one, with a banner, inline figures and an RSS feed at `/news/feed.xml`.
  Images are served same-origin through `/news/media/<file>` (ADR 0020).
  A post's social image is `/og/news/<slug>.png`, which redirects to a build-time card when one exists and otherwise to the post's banner; this release rendered no cards, which 0.2.23 fixes.
  News joins the header navigation, the footer's Explore list, the sitemap and `llms.txt`.
  Admins write posts at `/admin/news`, with a Markdown preview, banner and inline image upload by button, drop or paste, drafts, scheduling and backdating (#372).
- **Three live columns on the landing page.**
  They replace the two feature cards under the hero: the newest news with its banner, the most cited datasets (each linking to its citation dashboard page, with a bar against the top count), and the latest datasets.
  Each column loads alongside the hero stats and fails soft, so a failed or empty one is dropped and the rest widen; a partial render is edge-cached for 60 s instead of 10 min (#372).
- **A stopgap watchdog for pushes GitHub does not deliver.**
  `push-watchdog.yml` runs every ten minutes and, for a `staging` or `main` tip older than ten minutes with no workflow run, starts the runs its push would have and comments on #374.
  Auto Bump Staging can now be dispatched and checks the tip it checked out, so a replay cannot bump twice (#375).

### Changed

- **The cookie notice is shorter.**
  It ran to ten lines of implementation detail; it now says what is collected, that it is never sold, and that Strict only turns analytics off, with a link to the privacy policy.
  Settings' privacy card uses the same wording (#377).
- **Staging follows OSA's `develop` instead of a pinned commit.**
  `test.nemar.org` talks to OSA's dev backend, so a pinned release widget made the two halves of one page different versions.
  Staging drops its integrity hash for it; production stays pinned (ADR 0018, update 2026-09-29) (#378).

### Security

- **Markdown links are filtered by scheme.**
  The renderer behind dataset READMEs and news posts blocked `javascript:` and `data:` by prefix, so a control character inside the scheme, which browsers strip, slipped a script URL through.
  It now allows only `http`, `https` and `mailto` links, plus relative ones, and turns any other scheme into `#`.
  The same pass fixes doubled `&amp;` in query strings, emphasis inside URLs and a link nested in a link (#372).

## [0.2.21] - 2026-09-28

### Changed

- **The admin portal is restyled to match the public observability dashboard.**
  Light and dark follow the system theme.
  Overview leads with a "Needs attention" list (errors before warnings, including a stale snapshot), then headline figures with sparklines and deltas, a Storage card that reads "Not collected yet" until the observability `storage` section exists (nemar-observability#82), and a small usage panel for the last 30 UTC days.
  Users, user detail, imports, notices and publication requests get a visual pass only, with no change to behavior, endpoints, auth or actions.
  In the admin portal, byte figures now use SI units, as the public dashboard does (59.7 TB becomes 65.6 TB) (#366).

## [0.2.20] - 2026-09-28

### Added

- **Anonymous usage analytics.**
  Umami runs on production's public pages and the signed-in upload flow, on by default, with an opt-out in the first-visit notice and in Settings.
  Pageviews carry fixed route categories; citation, viewer and upload actions are a five-event allowlist with no dataset IDs.
  Test and preview hosts, Settings, admin and unlisted routes send nothing.
  The choice is shared between nemar.org and app.nemar.org by a first-party cookie, with per-site browser storage as the fallback, and the footer carries a Privacy settings control (ADR 0019).
  The Content-Security-Policy admits the tracker's host, `analytics.nemar.org`.
  The production website ID is set in `wrangler.toml` and staging builds carry none (#363, #365, #367).

## [0.2.19] - 2026-09-25

### Changed

- **The Open Science Assistant is pinned to OSA 0.8.15** (`v0.8.15`, `db53bcc5`) on production and staging, with a new integrity value (ADR 0018, update 2026-09-25).
  It brings Python in Safari, SciPy for NEMAR's spectra and ERPs, and Copy and Download for a run's code and figures (#361).

## [0.2.18] - 2026-09-24

### Added

- **The Open Science Assistant is on nemar.org.**
  The chat widget is embedded site-wide from `Base.astro`, switched on per environment by build variables, and production pins OSA 0.8.14 with an integrity hash.
  It is left off the pages that carry or grant a credential: `/cli/authorize`, `/login`, `/signup`, `/auth/*` and `/settings`.
  The script is deferred, so a slow or unreachable widget host no longer blocks the parser or the scripts after it (#350, #358, #360).
- **The assistant knows what is on screen.**
  A dataset page tells the widget the dataset, whether it has a Zarr copy, and the subject and task of the first recording in its Zarr index, and the reader's light or dark theme is passed to the widget too (#351, #352, #356).

### Changed

- **The Content-Security-Policy admits the assistant's notebook tab.**
  The policy gains a `frame-src` for the two notebook hosts, and `img-src` gains the two OSA edge hosts for the widget's logo (#350, #353).

### Fixed

- **Sandbox dataset pages read their catalog row.**
  An exemplar's page on test.nemar.org (an `xx` id) showed no Zarr tag although the dataset has a Zarr copy, because only `nm` and `on` ids were looked up.
  The dataset page, its Markdown twin, its Open Graph image and search hydration now read the row for `xx` ids too, and the sitemap keeps sandbox rows out by prefix (#355).

## [0.2.17] - 2026-09-22

### Changed

- **Discover has one viewer filter and a sort toolbar.**
  Features drops "Has Zarr viewer" and "Zarr viewer verified" for a single "Has viewer" flag (`?has_viewer=1`; old `?has_zarr_verified=1` links land on it).
  A green Zarr chip ends the Modality group, behind a divider (`?has_zarr=1`), and filters on its own, outside the modality OR/AND.
  Sort moves from the sidebar to a "Sort by" select beside the result count, which carries the sidebar's current filters when it re-sorts (#347).
- **The participants range sits on one line, and the data-quality pill reads "Coming soon"** instead of naming an internal roadmap phase (#348).

### Fixed

- **Every dataset with a Zarr copy shows the Zarr tag.**
  The tag keyed on the fidelity sweep's verdict, and the sweep skipped datasets with no GitHub repository, so no `on*` mirror ever got one (156 tagged against 635 with a copy).
  It now keys on having a Zarr copy; only a failed fidelity check changes the tag itself, to the amber warning kind, and the sweep's other verdicts moved into the tooltip (#347).

## [0.2.16] - 2026-09-22

### Changed

- **The Content-Security-Policy admits the Open Science Assistant.**
  `script-src` and `connect-src` for jsDelivr, `connect-src` for the assistant's edge hosts, and `worker-src 'self' blob:` for its runtime's worker, ahead of the embed itself (ADR 0017) (#342).

## [0.2.15] - 2026-09-21

### Added

- UCSD Library and EZID logos in the footer's sponsors and partners row,
  using the same colorable-on-hover treatment as the other partner marks
  (#336, #337).

### Changed

- All nine footer partner/maker logo links now open in a new tab
  (`target="_blank"`), so leaving to a partner site no longer navigates the
  visitor away from NEMAR; each link's accessible name now announces
  "(opens in a new tab)" to match (#336, #340).
- Higher-resolution AWS "Powered by AWS" asset (#336).

### Fixed

- The NIH footer logo was actually a mismatched NIH Intramural Research
  Program lockup with dead paths left over from editing, not the NIH
  institutional mark. Replaced with a clean vector of the correct mark
  (colors unchanged — #20558a / #616265 were already correct, verified
  against NIH's own NCBI style guide — only the extraneous wrong-lockup
  paths were removed), and switched to the same monochrome-by-default /
  true-color-on-hover behavior as the other partner logos (#337, #338).
- EZID's wordmark+tagline lockup is wider than the footer's shared logo
  sizing accommodated, so it rendered noticeably smaller than its
  neighbors; given a per-logo width allowance to fix it (#340).
