# ADR 0015: Profile gaps come from one module, and their words from a mirrored copy contract

**Status:** accepted
**Date:** 2026-09-05
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0014 gave the website three tiers and a request flow. What it did not give it was a
shared answer to the question every one of those surfaces asks in its own words: *what is
this account still missing, and what does each missing thing stop it doing?* The dashboard
nudge listed field names and guessed one consequence for the whole set ("City and country
are required before you can upload"), `/upload` said nothing until after a refused request,
Settings rendered the refusal's `missing` array as bare labels, and the CLI printed a fourth
version of the same facts. A user could read three different sentences about one blank
column.

nemar-cli#1268 settles the facts in a matrix — field, what it blocks, where it is set, where
its absence is reported — and phase 8 will publish two things off the back of it: a
`profile_gaps` array on `/auth/me`, computed server-side, and `shared/contract/account-copy.ts`,
the sentences themselves. Neither exists yet, and the website ships against the backend it
has. The two repos also share no package and cannot: one is a Cloudflare Pages site, the
other a Worker plus a published CLI, and an npm dependency between them for two dozen strings
would be a release-coupling trade nobody wants.

## Decision

**One module owns the gap list, and it reads the backend's answer when there is one.**
`src/lib/profile-gaps.ts` holds the matrix as data and exports `profileGaps(account)`, which
uses `profile_gaps` when `/auth/me` carries it and derives the identical list from the
account fields otherwise. The wire decides *which* fields are gaps; the table decides *how*
each is described, because a label, a Settings anchor and a CLI command are website and CLI
nouns the backend has no reason to spell. Wire entries are re-sorted into table order, so the
two paths are indistinguishable in the output — asserted against shared fixtures over all 128
field combinations, in both directions.

**Every tier, upload-access and missing-field sentence lives in `src/lib/account-copy.ts`,
keyed to mirror nemar-cli's contract.** The pages hold keys, not prose. `describeGap`
composes the one sentence all four surfaces print, including the refused-request list, which
is what makes the refusal and the nudge word-for-word identical.

**The mirror is checked, not trusted.** `test/account-copy-drift.test.ts` reads nemar-cli's
`shared/contract/account-copy.ts` as *text* whenever a checkout sits beside this one and
fails on any shared key whose string differs. Reading rather than importing is what keeps the
check free of that repo's module graph; the price is a rule — every copy value is a plain
string literal, no interpolation — enforced by `account-copy.test.ts`, which also pins the
one sentence containing a number to the constant it describes. A missing checkout skips with
a note, because CI clones only this repo.

## Consequences

- A wording change is now a two-repo change by construction, and the drift test says so out
  loud rather than letting the two surfaces diverge quietly for a release.
- The `profile_gaps` switchover is a backend deploy with no website change. The same is true
  of `username_auto_assigned`: absent reads as false, so `/onboarding` behaves exactly as it
  does today until phase 8 ships.
- Copy that embeds a number has to be written out and pinned by a test rather than
  interpolated. That is a real cost, paid once per such sentence, and it buys a drift check
  that cannot silently skip a key.
- The sentence names only a gap's FIRST block. A GitHub handle blocks publication as well as
  the request, and the full list stays on `gap.blocks` for the admin card — but the person
  reading a nudge is deciding what to do next, and naming the walls behind the nearest one
  makes a longer sentence that helps nobody.
- CLI commands render as backticked text on web pages. Marking them up as `<code>` would mean
  splitting the sentence into fragments and re-joining it in each of five templates, which is
  precisely the drift this ADR exists to prevent.

## Alternatives considered

- **Import the contract from nemar-cli.** No shared package exists, and creating one couples
  two release cycles for a string table. The repos already transcribe-and-check elsewhere
  (`publication-block.ts`, `PublicationRequestStatus`); this follows that precedent and adds
  the automated check those lack.
- **Wait for `profile_gaps` before building the UI.** It would leave the parity gap open for
  a whole backend phase, and the derivation is ~20 lines whose rules the refusal endpoint
  already publishes.
- **Import the contract module in the drift test instead of reading it.** It drags zod and
  node-style `./user.js` specifiers into a vitest run for two dozen constants, and fails for
  reasons unrelated to drift.
- **Require identical key SETS across the two files.** The CLI legitimately has copy the web
  has no counterpart for (sandbox training, `auth status` headings). CLI-only keys are
  reported as a note; a website key the contract lacks is a failure, because every website
  key is meant to be mirrored.
- **Keep the sentences in the pages and test the pages.** That is what the repo did before,
  and `test/account-tiers-ui.test.ts` could only ever assert the absence of old copy, never
  the agreement of new copy with another repo.

## Receipts

- nemarOrg/website#309 (this change), nemarOrg/nemar-cli#1268 (the matrix), epic
  nemar-cli#1250 phase 8.
- ADR 0014 (the tiers these gaps hang off), ADR 0010 / 0011 (why city and country are asked
  for at all), nemar-cli ADRs 0040 / 0041 / 0042.
- `backend/src/services/upload-access.ts` in nemar-cli — the refusal vocabulary and the
  order `missing` is built in, which the table's order matches.
