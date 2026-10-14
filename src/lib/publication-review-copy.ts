/**
 * The words the administrator approval page owns where it must say what the CLI says: the review
 * gate's and the identifier screen's refusals, the approve control's states, the review's standing
 * line and the labels on the model's text, and the success of a review start (website#459,
 * nemar-cli#1731, Phase 4 of epic nemar-cli#1726).
 *
 * **Source of truth: nemar-cli `shared/contract/publication-review-copy.ts`.** This file is its
 * copy with the SAME KEYS and the same strings. The two repos share no package, so the values are
 * transcribed rather than imported, and `test/publication-review-copy-drift.test.ts` compares the
 * two files whenever a nemar-cli checkout is reachable (it skips, with a note, when none is, and
 * fails when `NEMAR_CLI_REVIEW_COPY` names a file that is not there). Changing a sentence here
 * means changing it there in the same breath.
 *
 * **Four rules this file has to keep, because the drift test and the mirroring depend on them:**
 *
 * 1. *Every value is a literal string.* No template literals, no concatenation, no interpolation
 *    from a constant: the drift test reads the nemar-cli file as TEXT, so a computed value would
 *    be invisible to it. Where a sentence embeds a number that lives somewhere else
 *    (`screen_gate.acknowledge` and the 10 to 500 character bounds of the acknowledgment), the
 *    literal is written out and `publication-review-copy.test.ts` asserts it still agrees with the
 *    page's constants.
 * 2. *Every value is a complete sentence the page prints as it is.* There are no placeholders and
 *    no accessor.
 * 3. *Keys are stable and dotted.* They are the mirroring contract; renaming one is a change on
 *    both sides. Every key is mirrored, and the drift test fails on a key either side lacks.
 * 4. *Every key here has a consumer, and none names a terminal.* A consumer names the key as a
 *    quoted literal in a page, component or lib; no value contains a command, a flag, a
 *    placeholder or a backtick, or the words "terminal", "command" or "CLI"
 *    (`test/publication-review-web-words.ts`).
 *
 * What is deliberately NOT here:
 *
 * - **Words the Worker sends and the page prints.** A reason's sentence, statement and cure, the
 *   identifier screen's headline and lines, and the message of a refusal that names no terminal
 *   are printed from the response; a copy here would be a second place to drift.
 * - **Page-owned UI words** (headings, button labels, the class tags of a finding): they have no
 *   CLI counterpart and live beside the code that prints them.
 * - **The existing friendly messages** of the approval page (`forbidden`, `not_found` and the
 *   like).
 *
 * This module imports nothing and nothing in it is computed, so it can be lifted out whole.
 */

/** The copy table. Index it directly; the keys are typed. */
export const PUBLICATION_REVIEW_COPY = {
  // The review gate's refusal words (`REVIEW_GATE_REFUSALS`), by the `refusal` of a 409
  // publication_review_not_clear. `hard_reason` and `unverified` are the Worker's own sentences,
  // which name no terminal; the other four are worded for a page.
  "gate.hard_reason":
    "The publication review gives a reason that no override clears, so the approval is refused.",
  "gate.needs_override":
    "The publication review is not a pass. Read the reasons, then confirm that you approve despite them; the confirmation is recorded with your account.",
  "gate.override_not_covering":
    "The review now gives a reason that your confirmation was not given for. Read the reasons again before approving.",
  "gate.review_changed":
    "The review your confirmation was given for is no longer the review of this request, or it changed while the approval was being checked. Read the reasons again before approving.",
  "gate.no_review_row":
    "No review of this commit is on record to attach your confirmation to. Start the review, then approve.",
  "gate.unverified":
    "The publication review could not be checked just now, so the approval is refused. Try again.",

  // The identifier screen's refusal words, by the `gate` of a 409 identifier_screen_not_clear.
  // `acknowledge` is also the prompt above the reason field before the click.
  "screen_gate.acknowledge":
    "The identifier screen found something a person must look at, or could not read everything. Read what it reported, then give a reason of 10 to 500 characters to approve; the reason is recorded with your account.",
  "screen_gate.blocks":
    "The identifier screen found a direct identifier, which cannot be acknowledged. The depositor must remove it and request publication again, which runs the screen again.",
  "screen_gate.wait":
    "The identifier screen is still running, or its result has just changed. Reload to read its current result.",
  "screen_gate.rerun":
    "The identifier screen has no verdict about the current commit, so approval waits for a screen that produced one. An administrator runs the screen again.",
  "screen_gate.stale":
    "The identifier screen read a commit that is no longer the head of main, so its result is out of date. An administrator runs the screen again.",
  "screen_gate.unverified":
    "The identifier screen's result could not be checked against the current commit just now, so the approval is refused. Try again. If it keeps happening, an administrator runs the screen again.",

  // The approve control.
  "approve.unavailable":
    "The publication review could not be read just now, so Approve is not offered. Reload to try again.",
  "approve.blocked":
    "This request is blocked, so it cannot be approved until the block is cleared.",
  "approve.resume":
    "This approval has started publishing; it passed the gates when it started and is continued without them.",
  "approve.override_control":
    "I have read the reasons above and approve despite them. This records an override with my account.",

  // The review's standing word and the labels on the model's text.
  "review.not_assessed": "Not assessed: whether the text names the depositors.",
  "review.model_summary_label": "written by the model; the depositor's text can steer it",
  "review.model_findings_label": "written by the model; the depositor's text can steer them",

  // A review start that went (HTTP 202), by `reason`.
  "start.dispatched": "The review was started.",
  "start.redispatched": "The review was started again.",
  "start.dispatch_claimed": "A review of this commit was already handed over and stands.",
} as const;

export type PublicationReviewCopyKey = keyof typeof PUBLICATION_REVIEW_COPY;
