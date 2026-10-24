# ADR 0029: The admin Mail tab renders email as inert text and sends every reply under one key per draft

**Status:** accepted
**Date:** 2026-10-24
**Owner:** Seyed Yahya Shirazi

## Context

Support email now becomes tickets, and the Application Programming Interface (API) has admin routes to list, read, reply to, assign, escalate and close them (nemar-cli epic #1893).
The admin portal gains a Mail tab over those routes (website#479).
Two facts make that tab different from the other admin tabs.
First, a ticket's subject, addresses and body are email, which an attacker writes, and the page shows them to an administrator who has the power to approve users and read private tickets.
Second, a reply sends real mail from the support address and cannot be recalled, over a path with a mail provider in it that can lose a response after the mail has gone out.
The API already stores a reply's `Idempotency-Key` before it sends and never sends under one key twice, so a client that keeps the key with the draft can retry without fear.
Who may see a ticket is the API's rule, and an administrator may be a person or an automated agent; the page must not distinguish them.

## Decision

**Ticket text is rendered only as escaped plain text.**
No raw-HTML directive, no automatic linking, no image or other remote content, anywhere in a Mail page or component.
The body sits in a `<div dir="auto">` with `white-space: pre-wrap`.
Before that, `displaySafeLine` (subjects, addresses, tags, event kinds) and `displaySafeBody` (bodies) write out, as visible escapes, the characters that hide or reorder text: the C0 and C1 controls, the line and paragraph separators, the bidirectional embeddings, overrides and isolates, and the zero-width characters.
The set is the command line's, so the two surfaces show the same hostile message the same way.
A body keeps the three implicit direction marks, which are ordinary in right-to-left mail and cannot reorder a run; a one-line field escapes them.
A source-level test fails the build if any Mail file gains a raw-HTML directive or a link or image in the message component.

**A reply carries one `Idempotency-Key` per draft, and the key and the text travel together.**
The draft (key, text, phase) lives in `sessionStorage` under `nemar:mail-reply:<ticketId>` and is saved after every change, so a reload does not lose it.
Every attempt for a draft sends the same key.
The phases are `idle`, `sending`, `in_doubt` and `unknown`, and a failure is classified in one place (`classifyReplyFailure`):

- A lost connection, a timeout, any 5xx and `reply_in_progress` leave the draft `in_doubt`: locked, with a Try again that reuses the key and asks nothing, because the API replays a sent reply and never sends a second.
- `reply_not_sent` and any other 4xx leave it `idle` and editable.
- `reply_delivery_unknown` is final for that key, because the API answers it again for every repeat and never sends: the draft is `unknown`, locked, with "Reload the thread" and "Write a new reply instead".
  The second is the only place a new key is minted for an existing draft, and it sits behind a dialog that says the first reply may already have been delivered and a second copy may go.
- A draft saved while `sending` is restored as `in_doubt`, since the call may have arrived.

A successful reply starts the next draft with a new key, because the old one now replays the sent reply.

**The page shows what the API returns and nothing more.**
Queue and ticket visibility is the API's: a ticket it will not show is a 404 with one sentence ("There is no such ticket, or it is not visible to you.") whether it does not exist or is hidden, on the page and for a malformed id alike.
The page never reads the kind of an account and never filters or reveals a ticket itself; owner-only controls are shown from the session's role and enforced by the API.

## Consequences

- A hostile message is inert, and a reader sees that it was hostile (an escape where a control character was) instead of being silently cleaned.
- A double click, a retry after a lost response, a reload mid-send and two tabs cannot send twice, and an unconfirmed send is something the page says out loud instead of guessing.
- A draft survives only in the browser tab's session storage; another browser or a cleared session starts a fresh draft with a fresh key, which is safe because nothing was recorded under the lost key's text that the page could mistake for its own.
- The same-origin API proxy now forwards `Idempotency-Key`, and the tab's wording and its four closed lists (statuses, settable statuses, queue strategies, error codes) are copied from nemar-cli and checked against it by a drift test.
- The tab needs the mail routes on the API it talks to, so the staging-to-main promotion waits for nemar-cli to release them to production.

## Alternatives considered

- **Sanitize the body as HTML and allow links.** A sanitizer is a second parser of attacker input, and the one thing an administrator needs from a body is to read it; a link is a click toward a page the attacker chose.
- **A new key for every send attempt.** It makes the double click and the lost response the two ways to send twice, which is the failure the key exists to prevent.
- **Retry `reply_delivery_unknown` automatically under the same key.** The API will never send under it, so the retry would loop on a refusal and tell the reader nothing.
- **Hide the Mail tab from administrators who cannot see any restricted queue.** The visibility rule is the API's and changes with the queue; the page that mirrored it would drift from it.

## Receipts

- website#479, nemar-cli#1898, nemar-cli epic #1893.
- `src/lib/mail-display.ts`, `src/lib/mail-admin-api.ts`, `src/lib/mail-admin-contract.ts`, `test/admin-mail-ui.test.ts`, `test/mail-admin-contract-drift.test.ts`.
