# ADR 0027: The admin approval page prints the API's review words and computes no verdict

**Status:** accepted
**Date:** 2026-10-14
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0022 made approval a dispatched action: the page asks the backend to start it and reads what the backend reports.
Since then the Application Programming Interface (API) has learned to derive a verdict for each publication request, from an automated review and an identifier screen, and to gate approval on it (nemar-cli ADR 0102, with its Phase 4 amendment, and ADR 0103).
The page still showed a status badge and sent an empty body, so an administrator could not see why a request was held, and the API's gates could only refuse the click after the fact.
The API words most of its reasons for a terminal, with a command inside the cure, so the page cannot print them as they are.

## Decision

The page fetches the API's review detail for a request and prints its words: each reason's `statement` and neutral `cure`, the identifier screen's `headline` and `lines`, and the model's text only under a label that says the model wrote it.
It transcribes only a 22-key table of the sentences the API words for a terminal, kept in `src/lib/publication-review-copy.ts` and checked against the nemar-cli copy by a drift test, the arrangement of ADR 0015.
It never computes a verdict.
It never offers Approve for a reason no override clears, and it sends `request_id` with every approve and deny and, for an override, the review in force and exactly the reasons it showed.
The review start sends no `request_id`: it acts on the active request, and its own refusals cover a request that has moved.
It never prints `line`, `command`, `description.lines`, `description.next`, or the `message` of a refusal that names a terminal step.
The rulings below settle the cases the design left open.

- **A hard reason withholds Approve whatever `gate` says.**
  The API does not gate on an advice-only review, but the page fails closed on a hard reason regardless, so an unknown `cleared_by` word is also a hard reason.
  An administrator who needs to approve such a request uses the terminal.
- **When an override-class reason stands and there is no review row, the words depend on whether a review can be started.**
  If the detail offers a start (`start_offered` is true), the line is the shared `gate.no_review_row` sentence.
  If it does not, the line is a page-owned word in `src/lib/publication-review.ts`, outside the mirrored table: "No review of this commit is on record and none can be started from this page, so Approve is not offered."
  The shared sentence ends by telling the reader to start the review, which is wrong for a request no start can reach.
- **There is no fallback to the old bodyless click.**
  If the detail cannot be read, the page withholds Approve and prints the shared "could not be read just now" sentence (`approve.unavailable`).
  It says it is out of step with the API only when the API is older than the page or the answer cannot be trusted: a missing `statement`, `start_offered` or `screen_gate`, a `request_id` that is not an integer, an unknown `gate` word, or an `anonymous` that is not a boolean.
  A fallback would be a way around the page's own rules.
- **The reason for the identifier screen is always asked for when the screen says `acknowledge`.**
  The API would pass without one when this administrator's own acknowledgment is already on the request, but the page does not read that, so it asks again.
  Sending it again is accepted and recorded again, so the cost is friction and no wrong approval.
- **A stopped approval that never started publishing is offered as a fresh approval.**
  The API gates a stopped run like a fresh one, so the panel asks for the typed word, and for an override or a reason when they are needed.
  Its button reads "Approve and publish" where the row's own button reads "Resume approval"; only a run that has started publishing is continued without the gates, and its panel button reads "Continue approval".
- **A failure is worded by the page, never by the Worker's sentence, where that sentence could name a terminal.**
  A 401 or 403 that carries only a sentence prints the page's own "sign in again" word, because an inactive account's refusal names a terminal command.
  An approve that gets no answer (a missed deadline, a dead connection) says the approval may have started and asks the administrator to refresh and check before trying again, because the dispatch may have gone out; the API's lease makes a retry a harmless refusal.
- **The API deploys first.**
  A page promoted ahead of the API shows "out of step" and offers no Approve, so the release that carries this page waits for the API that carries nemar-cli#1731.

## Consequences

The page prints one authoritative reading of each request, and a cure that changes with the request (the dataset, whether a start can reach it, the detail of a failed question) needs no second copy on the website.
A stale page is caught by the API's guards, which answer with a typed refusal; the page then refetches the detail rather than rendering the refusal's own reasons.
The words with no counterpart in the API, the class tags and the "out of step" sentence among them, stay page-owned and unmirrored.
The 22-key table is held by its own tests, a rule that every key has a consumer on the page, and a drift test against nemar-cli `dev`; the strict path in nemar-cli's continuous integration needs this file on `staging` first.
An administrator cannot approve from the page a request whose only blocker is a hard reason or a missing review that cannot be started; the terminal remains for those.
The page cannot run the identifier screen again or mail the depositor a comment; each is a follow-up issue.

## Alternatives considered

- **Transcribe all 24 reasons and their composition:** a second copy of what changes per request, which the drift tests of ADR 0015 exist to catch.
- **Run the verdict in the browser:** the plan forbids a second implementation of the rules.
- **Extend `ConfirmDialog` with a slot:** it is a shared component, and the page needs the controls (a confirmation and a recorded reason of 10 to 500 characters) before the typed `PUBLISH` dialog, which stays the last step and is unchanged.
- **Keep the bodyless click when the detail fails:** it would let an administrator past the rules the page exists to show.

## Receipts

- nemar-cli#1731 (Phase 4) of epic nemar-cli#1726; website#459.
- nemar-cli ADR 0102 (Phase 4 amendment) and ADR 0103.
- Website ADR 0015 (mirrored copy and drift tests) and ADR 0022 (dispatched approval).
- The captured API response fixtures under `test/fixtures/`, each with a note on how it was captured.
