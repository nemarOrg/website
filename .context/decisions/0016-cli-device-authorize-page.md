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

- `POST /auth/device/{confirm,deny}` and `GET /auth/keys` both run through the backend's `resolveActingAccount`,
  which Origin-allow-lists the **cookie** path only
  (a bearer token carries no ambient credential a forged cross-site request could ride along on; a cookie does).
  A **server-side** GET or POST built by this Worker carries no `Origin` header of its own — unlike a browser's own fetch —
  so if this page or the Settings card do not set one explicitly,
  every one of these calls 403s with `"Origin not allowed"`,
  indistinguishable at first glance from a real refusal.
- `machine_name` on a `device_codes` row is client-supplied text from the CLI's own `POST /device/start` body,
  stored and echoed verbatim by `lookup`/`confirm`
  (see the header comment on nemar-cli's `backend/src/routes/auth-device.ts`).
  The backend does not escape it, because it never renders HTML — that job is this page's.

## Decision

**The page forwards `Astro.url.origin` as the upstream `Origin`, never a hardcoded production host.**
Both the confirm/deny POST and the Settings key list's server-side GET set `Origin: Astro.url.origin`.
Because the backend's allow-list accepts any `*.nemar.org` origin,
this one line works unchanged on `app.nemar.org` (production) and `test.nemar.org` (staging) —
pinning `https://app.nemar.org` instead would silently 403 every staging QA pass
while looking identical to a real refusal in the logs.

**The confirm/deny POST always ends in a `Response`:
a 303 redirect on success, or the refused/unavailable view rendered in place on failure —
never a re-render that could re-submit the form.**
`/cli/authorize?code=...&done=authorized|denied&machine=...` is the only success shape;
the following GET reads `done` off its own query string and renders without a second lookup,
so a refresh of the result page is inert rather than re-authorizing or re-denying.

**`machine_name` is rendered exclusively through Astro's default-escaping `{}` interpolation,
never `set:html` or a client script.**
The page ships no `<script>` tag at all (decision 2 of the phase-2 plan: real form POSTs only),
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
  Simpler, but breaks every staging QA pass silently
  (test.nemar.org's confirm/deny/list calls would all 403)
  and re-introduces exactly the kind of environment-specific literal
  `.context/decisions/README.md`'s ADR discipline exists to catch before it ships twice.
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
