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

## Why site-wide, when every other widening here is route-scoped

This is the weakest of the options considered, and it was chosen on product grounds rather
than security ones. The assistant answers general questions and search from anywhere on the
site, and does more on a dataset page where it can read that recording. Scoping it to
`/dataset/*` would have been the tighter policy and would have made it unavailable exactly
where most visitors arrive.

The alternatives, for the record: `/dataset/*` only, which fits the data but hides the
assistant from the landing page and search; and a dedicated `/assistant` route, which is
the tightest blast radius but costs the contextual link to the dataset a person is looking
at and makes them navigate away from the data to ask about it.

What bounds the risk is not the route scope. It is that every added host is an exact
origin rather than a wildcard, that the OSA workers appear in `connect-src` only and never
in `script-src` (a host that can be talked to is a smaller grant than one that can run
code), and that `'unsafe-eval'` is withheld.

## The one thing deliberately left unmeasured

Pyodide is Emscripten-based, and ADR 0009 records that the numcodecs Emscripten+embind glue
needs `'unsafe-eval'` because its invoker functions go through the `Function` constructor,
which `'wasm-unsafe-eval'` does not cover. Whether Pyodide's own glue hits the same wall has
**not** been measured in a browser. Bun and Node do not enforce CSP, which is precisely why
ADR 0009's failure reached production in the first place, so no test in this repository can
answer it.

It is therefore not granted. If the phase 2 spike measures that Pyodide needs it, extending
`'unsafe-eval'` site-wide is a materially larger decision than this one and deserves its own
record: it would take a relaxation this repository currently confines to a single route and
apply it to the landing page and the upload page too. A unit test asserts its absence so
that adding it has a failing assertion attached rather than arriving quietly.

## Consequences

- The widget can load and run on every nemar.org page once it is embedded.
- Zarr reads from the browser runtime already work, because the data plane is `*.nemar.org`.
- The OSA worker hostnames are account-scoped `*.workers.dev` names, because that is what
  the widget actually calls. Pinning those here encodes a Cloudflare account subdomain in
  this repository's production security policy, and the OSA backend is moving to SCCN, so
  this will break: when the worker answers on a different name, every chat request from
  nemar.org fails with a network-indistinguishable error, and the fix is a pull request in
  this repository through staging and promotion rather than a deploy over there.
  OpenScience-Collective/osa#437 tracks routing the worker at a stable product-owned name
  so this list never has to change again. Worth doing **before** the SCCN move, since
  doing it during puts a cross-repository release on the critical path of a migration.
- Browser execution is gated on an origin allowlist on the OSA side and degrades to
  explain-only elsewhere, so this policy makes execution possible on nemar.org rather than
  sufficient for it.

## References

- ADR 0009, the route-scoped `'unsafe-eval'` grant this deliberately does not widen.
- OpenScience-Collective/osa#429, the browser-execution epic; #431, the Pyodide runtime
  phase that owns the CSP spike; #436, the three-icon launcher this embed carries.
- `src/middleware.ts` (`contentSecurityPolicy`), `src/middleware.test.ts`.
