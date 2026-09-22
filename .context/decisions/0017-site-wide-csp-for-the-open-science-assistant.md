# ADR 0017: Site-wide CSP allowances for the Open Science Assistant widget

**Status:** accepted
**Date:** 2026-09-21
**Owner:** Seyed Yahya Shirazi

## Context

The Open Science Assistant (OpenScience-Collective/osa) is being embedded on nemar.org. It
is not embedded anywhere on this site today; grep for `osc.earth` or `osa-chat-widget`
returns nothing. So this is an allowance for a consumer that is arriving, not one that
exists, which is the opposite of the discipline `CONNECT_SRC_BASE` records for
`raw.githubusercontent.com` ("Do not re-add it without a fetch that needs it"). It is
recorded here rather than left implicit for exactly that reason.

The assistant's next phase runs model-written Python in the reader's own browser, in a
Pyodide interpreter inside a dedicated Web Worker (OpenScience-Collective/osa#431, epic
#429). Measured against the deployed header on 2026-09-21, the current policy blocks that
outright, for three independent reasons:

- `script-src 'self'` refuses the widget script, which is served from jsDelivr,
  version-pinned and SRI-hashed by the embedder.
- There is **no `worker-src`**. It has no default of its own, falling back to `child-src`
  and then `script-src`, so a blob-URL worker is refused. Nothing errors visibly: the
  worker simply never starts.
- `connect-src 'self' https://*.nemar.org` admits the data plane, so Zarr reads already
  work, but refuses the Pyodide distribution and the OSA edge worker the widget talks to.

The one piece already in place is `'wasm-unsafe-eval'`, granted globally since #143.

## Decision

Widen `script-src`, `connect-src` and a new `worker-src` **on every route**, in
`contentSecurityPolicy()`:

- `script-src` gains `https://cdn.jsdelivr.net`, the widget script's host.
- `connect-src` gains `https://cdn.jsdelivr.net` (the Pyodide runtime fetches its packages
  from the same host, for a different reason) and both OSA edge workers.
- `worker-src 'self' blob:` is stated explicitly, because its fallback is silent.

`'unsafe-eval'` is **not** extended site-wide. It stays scoped to `/dataset/*` exactly as
ADR 0009 left it.

## Consequences

- The widget can load and run on every nemar.org page once it is embedded.
- Zarr reads from the browser runtime already work, because the data plane is `*.nemar.org`.
- `connect-src` lists four OSA hosts, and is expected to shrink to two.
  `https://widget.osc.earth` and `https://develop-widget.osc.earth` are the stable,
  product-owned names delivered by OpenScience-Collective/osa#438, closing #437.
  The widget is mounted at the `/osa` path on those hosts so the hostname stays free for
  other widgets later; `connect-src` matches by origin and ignores the path, so the path
  does not appear in the policy.
- The two account-scoped `*.workers.dev` names are kept alongside them **during the
  transition only**. Embedders pin SRI-hashed widget builds that persist indefinitely, and
  those cached builds still call the old hostnames, so removing the entries as soon as the
  new route is live would break chat on pages this repository does not control. Drop them
  once the `osc.earth` route is live in production and cached builds have turned over.
- Pinning an account-scoped `*.workers.dev` name in a production security policy is what
  #437 set out to end: it encodes a Cloudflare account subdomain here, and the OSA backend
  is moving to SCCN. Without the stable names, that migration would break every chat
  request from nemar.org with a network-indistinguishable error, fixable only by a pull
  request in this repository through staging and promotion rather than a deploy over
  there. Landing the stable names **before** the SCCN move keeps a cross-repository
  release off the critical path of that migration.
- Ordering matters, in one direction only. Because both pairs are listed, this policy is
  safe to promote before or after the `osc.earth` route goes live. Had it switched to the
  new names alone, promoting it first would have broken chat until the route existed.
- Browser execution is gated on an origin allowlist on the OSA side and degrades to
  explain-only elsewhere, so this policy makes execution possible on nemar.org rather than
  sufficient for it.
- Whether Pyodide needs `'unsafe-eval'` is still unmeasured, so the runtime may yet fail in
  a browser in a way no test here can predict. See the alternatives below.

## Alternatives considered

**Scope the widening to `/dataset/*`**, matching every other route-scoped grant in this
file. Tighter, and rejected on product grounds rather than security ones: the assistant
answers general questions and search from anywhere on the site, and does more on a dataset
page where it can read that recording. This option would have made it unavailable exactly
where most visitors arrive.

**A dedicated `/assistant` route.** The tightest blast radius of the three, and rejected
because it costs the contextual link to the dataset a person is looking at, making them
navigate away from the data in order to ask about it.

Site-wide is therefore the weakest of the three, and what bounds the risk is not the route
scope. It is that every added host is an exact origin rather than a wildcard, that the OSA
workers appear in `connect-src` only and never in `script-src` (a host that can be talked
to is a smaller grant than one that can run code), and that `'unsafe-eval'` is withheld.

**Granting `'unsafe-eval'` site-wide now, in anticipation.** Rejected as unmeasured.
Pyodide is Emscripten-based, and ADR 0009 records that the numcodecs Emscripten and embind
glue needs `'unsafe-eval'` because its invoker functions go through the `Function`
constructor, which `'wasm-unsafe-eval'` does not cover. Whether Pyodide's own glue hits the
same wall has **not** been measured in a browser. Bun and Node do not enforce CSP, which is
precisely why ADR 0009's failure reached production in the first place, so no test in this
repository can answer it. If the phase 2 spike measures that Pyodide needs it, that is a
materially larger decision than this one and deserves its own record, since it would take a
relaxation currently confined to a single route and apply it to the landing page and the
upload page too. A unit test asserts its absence so that adding it has a failing assertion
attached rather than arriving quietly.

## Receipts

- ADR 0009, the route-scoped `'unsafe-eval'` grant this deliberately does not widen.
- OpenScience-Collective/osa#429, the browser-execution epic; #431, the Pyodide runtime
  phase that owns the CSP spike; #436, the three-icon launcher this embed carries;
  #437 and #438, the stable `widget.osc.earth` name.
- nemarOrg/website#343, which tracks removing the two transitional `*.workers.dev` entries.
- `src/middleware.ts` (`contentSecurityPolicy`), `src/middleware.test.ts`.
