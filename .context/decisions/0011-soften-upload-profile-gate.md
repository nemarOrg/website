# ADR 0011: Soften the upload profile gate for existing service-access users

**Status:** accepted; the `block` branch superseded by ADR 0014 (see the Update below)
**Date:** 2026-08-10
**Owner:** Seyed Yahya Shirazi

## Context

v0.2.4 shipped a hard gate on `/upload`: the form is withheld until the profile has
city + country (#226, PR #231), because those are the export-control screening inputs
for the service-access tier (ADR 0010). Measured against production D1 at release
review (#236): all 10 service-access accounts — the only accounts the backend lets
upload at all, including the HPC users — predate the profile columns (migrations
0051/0052), so 100% of real uploaders were hard-blocked on two empty fields. All 10
were admin-reviewed and granted before the columns existed; the gate was punishing
exactly the population the tier was built to admit.

## Decision

The gate lands in two strengths, decided by `uploadGate` in `src/lib/profile.ts`
(still the single definition of "complete"):

- Users **with** `service_access` and an incomplete profile get the upload form plus
  a prominent, non-blocking amber warning naming the missing fields and linking to
  `/settings` ("warn").
- Users **without** `service_access` (or when the flag is absent from the session —
  fail closed) keep the v0.2.4 hard gate: the form is withheld ("block").

To decide this, the session now carries `service_access` from `/auth/me` (the backend
has exposed it since nemar-cli#1013 Phase 1; `parseAuthMeResponse` accepts it
boolean-only).

## Consequences

- No already-authorized uploader is blocked today; the export-control prompt is still
  unavoidable for every account that has not been through an admin review.
- Access control is unchanged: the backend upload gate
  (nemar-cli `backend/src/services/upload-gate.ts`) still enforces
  `service_access` + `sandbox_completed` on every real upload. This ADR only changes
  which UI renders, never who may upload.
- The "warn" state is intended to be temporary. Once the grandfathered population has
  filled in city/country (trackable in D1), the warn branch can be removed and the
  hard gate becomes universal — a one-line change in `uploadGate`.
- The dashboard nudge (#226) is untouched; `/upload` and `/dashboard` now both prompt,
  at different strengths.
- New dev persona `@nemar.base` (blank profile, no grant) keeps the block branch
  reachable locally; `@nemar.blank` (blank profile, granted) exercises the warn branch.

## Alternatives considered

- **Do nothing and email the 10 users** (#236 option 2): works for today's population
  but leaves the landing hard for anyone granted between backfills, and depends on an
  out-of-band step the code cannot verify happened.
- **Soften for everyone:** drops the export-control prompt below "must answer" for
  new, never-reviewed users — the one case ADR 0010 requires it to be unavoidable.
- **Backfill city/country from affiliation:** admin-invented data in fields the user
  is supposed to attest to; also leaves ambiguous accounts blocked anyway.

## Receipts

- #236 (measurement: 10/10 service-access users blocked), #226 / PR #231 (the gate),
  ADR 0010 (the tier and why city/country matter), nemar-cli#1013 Phase 1
  (`service_access` on `/auth/me`), nemar-cli `backend/src/services/upload-gate.ts`
  (the enforcement that makes "warn" safe).
- Amends the enforcement posture of #226; does not supersede ADR 0010 — the tier,
  the screening inputs, and the admin review are unchanged.

## Update — 2026-09-05

**`warn` survives for exactly the reason it was written. `block` is gone, because the
population it guarded can no longer reach the form at all.**

This ADR gave `/upload` two strengths, decided by `uploadGate`: a grant-holder with an
incomplete profile gets the form plus an amber prompt (`warn`), and everyone else with an
incomplete profile gets the form withheld (`block`). Under the tier model (website#301,
nemar-cli ADR 0040) the second case has nothing left to decide: an account without
`service_access` never sees the upload form, whatever its profile looks like, so withholding
it from the subset with blank city/country answers a question nobody has reached. What that
account sees instead is the request-upload-access CTA.

City and country did not stop mattering — they moved to where they are actually needed. They
are collected at `/onboarding`, and the upload-access request endpoint refuses a request
missing either (nemar-cli `services/upload-access.ts`), which is a *harder* gate than this
ADR's block ever was: it is enforced server-side rather than by which markup the page shipped.

`uploadGate` was therefore deleted rather than left with one dead branch, and
`deriveUploadPageState` in `src/lib/account-tier.ts` owns the decision, still keeping
`canUpload` from `profile.ts` as the single definition of "complete". The measurement that
justified `warn` is untouched: every production service-access account predates migrations
0051/0052, so blocking grant-holders on two empty fields would still block 100% of the people
authorized to upload.
