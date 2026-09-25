# ADR 0018: Embed the Open Science Assistant widget site-wide, pinned per environment

**Status:** accepted
**Date:** 2026-09-23
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0017 pre-authorized the Content-Security-Policy (CSP) the Open Science Assistant (OSA) widget
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
It runs on every page, including those without the widget, where it has nothing to tell.
Both halves feature-detect `setColorScheme` and turn an exception from it into a warning, as the dataset replay does.

**Staging's pin moves to osa commit `bb2d865`**, which also keeps the widget's chat input and Settings fields in the light panel's own colors on this site's dark theme; before it, the browser drew them dark inside the light panel.

No CSP change: nothing new is fetched or framed.

### Receipts (update, 2026-09-24)

- OpenScience-Collective/osa#469, osa PR #472, merged as `bb2d865de0dd52c3f58e2db7e864affa43516567`;
  the Subresource Integrity (SRI) hash was computed from that commit's file and checked against the bytes jsDelivr serves.
- `src/lib/osa-theme.ts`, `src/lib/osa-theme.test.ts`.
- `src/lib/osa-widget.ts` (the color scheme replay in `renderOsaWidgetScript`), `src/lib/osa-widget.test.ts`.
- `src/layouts/Base.astro` (`followThemeForOsa`).

## Update, 2026-09-24: the notebook tab

The widget's notebook button now opens the hosted notebook inside the widget, as a tab of its own panel, rather than in a browser tab (OpenScience-Collective/osa#470, osa PR #474).
This supersedes the 2026-09-23 update's "the notebook opens in a new tab" and its "no CSP directive changes": a frame is governed by `frame-src`, so this one does change the policy.
The tab is a frame on the notebook site, `develop-notebook.osc.earth/osa` for staging and `notebook.osc.earth/osa` for production.

**The CSP gains `frame-src 'self' https://notebook.osc.earth https://develop-notebook.osc.earth`**, on every route, as the widget is.
Without it, frames fall back to `default-src 'self'` and the browser refuses the notebook; the widget then shows its "did not open here" fallback, with a link that opens the notebook in a browser tab.
`'self'` keeps the same-origin frames `default-src` already allowed.
The other half, which pages may frame the notebook, is the notebook site's own `frame-ancestors`, which admits nemar.org, www.nemar.org and test.nemar.org (osa ADR 0012).

**`PUBLIC_OSA_NOTEBOOK_URL` must now name one of those two origins**, where before any absolute `https:` URL passed.
The first version of this check had no host allowlist because a notebook in its own browser tab needed nothing from this site's policy; framing it made the host part of the policy.
Both come from one list, `OSA_NOTEBOOK_ORIGINS` in `src/lib/osa-widget.ts`, which `src/middleware.ts` imports, so the accepted URL and the policy cannot disagree.

**Staging's pin moves to osa commit `98ebf1d`**, the notebook tab and the capsule's smaller circles and motion.

**Production is not ready for the tab.** `notebook.osc.earth` does not resolve yet: the notebook site deploys to production from osa's `main`, so it needs the OSA release first.
Production's widget stays off in the meantime (see above), so nothing breaks; a production pin that shows the tab waits for both the OSA release and the production notebook site it deploys.

### Receipts (update, the notebook tab)

- OpenScience-Collective/osa#470, osa PR #474, merged as `98ebf1dd2a7ae75217851c5c65ccbe6e32ccacde`;
  the SRI hash was computed from that commit's file and checked against the bytes jsDelivr serves.
- `src/middleware.ts` (`OSA_FRAME_SRC`), `src/middleware.test.ts`.
- `src/lib/osa-widget.ts` (`OSA_NOTEBOOK_ORIGINS`, `isKnownNotebookUrl`), `src/lib/osa-widget.test.ts`.
- The notebook site's `frame-ancestors`, read from `develop-notebook.osc.earth` on 2026-09-24.

## Update 2026-09-24: the widget's first paint

The widget drew its built-in look for about half a second on every page load (a 56px bubble in OSA's default blue),
then shrank to NEMAR's capsule and faded to NEMAR's colors once the community config arrived
(OpenScience-Collective/osa#475, osa PR #476).
It now remembers the community's widget block in `localStorage`, under `osa-widget-config-nemar`,
and draws it at once on the next load.
What it keeps is the public config endpoint's own widget block (the title, colors, launcher and suggested questions)
and the API endpoint it came from, so a different endpoint never reuses it;
nothing about the reader is stored.
A first visit, with nothing remembered, keeps the launcher hidden until the config arrives, for at most 1.5 seconds.

**Staging's pin moves to osa commit `1a79aa8`.**
Nothing on this site changes: the fix is inside the widget, and `localStorage` is not governed by the CSP.

### Receipts (update, the first paint)

- OpenScience-Collective/osa#475, osa PR #476, merged as `1a79aa83ff9663b2de968e506968b1a15049cedb`;
  the SRI hash was computed from that commit's file and checked against the bytes jsDelivr serves.
- osa's `frontend/browser-harness/first-paint-check.mjs` samples the launcher on every animation frame in Chrome,
  with the config request held 600 ms,
  and finds no frame in the default look on a first visit or a reload (42/42).

## Update 2026-09-24: questions about the dataset on screen

On a dataset page the widget now suggests questions about that dataset, from NEMAR's templates in its OSA config (OpenScience-Collective/osa#477, osa PR #478).
To fill a template's `{subject}` and `{task}`, the dataset page passes them in `setDataset`, beside `id` and `zarr`:
the BIDS labels of the first recording in the dataset's Zarr index, so they always name a recording with a Zarr copy (`osaDatasetFacts` in `src/lib/osa-dataset.ts`).
An invalid label is dropped alone, here and in the widget, so it can never keep the previous dataset on screen.

**Staging's pin moves to osa commit `7092864`.** Nothing else on this site changes: the widget reads no new origin, and the questions are text in its own panel.

### Receipts (update, the dataset questions)

- OpenScience-Collective/osa#477, osa PR #478, merged as `7092864064f3aad203008ee9f1bd9cfc4ee6675a`;
  the SRI hash was computed from that commit's file and checked against the bytes jsDelivr serves.
- `src/lib/osa-dataset.ts` (`osaDatasetFacts`, the label rule), `src/lib/osa-dataset.test.ts`.

## Update 2026-09-24: the pop-out carries the notebook

The widget's pop-out window now has the panel's Chat and Notebook tabs, opens on the tab the reader was on,
and loads the widget by its own address rather than as inline script (OpenScience-Collective/osa#470, osa PR #482).
It is an `about:blank` window of this site's origin, so it runs under this site's own policy,
and it copies the widget tag's `integrity` and `crossorigin`, so the pinned widget loads in it as it does on the page.

**Staging's pin moves to osa commit `a300fd5`.** Nothing else on this site changes: the policy already allows the widget's host and the notebook frame, and the pop-out needs nothing more.

### Receipts (update, the pop-out)

- OpenScience-Collective/osa#470, osa PR #482, merged as `a300fd54ad96f8bad3a14ab0e0029fe4d47978d6`;
  the SRI hash was computed from that commit's file and checked against the bytes jsDelivr serves.
- osa's `frontend/browser-harness/popout-check.mjs` opens the pop-out in Chrome from both tabs under a policy without `'unsafe-inline'`,
  on a plain and an SRI-pinned widget tag (49/49).

## Update 2026-09-25: both pins move to OSA 0.8.15

OSA 0.8.15 is released (OpenScience-Collective/osa PR #512), tagged `v0.8.15` at
`db53bcc52863ea621ba2b821cb7469cf0df90194`. Production (`wrangler.toml` `[vars]`) and staging
(`deploy-test.yml`, mirrored in `wrangler.test.toml`) both pin that commit, with
`sha384-aEykQ1BWj/6vQci5SClhklCm2tmMv4Qaz4TASFttyt852w1sLOg8EDaHmrhJ58nO`. The same value was computed from
GitHub's file at the commit and from jsDelivr's copy, and the two are byte-identical.
The staging pin moves too, since the widget's bytes changed; it had stayed put for 0.8.14
only because they had not.

The release brings Python in Safari (the notebook and the chat), SciPy in NEMAR's chat runtime,
a run's code and figures with Copy and Download, and a larger capsule at rest.
The site's CSP needs no change: the widget still frames `notebook.osc.earth` and talks to
`widget.osc.earth/osa`.

## Update 2026-09-24: production is on

OSA 0.8.14 is released (OpenScience-Collective/osa PR #487),
so `nemar.org` now carries the widget, pinned to that release's commit on osa's `main`.
It points at the production edge, `widget.osc.earth/osa`,
with the notebook tab on `notebook.osc.earth/osa`.
Its backend reads production NEMAR (`mcp.nemar.org`, `zarr.nemar.org`; osa ADR 0013).

**The pin lives in `wrangler.toml` `[vars]`.**
Earlier sections of this record say a `wrangler.toml` entry alone would not reach production's build.
That was reasoned from `test.nemar.org`, which is a direct upload built in GitHub Actions,
and it is wrong for production.
The `nemar-website` project builds `main` through Cloudflare's Git integration,
which puts the file's variables in the environment of `astro build`.
A preview branch that set the three `PUBLIC_OSA_*` variables only in `[env.preview.vars]`
produced a preview whose HTML carried the widget tag with exactly those values.
So production's pin is one file, next to the three base URLs it already sets.
Two earlier claims are superseded:
that a `*.pages.dev` preview can never render the widget,
and that turning production on needs a new build step.
A local `bun run build` still does not read the file:
built with the pin in `[vars]` and nothing exported, its output does not contain the pinned commit.

`[env.preview.vars]` sets no widget variable, and Wrangler does not merge `[vars]` into an environment,
so preview builds of other branches carry no widget.
This record's own branch measured it: its preview, built with the pin in `[vars]`, has no widget tag.
Those previews are not on the widget's CORS allowlist and could not chat anyway.

**The staging pin does not move.**
The widget file and the runtime bundle are byte-identical between osa `a300fd5` and the release commit,
so the two pins carry the same integrity value.

### Receipts (update, production)

- OpenScience-Collective/osa PR #487 (release 0.8.14), merged as `0bb6c20`
  and tagged `v0.8.14` at `5519d4f2f6dd4c1e24c579cd7f402d84b203cd8c`, the commit production pins;
  the SRI hash was computed from that commit's file and checked against the bytes jsDelivr serves, and equals staging's.
- The preview-branch measurement: branch `probe/osa-build-env`, deleted after reading its preview.
- The negative case: `chore/pin-production-widget`'s preview (`971cfe64.nemar-website.pages.dev`) has no widget tag.
- `wrangler pages download config nemar-website`: the project's variables equal the committed `[vars]`.
- `src/lib/osa-widget.ts`'s module comment now says which two builds set the triple.

## Update 2026-09-24: the widget tag is deferred

The widget's `<script>` now carries `defer`.
Without it, the tag was the layout's first network-fetched script that blocks the parser,
so a slow or unreachable jsDelivr or `widget.osc.earth` held up the theme scripts after it and the page's load event.
A deferred classic script still sets `document.currentScript`, which the widget reads to find its runtime bundle,
runs once in document order, and fires the same `onload` handler.
The dataset a page announces reaches the widget either way: the page records it on `window`, and the `onload` handler replays it.

### Receipts (update, defer)

- The release review of nemarOrg/website PR #359.
- `src/lib/osa-widget.test.ts`, "is deferred, not async": removing `defer`, or writing `async` in its place, fails it.
