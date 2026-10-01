# Changelog

All notable changes to the NEMAR website are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows
[Semantic Versioning](https://semver.org/).

This file starts at `0.2.15`. For prior releases, see
[GitHub Releases](https://github.com/nemarOrg/website/releases), which
`release.yml` has generated automatically for every tag since `v0.2.0`.

## [Unreleased]

### Added

- **The footer links the observability dashboard.** "Observability" sits under Explore, after Citations, and opens `dashboard.nemar.org/observability/` in a new tab like the other dashboards and the documentation.

### Changed

- **The Open Science Assistant is pinned to OSA 0.8.15** (`v0.8.15`, `db53bcc5`) on production and staging, with a new integrity value (ADR 0018, update 2026-09-25). It brings Python in Safari, SciPy for NEMAR's spectra and ERPs, and Copy and Download for a run's code and figures.
- **Production's Open Science Assistant is pinned to OSA 0.8.16** (`v0.8.16`, `0e966d60`), with a new integrity value (ADR 0018, update 2026-10-01). It adds launcher position, size and offset settings; this site sets none of them, so the widget's defaults still apply. Staging follows OSA's `develop` and is unchanged (#398).

### Fixed

- **Sign in and the account menu show on phones.** At 880 px and below the header hid its whole actions group, so a phone had no Sign in link and a signed-in person could not reach Upload dataset, My datasets, Settings or Admin. The account control now stays in the header row, just left of the hamburger. Its panel hangs from the header and is pinned to the page gutters: anchored to the avatar, which now sits a hamburger's width in from the edge, it would not have fit a 320 px screen. The hamburger panel and the account menu close each other, the controls are 44 px tall, and the Sign in label no longer wraps at 320 px (the logo is 30 px tall below 340 px to make room). The theme toggle stays desktop-only (#397).
- **The three landing columns share one height.** The news, most cited and latest datasets columns under the hero were sized by item count: each list showed a fixed five rows while the news column, with its banner, ran about 650 px, so the columns ended at different heights and the three links at the bottom sat at three different positions. Side by side (720 px and up) they now share one grid row, the two lists fill the height they are given with as many whole rows as fit, and the links are pinned to the bottom so they line up; rows with no room are taken out of the tab order. Stacked on a phone each list still shows five rows.
- **The front page's "Most cited datasets" card ranks from the citation dashboard's own counts.** It read `num_citations` from the catalog, which nemar-cli copies in once a day and which trails a nightly run by most of a day; a dataset that left the dashboard's counts also kept its old count there, so the card still showed BCCWJ-MEG at 335 after the gate left it none. The page now reads `dashboard.nemar.org/citations/api/index.json` for the counts and takes the names from the catalog rows it already downloads for the hero stats (so a dataset that is not public cannot reach the card, and no extra request is made). When the dashboard cannot be read, the same rows rank by the catalog's own counts, and that render gets the short cache window.
- **A dataset card's "Updated" date is now the latest release date.** It read the catalog row's `updated_at`, which any write to the row bumps (an enrichment reindex, a DOI sync), so a catalog-wide sweep made every card read the day of the sweep. It now reads the `latest_version_at` field from api.nemar.org and shows nothing when a row carries none (#384).
- **Signing out lands on the login page.** The sign-out form redirected to `/`, which the middleware sends to `https://nemar.org/` once the session cookie is gone. Chrome's documented behavior is to apply the CSP `form-action 'self'` to every hop of a form redirect chain, so that cross-host hop is refused and the person is signed out but the page does not move (inferred from that behavior, not reproduced in a signed-in browser). It now redirects to `/login`, an app route, so the chain ends on the app host (#385).

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
