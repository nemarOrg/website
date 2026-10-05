# ADR 0023: An embeddable viewer route, the only route other sites may frame

**Status:** accepted
**Date:** 2026-10-05
**Owner:** Seyed Yahya Shirazi

## Context

Partner platforms (EBRAINS, Neurobagel, OpenNeuro and others) want NEMAR's signal viewer inside their own pages, with attribution on the plot and a way back to the dataset (website#410, following the deep links of #326).
No other site can frame any NEMAR page today: every server-rendered response carries `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` from `src/middleware.ts`.
The dataset page is the obvious thing to frame, but it carries the whole site (nav, sign-in, notices, the Open Science Assistant widget), and on `app.nemar.org` it renders for signed-in users (website#210).

## Decision

The viewer gets its own chrome-free route, `/dataset/<id>/embed`, and that route is the only one another site may frame.
It is served with `frame-ancestors *` and no `X-Frame-Options`; every other route keeps `frame-ancestors 'self'` and `SAMEORIGIN`.
The embed and the dataset page's viewer dialog drive one shared viewer session (`src/lib/eeg-viewer/viewer-session.ts`), so a viewer feature is written once for both.

What the route is, and is not:

- It never reads the session, and has no forms and no actions.
  That is what makes framing it by anyone safe: there is nothing on it for a hostile frame to click-jack.
- `frame-ancestors *` with no allowlist.
  An allowlist would make every partner, and every partner's `http://localhost` while they develop, a deploy of this repository, in exchange for protecting a page that has nothing to protect.
- No `X-Frame-Options`.
  It cannot say "any site", and a browser that honours it alongside the Content Security Policy would refuse the frame on `SAMEORIGIN` alone.
  `applySecurityHeaders` deletes it on that route, on all three serve paths.
- No nav, footer, site notices, cookie notice, Open Science Assistant widget or Umami tracker (`src/layouts/Embed.astro`).
  The widget is an explicit exception to ADR 0018's site-wide embedding: a chat launcher floating over a partner's figure is not ours to put there.
  Embed loads are to be counted at the edge instead (website#410 phase 2), so nothing runs on a partner's visitors' devices.
- A NEMAR mark on the plot, on this route only, linking to the dataset page (`scopeOverlay` in `viewer.ts`).
- The route matcher reads the raw path, so an encoded spelling of the route is served un-frameable: it fails closed.

## Consequences

A partner embeds a recording with one pasted `<iframe>`, from the dataset dialog's Embed control, and `?view=` means the same recording on both pages because both resolve it with the same session.
Anything added to the embed route has to stay session-free and action-free, because any site can frame it; a unit test walks every page under `src/pages/` and fails if any page but this one becomes frameable, or if this one stops being so.
The viewer CSS moved from `BidsTree.astro`'s global block to `src/styles/eeg-viewer.css`, since a page without a file tree now needs it.
The dataset page's dialog orchestration now lives in a module with hooks rather than in the page script, which is one more seam to read when changing it.
Annotations made in an embed are stored by the browser per embedding site (storage is partitioned in a third-party frame), which is the intended behaviour, not a bug.
Embedders that send `Cross-Origin-Embedder-Policy: require-corp` cannot frame the route; supporting them would need the embed to send its own `Cross-Origin-Embedder-Policy` and `Cross-Origin-Resource-Policy` headers.
There is no resize protocol: the viewer fills whatever height the iframe has, and 560 px is the recommended height.

## Alternatives considered

- **Frame the dataset page itself.** No new route, but it would put the whole site inside partner pages, and relax framing on a page that renders a signed-in user's nav on the app host.
- **An allowlist of embedding origins.** Narrower in principle, but it protects nothing on a route with no session or actions, and turns every new partner into a deploy.
- **`frame-ancestors https:`.** Keeps plain-HTTP parents out, which costs partners their local development (`http://localhost`) and buys nothing on this route.
- **A separate embed controller instead of a shared session.** The first plan; rejected so that the dialog and the embed cannot drift, at the price of refactoring the dialog (characterized in a browser before and after).
- **A `postMessage` auto-resize protocol.** Deferred: a fixed height is the contract for now, and a protocol is a second API to keep stable.

## Receipts

- nemarOrg/website#410 (the plan of record) and #411 (phase 1).
- nemarOrg/website#326, which made the viewer linkable and kept embedding out of scope.
- ADR 0009: the `'unsafe-eval'` the zarr codecs need is scoped to `/dataset/*`, which already covers this route.
- ADR 0012: a viewer opened by the embed is detached from birth, like one opened by "View data".
- ADR 0018 and ADR 0019: the assistant widget and Umami analytics, both deliberately absent here.
