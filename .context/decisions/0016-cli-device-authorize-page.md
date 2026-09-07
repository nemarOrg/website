# ADR 0016: The CLI device-authorize page pins its own Origin and always ends in a redirect

**Status:** accepted
**Date:** 2026-09-07
**Owner:** Seyed Yahya Shirazi

## Context

Epic #1272 (nemarOrg/nemar-cli#1272) gave the backend a device-authorization grant (RFC 8628; nemar-cli ADR 0047):
`nemar auth login` mints a code,
prints a URL plus a short code,
and polls for a key while a person authorizes the code in a browser they are already signed into.
Phase 2 builds that browser half — `/cli/authorize` —
plus a Settings card for the paste-key fallback
(`GET /auth/keys`, `POST /auth/keys`, `DELETE /auth/keys/:id`).

Two backend behaviors are not obvious from the route list alone
and would otherwise be rediscovered by trial and error:

- `POST /auth/device/{confirm,deny}` sit behind `webSessionMiddleware` (cookie-only —
  there is no bearer-token path for a browser confirming or denying a sign-in)
  and call `isAllowedOrigin` directly.
  `GET/POST/DELETE /auth/keys` go through `resolveActingAccount` instead,
  which accepts either the CLI's bearer token or Origin-checks the cookie path the same way.
  Either route means the same thing for this page: a bearer token carries no ambient credential
  a forged cross-site request could ride along on, so only the cookie path is Origin-gated at all.
  A **server-side** GET or POST built by this Worker carries no `Origin` header of its own —
  unlike a browser's own fetch — so if this page or the Settings card do not set one explicitly,
  every one of these calls 403s with `"Origin not allowed"`,
  indistinguishable at first glance from a real refusal.
- `machine_name` on a `device_codes` row is client-supplied text from the CLI's own `POST /device/start` body,
  stored and echoed verbatim by `lookup`/`confirm`
  (see the header comment on nemar-cli's `backend/src/routes/auth-device.ts`).
  The backend does not escape it, because it never renders HTML — that job is this page's.

## Decision

**The page forwards `Astro.url.origin` as the upstream `Origin`, never a hardcoded production host.**
Both the confirm/deny POST and the Settings key list's server-side GET set `Origin: Astro.url.origin`.
This reports the request's real origin rather than a guess,
and it does not depend on the backend's allow-list staying a wildcard:
`isAllowedOrigin` today accepts any `*.nemar.org` host, including `app.nemar.org`,
so a pinned production origin would in fact still pass on staging under the current allow-list —
`forwardAuthMutation` already relies on exactly that fallback elsewhere in this repo.
Forwarding the true origin is correct regardless of how that allow-list is shaped later,
which a pinned value is not.

**The confirm/deny POST always ends in a `Response`:
a 303 redirect on success, or the refused/unavailable view rendered in place on failure —
never a re-render that could re-submit the form.**
`/cli/authorize?code=...&done=authorized|denied&machine=...` is the only success shape;
the following GET reads `done` off its own query string and renders without a second lookup,
so a refresh of the result page is inert rather than re-authorizing or re-denying.

**`machine_name` is rendered exclusively through Astro's default-escaping `{}` interpolation,
never `set:html` or a client script.**
The page ships no `<script>` tag at all — every branch is server-rendered with real form POSTs —
which is what makes "never `set:html`" free to hold —
there is no client-side rendering path for it to leak through.

## Consequences

- Staging (`test.nemar.org`) exercises the real confirm/deny/list calls end-to-end
  without any origin-specific branching in the code,
  because the Origin sent is always the request's own.
- A person who reloads the done page, or bookmarks it,
  sees the same outcome forever with no further backend call —
  the code has already been consumed or denied by the time that page renders.
- `machine_name` — attacker-controlled text from the CLI's own request — can appear on this page
  only as literal text inside the phishing-aware confirm question
  ("Did you just run `nemar auth login` on **&lt;machine&gt;**?"), never as markup.

## Alternatives considered

- **Pin `Origin: https://app.nemar.org` unconditionally.**
  Under today's wildcard allow-list (`isAllowedOrigin` accepts any `*.nemar.org` host)
  this does not actually 403 on staging —
  `forwardAuthMutation` relies on exactly that fallback elsewhere in this repo, and it works.
  Rejected anyway: forwarding the request's own origin reports the truth instead of a guess,
  and stops being correct-by-coincidence the moment the allow-list narrows
  to a per-environment exact match.
- **302 the confirm/deny success instead of 303.**
  302 does not guarantee the browser turns a POST into a GET on the follow-up request
  (some older clients replay the method);
  303 is defined by the HTTP spec to do exactly that, which is what post-redirect-get requires.
- **Escape `machine_name` by hand and use `set:html`.**
  Adds a hand-rolled escaping routine to audit and a `set:html` sink to explain in every future review,
  for a case Astro's own default interpolation already handles correctly and for free.

## Receipts

- nemarOrg/nemar-cli#1272 (epic), nemarOrg/nemar-cli#1282 (this phase's tracking issue), nemarOrg/website#316.
- nemar-cli ADR 0047 (the device-authorization grant);
  `backend/src/routes/auth-device.ts` and `backend/src/routes/auth-keys.ts`'s header comments
  (Origin allow-list scope, the phishing note on `machine_name`);
  `backend/src/middleware/auth.ts`'s `resolveActingAccount`
  and `backend/src/services/web-session.ts`'s `isAllowedOrigin`.
- `src/pages/cli/authorize.astro`, `src/lib/device-auth-api.ts`, `src/lib/device-authorize.ts`,
  `src/pages/settings.astro`'s CLI-keys card.
