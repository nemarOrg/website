# ADR 0014: The website renders three account tiers, and every one of them has something to do

**Status:** accepted
**Date:** 2026-09-05
**Owner:** Seyed Yahya Shirazi

## Context

nemar-cli ADR 0040 re-cut what an account's `status` means and ADR 0042 built the half that
was missing: a base-tier account can now *ask* for upload access. `GET /auth/me` reports
`verified` and `approved` alike as `"active"` and `pending` as `"pending"`, with
`service_access` and `email_verified` carried separately.

The website had no vocabulary for any of that. It had one three-valued `status`, and it read
`pending` as "an admin is reviewing you" on `/dashboard`, `/upload`, `/welcome`, `/settings`
and `/login/pending`. That sentence was wrong in the way that matters most: it named a next
step nobody was going to take. An ORCID sign-up lands at `pending` with an emailed code
waiting for it and no admin queued behind it — and once verified, the account still could not
ask for upload access from the browser at all, because the only mention of the tier was a
sentence on `/welcome` saying to ask.

Two smaller gaps came with it. A web/ORCID account has `username = NULL` by design and no
researcher name unless ORCID publishes one, and both are preconditions for an upload request
an admin can review — with no surface to supply either. And `/auth/me` does not select
`username`, so the site cannot see the field it needs to prompt for.

## Decision

**Three tiers, derived in one module, and each one is a state with an action attached.**
`src/lib/account-tier.ts` owns the derivations; no page re-derives a tier inline.

- **unverified** (`status === "pending"`) — `/dashboard` and `/upload` render the verify step
  and nothing else. Not a banner on top of a dataset list: an unverified session cannot pass
  `authMiddleware`, so every call underneath would 403.
- **base** (`"active"`, no grant) — a working account. Browse, dashboard, settings, and the
  request-upload-access flow in Settings.
- **upload** (`service_access === true`) — the dropzone ships.

**The dropzone is gated on `service_access` alone.** This supersedes ADR 0011's `block`
branch; see that ADR's Update for why the profile check moved rather than loosened.

**`/onboarding` is a self-gating page.** It resolves what is outstanding — username, name,
location — and redirects to `next` when nothing is, so sign-in routes through it
unconditionally instead of each caller re-deriving a condition it cannot see. The name step
is skipped, never blocked, when a verified ORCID iD owns the name.

**`username` comes from `GET /users/me`.** `parseAuthMeResponse` reads it opportunistically so
it lands for free when `/auth/me` grows the field; until then `fetchAccountIdentity` asks the
one endpoint that carries it. A failed lookup answers `undefined`, which is not `null`:
"could not ask" must not raise a prompt to choose a handle the account may already have.

**The admin queue is upload-access requests, not a status.** The default chip sends
`?awaiting_approval=1`; approval goes through `POST /admin/approve/by-id/:id` from both the
queue and the detail page, and the `username`-keyed client was deleted rather than left as a
second, weaker option that cannot address a web account.

## Consequences

- The five surfaces that said "under admin review" now say what is true for the tier in
  front of them, and `test/account-tiers-ui.test.ts` fails if any of them says it again — or
  mentions sandbox training, which is CLI-only and which the web upload gate does not check.
- Three pages (`/dashboard`, `/settings`, `/onboarding`) pay one extra SSR call to
  `/users/me` for the username, and only for tiers that can make it. Fail-soft: the
  onboarding prompt disappears rather than the page breaking.
- `/admin/users` fans out one detail fetch per open request, because the listing does not
  carry city, country, affiliation or the request text. Bounded at 25 and fail-soft — a
  detail that does not load costs the extra fields, never the Approve button.
- The awaiting-approval badge counts open requests instead of the whole base tier, so it goes
  from a permanent three-figure number to something an admin can clear. It will read zero on
  the day this deploys: no request predates nemar-cli migration 0076.
- Four fields are read optimistically from `/auth/me` and are **not there yet**: `username`,
  `service_access_granted_at`, `upload_access_requested_at`, and (present) `email_verified`.
  Until the first three land, Settings renders the undated form of "granted", and a request
  made in another session shows as "not requested" on the next page load until the request
  endpoint's own 409/200 corrects it. Filed upstream rather than synthesised here (ADR 0005).

## Alternatives considered

- **A tier banner on top of the existing pages.** Rejected: an unverified account 403s on
  every dataset call, so the page under the banner would be a list of errors.
- **Onboarding as a step inside `/welcome`.** Rejected: `/welcome` is a static orientation
  every new account sees, and a conditional form inside it means every caller has to know
  whether the form will appear. Self-gating moves that knowledge into one page.
- **Deriving the tier from `email_verified` as well as `status`.** Rejected: both roads out
  of `pending` set the flag, so an absent flag means an older backend, not an unproved inbox
  — and asking a verified account to verify is a dead end (the code answers
  `already_verified`).
- **Synthesising `username` from the email local part**, as Settings used to display it.
  Rejected for the reason nemar-cli ADR 0042 gives: a handle nobody chose is worse than a
  blank field with a prompt, and this one would be shown as if it were real.
- **Keeping `uploadGate` with a dead `block` branch.** Rejected: a branch no caller can reach
  is a claim about behaviour that nothing checks.

## Receipts

- website#301 (this work), website#304 (the block-reason vocabulary that follows it).
- nemar-cli ADR 0040 (approval is the single writer of upload access), ADR 0042 (request
  upload access; username and name), ADR 0041 (a DOI cites a person).
- nemar-cli PRs #1258, #1262, #1265 (phases 1-3) — the endpoints and error vocabularies this
  renders.
- Supersedes the `block` branch of ADR 0011; the auto-approve half of ADR 0010 is superseded
  upstream by nemar-cli ADR 0040 (noted in that ADR's Update).
