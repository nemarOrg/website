# ADR 0009: Route-scoped CSP `'unsafe-eval'` for the zarr signal-viewer codecs

**Status:** accepted
**Date:** 2026-07-07
**Owner:** Seyed Yahya Shirazi

## Context

The security headers added in #143 shipped a strict Content-Security-Policy whose
`script-src` grants `'wasm-unsafe-eval'` (WebAssembly compilation) but not `'unsafe-eval'`
(JS `eval` / `Function()`). This silently broke the interactive EEG/MEG signal viewer:
every zarr chunk read failed in-browser with "Failed to decode chunk via codec 'blosc'".

Root cause is not corruption and not a zstd-support gap. numcodecs 0.3.2's blosc/zstd/lz4
codecs decode the stored bytes correctly (verified in Bun on the exact failing chunk). They
are Emscripten+embind WASM modules whose invoker glue (`La()` → `Function.apply`) calls the
`Function` constructor at decode time, which the browser classifies as eval;
`'wasm-unsafe-eval'` does not cover it, so the browser throws `EvalError: ... 'unsafe-eval'
is not an allowed source`. Bun/Node do not enforce CSP, which is why unit tests and backend
spikes never caught it. The codecs are loaded (via a dynamic `import`) on exactly one route:
the dataset detail page `/dataset/[id]`.

## Decision

Grant `'unsafe-eval'` in `script-src` only on `/dataset/*` requests, via
`routeNeedsUnsafeEval(pathname)` in `src/middleware.ts`. Every other route keeps the strict
#143 policy. The CSP is computed per-request from the URL path
(`contentSecurityPolicy(pathname)`) and threaded through all three serve paths (passthrough,
cache HIT, cache MISS).

## Consequences

- The signal viewer works again on every dataset with a zarr store, with no reconversion and
  no backend change.
- The eval-permitting relaxation is confined to the viewer route; every other page retains
  the strict policy.
- `'unsafe-eval'` is load-bearing until the codecs no longer need it. It must not be removed
  from `/dataset/*` nor broadened to the global policy. A regression test pins both halves.
- Marginal added risk is modest: `script-src` already carries `'unsafe-inline'` (required by
  Astro's inline theme bootstrap), and the strong directives (`default-src 'self'`,
  `object-src 'none'`, `connect-src` allowlist, `frame-ancestors`, `base-uri`, `form-action`)
  are unchanged.

## Alternatives considered

- **Blanket `'unsafe-eval'` in the global CSP:** one line, but relaxes eval site-wide for the
  benefit of a single route. Rejected in favor of route scoping.
- **Reconvert biosigio stores from zstd to lz4/blosclz (backend option):** does not fix it —
  lz4 uses the same Emscripten codec and hits the identical `Function()` block. The
  compressor choice is irrelevant; the eval requirement is a property of the WASM build.
- **Replace numcodecs' Emscripten codecs with pure-JS decoders (e.g. `fzstd` + a blosc
  container parser) and keep the CSP strict:** most secure, could even drop
  `'wasm-unsafe-eval'`, but requires hand-parsing the blosc container/shuffle filter with real
  correctness risk. Deferred; if adopted, the `'unsafe-eval'` grant here can be removed.

## Receipts

- Investigation + reproduction: `.context/research.md` ("Zarr signal viewer needs CSP
  `'unsafe-eval'` on `/dataset/*`", 2026-07-07).
- Implementation: `src/middleware.ts` (`routeNeedsUnsafeEval`, `contentSecurityPolicy`); tests
  in `src/middleware.test.ts`.
- Prior CSP: website #143 (commit 291ee0e). Codec source: numcodecs 0.3.2 `dist/blosc.js`
  (`La()` invoker → `Function.apply`); zarrita 0.7.3 `dist/src/codecs.js` registry.
- Builds on ADR 0006 (edge middleware is where per-route response headers live).
