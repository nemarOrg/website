# ADR 0030: Compute pages are ADR 0010's Phase 3, behind a grant of their own, and decide nothing

**Status:** accepted
**Date:** 2026-11-06
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0010 split access into a base tier and a service tier and left "the compute/service features the grant unlocks" as Phase 3.
nemar-cli's Epic D (#2021) has now built the backend half: a compute-access grant (`users.compute_access`, ADR 0118 there), the person's one request, the administrators' decisions, and a user API.
Epic E (website#493) is the web half, and its first phase (website#494) puts the request and its state in Settings.
Several things had to be settled before any compute page could be written: whether compute access is a tier or a grant, who decides, where the pages live, and how the website learns words and numbers it must not retype.

## Decision

**Compute pages are ADR 0010's Phase 3.** They are a front end over nemar-cli's `/compute` routes and decide nothing: not who may request, not what a state means, not what a balance is.
Every state, date, refusal and sentence is the backend's, and the website renders it.

**Compute access is its own grant, `compute_access`, never derived from `service_access`.**
nemar-cli ADR 0040 keeps `service_access` as the upload grant and makes admin approval its single writer; compute is reviewed separately and spends a finite allocation, so it has a column, a request and a decision of its own.
The session user carries `compute_access`, `compute_access_requested_at` and `compute_access_granted_at` as optional fields that are never defaulted: absent means the backend cannot say, and the Settings card then renders nothing rather than "Not requested".
A state outside the closed six (`none`, `requested`, `active`, `suspended`, `denied`, `revoked`) is dropped at the parser for the same reason.

**Compute pages live on the app host only** (ADR 0006), next to Settings and the dashboard; the marketing host links to docs, not to a compute surface.

**Charts are hand-rolled in SVG** (ADR 0007) when the dashboard phase needs them.
Untrusted text a compute page shows (a purpose, a job name, a log line) renders as inert text, as ADR 0029 requires of the mail tab.

**Copy and gap rules are transcribed, not imported** (ADR 0015).
The 27 non-`cli.` compute keys, the `compute_access` gap block, the block order `verified, upload_access, compute_access, publication` and the `affiliation` row (which blocks compute access alone) are copied from nemar-cli commit 3a869903 and pinned by the existing drift test.
The profile-gap list is no longer one list for every surface: the dashboard nudge and Settings' account list drop gaps that stop compute access and nothing else (`withoutComputeOnlyGaps`), so an account that never asked for compute is not nagged about Affiliation.
The field's tag in Settings reads "needed to request compute access" only on a page where the compute card renders, and a refusal's list is worded for compute through a `block` override on `gapsForFields` (without it, an unproven ORCID iD would read "needed to request upload access" under a compute refusal).

**The refusal list is one function** (`src/lib/refusal-list.ts`), called by both request cards; the upload card's inline loop is gone.

**Two interim decisions, each removed when nemar-cli's phase D2 lands.**

1. The current terms version is transcribed into `src/lib/compute-terms.ts` (`2026-11-draft`).
   The intended route is `current_terms_version` from `GET /compute/me`, served by D2.
   `test/compute-terms-contract-drift.test.ts` compares the constant with nemar-cli's `shared/contract/compute-terms.ts` and is strict in CI (`NEMAR_CLI_COMPUTE_ACCESS_CONTRACT`); CI pairs with nemar-cli `dev`.
   A stale version is not silent: the backend answers `terms_not_accepted` and the card prints it.
2. Requests are open only where they can succeed.
   `COMPUTE_REQUESTS_ENABLED` is `false` in the production build while the terms are a held draft, and `computeRequestsOpen` also opens the form against any backend that is not the production API (`PUBLIC_API_BASE_URL`), because those backends take requests whether or not the terms are published.
   It is deliberately not keyed on the dev-server flag: a bare `bun run dev` shows the production-like inert card.

**Hand-off for the follow-up that replaces both interim decisions.**
nemar-cli phase D2 (PR 2072) serves `GET /compute/me`, whose `access` object carries `state`, `requested_at`, `granted_at`, `terms_version`, `current_terms_version`, `terms_published` and, where it is sent, `requests_open`.
Once it is merged, one change (not this phase, because the route is not on the branch this phase builds against) reads it server-side in the Settings frontmatter, over `dashboardApiBase` with the visitor's cookie, and then:
(a) takes the version printed beside the checkbox and sent as `accept_terms_version` from `access.current_terms_version`, which removes `src/lib/compute-terms.ts`, `data-terms-version`'s constant and `test/compute-terms-contract-drift.test.ts` (and its CI sparse-checkout path and variable), and ends the stale-version failure (a baked version after a backend bump gets `terms_not_accepted` with the box checked);
(b) decides whether the form shows from `access.requests_open` (falling back to `access.terms_published`), which removes `COMPUTE_REQUESTS_ENABLED`, `computeRequestsOpen` and the flag tests; and
(c) decides what to show when the read fails: the card keeps the state from `/auth/me` and shows no form, never a guess.
The captured fixtures in `test/fixtures/compute/` gain a `GET /compute/me` capture at that point.

## Consequences

- A compute sentence is never typed in a page; `test/compute-access-ui.test.ts` fails if one is.
- Until the compute epic merges to nemar-cli `dev`, the website's copy drift test and the new contract drift test are red on any website branch that CI pairs with `dev`; the keys must not reach website `staging` before then, or every nemar-cli pull request goes red.
- The card needs a backend that sends `compute_access`; against an older one it is absent, by design.
- The affiliation gap now exists on the admin review card for upload requests ("blocks compute access"); it does not change what an upload request is refused for.
- A request whose admin mail failed cannot be re-sent from the web (the card shows no form once the state is `requested`); the CLI re-sends it.
- Local verification against the real backend is possible: `scripts/local-backend.mjs`, documented in `.context/local-backend.md`.

## Alternatives considered

- **Treat compute as a third tier derived from `service_access`.** Rejected: it would couple two reviews that nemar-cli deliberately decides apart, and make the website guess a grant the backend states.
- **Default an absent `compute_access` to `none`.** Rejected: an older backend would show "Not requested" and invite a request it will refuse.
- **Import nemar-cli's contract.** Rejected for the reason ADR 0015 gives.
- **Read the terms version server-side in the page frontmatter now.** Not available until D2 serves `GET /compute/me`; the transcription and its drift test are the bridge.
- **Show the backend's sentence for the profile refusals.** Rejected: it lists raw field names (`given_name, affiliation`); the linked, worded list is what the CLI prints.

## Receipts

- website#493 (epic), website#494 (phase E1); nemar-cli#2021 (Epic D), #2071 (phase D1, commit 3a869903).
- ADRs 0006, 0007, 0010, 0014, 0015, 0029; nemar-cli ADRs 0040, 0042, 0118.
