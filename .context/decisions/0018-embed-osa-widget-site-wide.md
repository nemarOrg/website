# ADR 0018: Embed the Open Science Assistant widget site-wide, pinned per environment

**Status:** accepted
**Date:** 2026-09-23
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0017 pre-authorized the Content-Security-Policy the Open Science Assistant (OSA) widget
needs, but the widget itself was never mounted anywhere: no page loaded `osa-chat-widget.js`.
This PR does the mounting.

The widget is one classic script. Once its tag carries `data-no-auto-init`, it waits for a
caller to call `window.OSAChatWidget.setConfig({ communityId, apiEndpoint })` and then
`.init()`; everything else it needs (title, logo, sample questions, its own runtime bundle) it
fetches itself from `GET <apiEndpoint>/nemar` once initialized.

Production and staging need different answers from the same build. Staging (`test.nemar.org`)
should carry the widget now, pinned to an exact OSA commit. Production (`nemar.org`) should
carry nothing until an OSA release is chosen and pinned deliberately: the CSP being
pre-authorized is not the same claim as the integration having been proven end to end.
`PUBLIC_*` variables are Astro build-time values that Vite inlines when `astro build` runs, not
runtime bindings; `wrangler.test.toml`'s own header already documents that a `[vars]` entry in
either wrangler file has no effect on what a build actually inlines. So gating by environment
means gating in `.github/workflows/deploy-test.yml`, the one place that reaches the build with
different values per environment, not in either wrangler file.

## Decision

Add three build-time variables, read by one module (`src/lib/osa-widget.ts`) that
`src/layouts/Base.astro` calls once per render:

- `PUBLIC_OSA_WIDGET_SRC`: must be
  `https://cdn.jsdelivr.net/gh/OpenScience-Collective/osa@<40-hex commit>/frontend/osa-chat-widget.js`.
- `PUBLIC_OSA_WIDGET_INTEGRITY`: must be `sha384-` followed by base64.
- `PUBLIC_OSA_API_ENDPOINT`: must be exactly `https://widget.osc.earth/osa` or
  `https://develop-widget.osc.earth/osa`.

All three are required together. An operator who sets one but not the others has a half-wired
build, not a smaller widget, so that is refused exactly like a single malformed value: see
`resolveOsaWidget` in `src/lib/osa-widget.ts`. When none of the three are set, the module
returns `"disabled"` and `Base.astro` renders nothing, which is the state production is in
today. When all three are set and each one parses, it renders exactly one classic `<script>`
tag carrying `src`, `integrity`, `crossorigin="anonymous"`, `data-no-auto-init`, and an `onload`
handler that calls `setConfig({ communityId: 'nemar', apiEndpoint })` then `.init()`.
`.github/workflows/deploy-test.yml` sets all three for the `staging` push, pinned to an exact OSA
commit (first `55178121ae6fa65ee5a501e53ca74de2a17a58d7`, then `3896c656cacded9de58f703458ef374482d443f3`,
which themes NEMAR's widget; the pin moves whenever staging should test a newer widget, and the
integrity hash moves with it). `wrangler.toml`, `release.yml`, and `ci.yml` set none, so production
stays off until someone deliberately pins a release there.
The integrity value must be `sha384-` followed by exactly 64 base64 characters, the length every
sha384 digest has, so a truncated or padded paste is refused rather than shipped as a tag the
browser would then block.

**The widget is site-wide except on credential pages.** `osaWidgetMarkup` renders nothing on
`/cli/authorize`, `/login` (and below it), `/signup`, `/auth/*` and `/settings`, however fully it is
configured (`OSA_WIDGET_EXCLUDED_PATHS`). Two reasons, either sufficient:
`/cli/authorize?code=` carries a device code and `/login/verify?email=` an email address in the URL,
and the widget's "Share page URL" option sends the current URL to OSA and on to the model provider;
and a third-party script has no business on a page that asks the reader to approve access or holds
their keys. Each entry matches itself and every path below it, never a sibling sharing its first
letters, so `/loginx` or `/authors` would still carry the widget.

`apiEndpoint` is passed explicitly rather than left to the widget's own environment detection.
That detection only recognizes OSA's own demo hosts and `localhost` as non-production, so on
`test.nemar.org` it would silently resolve to the production edge, and staging chat would read
and write against the live community configuration instead of the dev one.

A malformed value, one variable set while another is missing, or a value that fails its
pattern, is refused the same way `docsHandoffTarget` refuses a bad `PUBLIC_DOCS_BASE_URL` in
`src/lib/docs-authorize.ts`: a pure function returns a `"misconfigured"` result carrying a
`reason` string, the caller logs it with `console.warn`, and rendering degrades to nothing.
This build cannot fail the `astro build` step over a bad value. `output: "server"` means this
module's validation runs per request inside the deployed Cloudflare Worker, not while Vite
bundles, so there is no build-time hook to fail from without adding a separate prebuild script
solely for this. Logging clearly and rendering nothing is also what every other bad-`PUBLIC_*`
value in this codebase already does (`apiBase()`, `resolveDocsBase()`, `docsHandoffTarget()` all
degrade rather than throw), so this keeps the widget consistent with its neighbors instead of
becoming the one misconfigured value in the codebase that can take the whole site down.

## Consequences

- `test.nemar.org` carries the assistant now, pinned to OSA commit
  `3896c656cacded9de58f703458ef374482d443f3`, talking to the dev edge worker
  (`develop-widget.osc.earth`). `nemar.org` carries nothing until a production
  `PUBLIC_OSA_*` triple is added to a build step that actually reaches `astro build`.
- Staging's assistant reads PRODUCTION NEMAR data through `mcp.nemar.org` and `zarr.nemar.org`,
  not staging's own `-test` data plane, because OSA has one NEMAR community configuration
  shared by both `apiEndpoint`s. That is an OSA-side property this PR does not change; it is
  recorded here so a staging tester does not mistake it for a bug in this build.
- A chat round trip is not expected from `localhost` or a `*.pages.dev` preview: the OSA edge
  only issues its platform key to the origins it has listed, and `test.nemar.org` is currently
  the only NEMAR-side host on that list. The widget script, its runtime bundle, and the chat
  button still load and render from those origins regardless.
- `img-src` widens, alongside ADR 0017's `script-src`/`connect-src`/`worker-src`, to the two
  stable OSA hosts (`OSA_LOGO_HOSTS` in `src/middleware.ts`). The widget's logo comes from
  `<apiEndpoint>/nemar/logo` on the OSA host, and ADR 0017 did not anticipate an image fetch.
  Only the two stable `osc.earth` names, not the two transitional `*.workers.dev` ones already
  in `connect-src`: this build's own `PUBLIC_OSA_API_ENDPOINT` is refused unless it is one of
  the two stable hosts, so nothing this build ever asks a `*.workers.dev` host for a logo, and
  widening `img-src` to include them would be an allowance with no consumer.
- The widget is mounted from `src/layouts/Base.astro`, so it reaches every page that layout
  serves, including every `AdminLayout` page, which wraps `Base`. The two redirect-only routes
  (`/privacy`, `/terms`) never render a body, so there is nothing for the embed to reach there.
- Turning production on is adding the three `PUBLIC_OSA_*` variables, with a production commit
  pin, to whatever build step reaches production's `astro build`. No code change is needed:
  `osaWidgetMarkup()` already renders from whatever three variables the build receives.
- A local `astro dev` run or a `*.pages.dev` preview renders nothing unless the three variables
  are exported into the shell before `bun run dev` / `bun run build`; there is no default-on
  path for either, and no hardcoded fallback the way `apiBase()` falls back to
  `https://api.nemar.org`. See the module doc in `src/lib/osa-widget.ts` for the exact
  variable names and an example invocation.

## Alternatives considered

- **Fail the build on a malformed value.** Rejected. `output: "server"` means there is no
  build-time hook this module's validation could run from without adding a separate prebuild
  script solely for it, and even with one, a malformed value would then take down every page on
  the affected environment rather than just the chat widget, for a component both this ADR and
  ADR 0017 treat as optional. Logging and degrading matches how every neighboring `PUBLIC_*`
  misconfiguration in this codebase already behaves.
- **Gate the embed in `wrangler.toml`'s `[vars]` instead of the CI workflow.** Rejected because
  `wrangler.test.toml`'s own header already documents why: Pages `[vars]` are a runtime
  binding, and `PUBLIC_*` values are inlined by Vite at `astro build` time, so a `[vars]` entry
  has no effect on what ships. The workflow's `env:` block is the only place that reaches the
  build with a different value per environment.
- **Leave `apiEndpoint` to the widget's own dev/production detection.** Rejected: the widget
  only special-cases OSA's own demo hosts and `localhost`, so `test.nemar.org` would silently
  resolve to the production edge, defeating the entire point of pinning staging to the dev
  worker.

## Receipts

- ADR 0017, the CSP allowances this PR finally has a consumer for.
- `src/lib/osa-widget.ts`, `src/lib/osa-widget.test.ts`.
- `src/layouts/Base.astro` (the call site), `src/middleware.ts` (`OSA_LOGO_HOSTS`,
  `src/middleware.test.ts`).
- `.github/workflows/deploy-test.yml` (the staging pin), `wrangler.toml` and
  `wrangler.test.toml` (the documentation-only mirrors of that pin, per the convention the
  other `PUBLIC_*` vars in those files already use).
- OpenScience-Collective/osa commit `3896c656cacded9de58f703458ef374482d443f3`,
  `frontend/osa-chat-widget.js`'s `data-no-auto-init` / `setConfig` / `init` contract.

## Update — 2026-09-23

OSA is adding a three-icon launcher (OpenScience-Collective/osa#436): chat, a notebook button, and high-performance computing (HPC) ("coming soon").
The notebook button opens a hosted JupyterLite notebook for the dataset on screen, but only when that dataset has a Zarr copy;
otherwise it shows disabled with the reason.
Two additions carry that, both consistent with the decision above rather than changing it.

**A fourth, genuinely optional build variable: `PUBLIC_OSA_NOTEBOOK_URL`.**
Unlike the required triple, this one is not all-or-nothing, but "optional" only covers being UNSET: left unset, the widget falls back to its own default (`https://notebook.osc.earth/osa/`), and that never gates whether the widget renders.
SET but malformed is a different case: it is validated the same way a malformed `PUBLIC_OSA_API_ENDPOINT` is, and a value that fails validation is refused (`resolveOsaWidget` returns `misconfigured`), which blanks the whole widget exactly like any other misconfigured `PUBLIC_OSA_*` value does.
That is a deliberate choice, not an inconsistency: a typo in a value this deployment's own config sets should be loud and caught at once, especially on staging, rather than silently falling back to a host nobody chose and sending testers to the production notebook without anyone noticing.
Staging sets it in `.github/workflows/deploy-test.yml` and `wrangler.test.toml` (reference only, same caveat as the other three) to `https://develop-notebook.osc.earth/osa/`, the dev JupyterLite host, next to the existing staging pin.
The project is in the path because OSC names a plane shared across projects as a subdomain and the project as a path,
as `api.osc.earth/osa` and `widget.osc.earth/osa` already are.
Production's `wrangler.toml` gets a comment only, exactly as the original triple did: unset, the widget's own production default applies once the triple itself is turned on there.

**Dataset context: the page tells the widget which dataset is on screen, and whether it has a Zarr copy.**
The widget has no view into this site's own routing, so it cannot know this on its own.
A new module, `src/lib/osa-dataset.ts`, exports `announceOsaDataset(value)`:
`value` is `null` (not a dataset page) or `{ id, zarr }`,
and the function records the latest value on `window` and forwards it to `window.OSAChatWidget.setDataset` when the widget has already loaded and exposes one (feature-detected: today's pinned widget build does not).
`renderOsaWidgetScript`'s generated `onload` handler closes the other half of the same race:
it reads back whatever `announceOsaDataset` has already recorded and replays it into `setDataset`, feature-detected the same way, before calling `.init()`.
Between the two halves, whichever of the widget's `<script>` and the dataset page's own inline script runs first, the widget ends up with the latest announced value either way.

The dataset page (`src/pages/dataset/[id].astro`) is the only caller, and it is also the only page that ever needs a second call:
it announces `{ id }` (Zarr status unknown) as soon as `hydrateTree` knows the dataset id,
then updates the Zarr field once the Zarr index settles --
`{ id, zarr: state.paths.size > 0 }` beside the existing "View data" reveal when the index resolves,
or `{ id, zarr: false }` when the index fetch returns nothing or throws, so the notebook button never waits forever.
**The page decides Zarr status, not the widget, because the page already fetched the index for "View data" (website#260); asking again would be a second request for information the page already has.**
Every other page announces nothing, which is the widget's own "not a dataset page" default.

No CSP directive changes for either addition.
The notebook opens in a new tab -- a navigation, not a fetch --
and none of `script-src`, `connect-src`, `worker-src` or `img-src` (`src/middleware.ts`) governs a top-level navigation to another origin.

The decision above is unchanged: three variables are still required together and gate whether the widget renders at all;
this only adds a fourth, independently optional one and a way for a page to hand the already-mounted widget page-specific context,
exactly the kind of extension `osaWidgetMarkup`'s existing degrade-not-throw posture was built to absorb.

### Receipts (update)

- OpenScience-Collective/osa#436, the three-icon launcher,
  shipped in osa commit `ab9628fd5d4a83cae21f1d6be6530bbdee14e5db` (OSA PR #468),
  the commit staging's pin moves to with this update.
- `src/lib/osa-dataset.ts`, `src/lib/osa-dataset.test.ts`.
- `src/lib/osa-widget.ts` (`resolveOsaWidget`'s `PUBLIC_OSA_NOTEBOOK_URL` handling,
  `renderOsaWidgetScript`'s `notebookUrl` field and dataset replay), `src/lib/osa-widget.test.ts`.
- `src/pages/dataset/[id].astro` (`hydrateTree`'s three `announceOsaDataset` call sites).
- website#260, #240, #278 (why "View data" -- and now the notebook button -- waits for the
  Zarr index to resolve rather than guessing).

## Update, 2026-09-24

The widget can now draw a dark appearance (OpenScience-Collective/osa#469, osa PR #472).
NEMAR's community config sets `color_scheme: auto`, so on its own the widget follows the reader's device;
this site lets the reader choose a theme, so it passes that choice on.

**The reader's theme choice reaches the widget.**
This site's theme is `<html data-theme>`: `"light"` or `"dark"` when the reader picked one, absent when the site follows the device.
`src/lib/osa-theme.ts` maps it to the widget's `setColorScheme` values, `'light'`, `'dark'` and `'auto'`.
`renderOsaWidgetScript`'s `onload` handler reads the attribute itself and calls `setColorScheme` before `.init()`, so the panel opens in the reader's scheme.
The theme bootstrap in `<head>` sets the attribute before either script runs, so, unlike the dataset context above, nothing needs recording on `window`: the attribute is the record.
`followThemeForOsa`, run from `Base.astro`, forwards every later change (the theme button, Settings > Appearance) through a `MutationObserver` on the attribute, the way the theme button keeps its own label current.
Both halves feature-detect `setColorScheme` and turn an exception from it into a warning, as the dataset replay does.

**Staging's pin moves to osa commit `bb2d865`**, which also keeps the widget's chat input and Settings fields in the light panel's own colors on this site's dark theme; before it, the browser drew them dark inside the light panel.

No CSP change: nothing new is fetched or framed.

### Receipts (update, 2026-09-24)

- OpenScience-Collective/osa#469, osa PR #472, merged as `bb2d865de0dd52c3f58e2db7e864affa43516567`;
  the SRI hash was computed from that commit's file and checked against the bytes jsDelivr serves.
- `src/lib/osa-theme.ts`, `src/lib/osa-theme.test.ts`.
- `src/lib/osa-widget.ts` (the color scheme replay in `renderOsaWidgetScript`), `src/lib/osa-widget.test.ts`.
- `src/layouts/Base.astro` (`followThemeForOsa`).
