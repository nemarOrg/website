# ADR 0027: The admin approval page prints the API's review words and computes no verdict

**Status:** accepted
**Date:** 2026-10-14
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0022 made approval a dispatched action: the page asks the backend to start it and reads what the backend reports.
Since then the Application Programming Interface (API) has learned to derive a verdict for each publication request, from an automated review and an identifier screen, and to gate approval on it (nemar-cli ADR 0102, with its Phase 4 amendment, and ADR 0103).
The page still showed a status badge and sent an empty body, so an administrator could not see why a request was held, and the API's gates could only refuse the click after the fact.
The terminal words a reason with a command inside it (its `line`, and a `cure` that names the command to run), so the page cannot print those as they are.
The API sends each reason a neutral `statement` and `cure` beside them, and the page prints those.

## Decision

The page fetches the API's review detail for a request and prints the API's own words.
Each reason shows its `statement` and its neutral `cure`, the identifier screen shows its `headline` and `lines`, and the model's text appears only under a label that says the model wrote it.
The page does not print the terminal's sentences: the terminal's `cure` carries commands, so the page never prints `line`, `command`, `description.lines`, `description.next`, or the `message` of a refusal that names a terminal step.
It transcribes only a 22-key table of the sentences the API words for a terminal, kept in `src/lib/publication-review-copy.ts` and checked against the nemar-cli copy by a drift test, the arrangement of ADR 0015.
It never computes a verdict.
It never offers Approve for a reason no override clears, and it sends `request_id` with every approve and deny and, for an override, the review in force and exactly the reasons it showed.
The review start sends no `request_id`: it acts on the active request, and its own refusals cover a request that has moved.
The rulings below settle the cases the design left open.

- **A hard reason withholds Approve whatever `gate` says.**
  The API does not gate on an advice-only review, but the page fails closed on a hard reason regardless, so an unknown `cleared_by` word is also a hard reason.
  An administrator who needs to approve such a request uses the terminal.
  A run that has started publishing is exempt: it passed the gates when it started, so its panel offers "Continue approval" whatever reasons now stand.
- **A blocked request, and a screen that says `blocks`, `rerun` or `wait`, withhold Approve.**
  The API refuses every blocked request, even a walked-back run, so the page withholds Approve for one before it looks at anything else.
  The identifier screen's `blocks` (a direct identifier), `rerun` (no verdict) and `wait` (still running) each withhold it with the shared sentence for that gate, added to the hard-reason line when both apply.
  Of the other screen words, `acknowledge` offers Approve with a reason to record, and `clear` and `exempt` offer it with none.
- **When an override-class reason stands and there is no review row, the words depend on whether a review can be started.**
  If the detail offers a start (`start_offered` is true), the line is the shared `gate.no_review_row` sentence.
  If it does not, the line is a page-owned word in `src/lib/publication-review.ts`, outside the mirrored table: "No review of this commit is on record and none can be started from this page, so Approve is not offered."
  The shared sentence ends by telling the reader to start the review, which is wrong for a request no start can reach.
- **There is no fallback to the old bodyless click.**
  If the detail cannot be read, the page withholds Approve and prints the shared "could not be read just now" sentence (`approve.unavailable`).
  It says it is out of step with the API only when the API is older than the page or the answer cannot be trusted, and then it withholds the whole panel and prints no reason at all.
  The answer cannot be trusted when any of these holds:
  `request_id` is not an integer;
  `request_status` is not a string;
  `gate` is not one of `enforced`, `off` or `n/a`;
  `screen_gate` is not one of `clear`, `blocks`, `acknowledge`, `rerun`, `wait` or `exempt`;
  `anonymous`, `applies`, `started_publishing` or `start_offered` is not a boolean;
  `reasons` is not a list in which every reason has string `code`, `class`, `cleared_by`, `sentence` and `cure` and a non-empty string `statement`;
  `description` or `identifier_screen` lacks a string `headline` or `tone`, or the screen's `lines` is not a list of strings;
  or `review` is neither null nor a record with an integer `id`, a list of fact notes and a list of findings.
  An old API that sends no `statement`, or an empty one (the page prints `statement`, never `sentence`), therefore gets the out-of-step sentence and never has a terminal `line` printed in its place.
  A fallback would be a way around the page's own rules.
- **A detail that is not found prints the Worker's sentence.**
  A 404 from the detail route means the request is closed, and the Worker's sentence says so; "reload" would be wrong advice, so the page prints that sentence and offers no refresh link.
- **The reason for the identifier screen is always asked for when the screen says `acknowledge`.**
  The API would pass without one when this administrator's own acknowledgment is already on the request, but the page does not read that, so it asks again.
  Sending it again is accepted and recorded again, so the cost is friction and no wrong approval.
- **A stopped approval that never started publishing is offered as a fresh approval.**
  The API gates a stopped run like a fresh one, so the panel asks for the typed word, and for an override or a reason when they are needed.
  Its button reads "Approve and publish" where the row's own button reads "Resume approval"; only a run that has started publishing is continued without the gates, and its panel button reads "Continue approval".
  When the row's own button reads "Retry approval", an approve offered again, the panel's button says "Retry approval" too, so the two never name one action two ways.
- **A failure is worded by the page, never by the Worker's sentence, where that sentence could name a terminal.**
  A 401 or 403 that carries only a sentence prints the page's own "sign in again" word, because an inactive account's refusal names a terminal command.
  An approve that gets no answer (a missed deadline, a dead connection, or the proxy's own `upstream_unreachable` or `upstream_redirect` 502) says the approval may have started and asks the administrator to refresh and check before trying again, because the dispatch may have gone out; the API's lease makes a retry a harmless refusal.
- **The API deploys before the website.**
  A page promoted ahead of the API gets a detail without `statement`, so it withholds the panel, prints "out of step" and offers no Approve, and it never falls back to the terminal's `line`.
  The release that carries this page therefore waits for the API that carries nemar-cli#1731.

## Consequences

The page prints one authoritative reading of each request, and a cure that changes with the request (the dataset, whether a start can reach it, the detail of a failed question) needs no second copy on the website.
A stale page is caught by the API's guards, which answer with a typed refusal; the page then refetches the detail rather than rendering the refusal's own reasons.
The words with no counterpart in the API, the class tags and the "out of step" sentence among them, stay page-owned and unmirrored.
The 22-key table is held by its own tests, a rule that every key has a consumer on the page, and a drift test against nemar-cli `dev`; the strict path in nemar-cli's continuous integration needs this file on `staging` first.
An administrator cannot approve from the page a request whose only blocker is a hard reason or a missing review that cannot be started; the terminal remains for those.
The page cannot run the identifier screen again (nemarOrg/website#461) or mail the depositor a comment (nemarOrg/website#462).
The `identifiers_found` badge, "Identifiers found", also shows on the depositor's dashboard card, because both surfaces draw it from the one `PublishStateBadge` component.

## Alternatives considered

- **Transcribe all 24 reasons and their composition:** a second copy of what changes per request, which the drift tests of ADR 0015 exist to catch.
- **Run the verdict in the browser:** a second implementation of the rules would drift from the API's, which is the failure ADR 0015 exists to prevent.
- **Extend `ConfirmDialog` with a slot:** it is a shared component, and the page needs the controls (a confirmation and a recorded reason of 10 to 500 characters) before the typed `PUBLISH` dialog, which stays the last step and is unchanged.
- **Keep the bodyless click when the detail fails:** it would let an administrator past the rules the page exists to show.

## Receipts

- nemar-cli#1731 (Phase 4) of epic nemar-cli#1726; website#459.
- nemar-cli ADR 0102 (Phase 4 amendment) and ADR 0103.
- Website ADR 0015 (mirrored copy and drift tests) and ADR 0022 (dispatched approval).
- The captured API response fixtures under `test/fixtures/`, each with a note on how it was captured.
