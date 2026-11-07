/**
 * The decide flow of the admin Compute tab, apart from the DOM so it can be tested end to end
 * (website ADR 0030; epic nemarOrg/website#493 phase E4, issue #497): one decision in flight
 * page-wide, and the single place a decision is sent and a failure is read.
 *
 * The send and the re-read are parameters. The page passes `decideComputeAccess` and
 * `getComputeAccount`; a test passes the real ones over a `fetch` that returns real `Response`s.
 *
 * The rules this module holds:
 *
 *  - ONE decision at a time, across the whole page. A second `submit` while one is out is
 *    ignored and sends nothing, so a double click or a second confirm cannot post twice, and the
 *    page never has two rows changing at once.
 *  - A decision is POSTED ONCE. Nothing here retries a POST. After an outcome that could not be
 *    told (a lost connection, a timeout, any 5xx, an unreadable answer) the flow reads the
 *    account once, and the row is drawn from what the server says, not from what the page hoped.
 *  - A refusal that says the state moved (`not_requested`, `already_active`, `not_active`,
 *    `stale_state`) is followed by exactly one read too.
 *  - A refusal that changed nothing (`self_decision`, `account_not_in_good_standing`,
 *    `policy_unreadable`, a 400, a 403) reads nothing: the row is as it was.
 */

import { ACCOUNT_COPY } from "./account-copy";
import {
  type ComputeAccessRow,
  type ComputeDecisionResult,
  classifyDecisionFailure,
} from "./compute-admin-api";
import type { ComputeAccessDecision } from "./compute-admin-contract";
import {
  type DecisionNote,
  type FailureNote,
  describeDecision,
  describeFailure,
} from "./compute-admin-view";

export interface DecideRequest {
  readonly id: number;
  readonly decision: ComputeAccessDecision;
  readonly reason?: string;
}

export type DecideOutcome =
  /** Another decision is in flight; nothing was sent. */
  | { readonly outcome: "ignored" }
  /** The backend answered: draw the row from `row` (the response's account). */
  | { readonly outcome: "done"; readonly row: ComputeAccessRow; readonly note: DecisionNote }
  /**
   * The decision failed or its outcome is not known. `row` is what the re-read found: the truth
   * to draw, or null when no read was made (`note.reread` false), the account is not listed, or the
   * read itself failed (`rereadFailed`).
   */
  | {
      readonly outcome: "failed";
      readonly note: FailureNote;
      readonly row: ComputeAccessRow | null;
      readonly rereadFailed: boolean;
    };

export interface DecideFlow {
  /** True while a decision is out. The page disables every decision button while it is. */
  readonly busy: boolean;
  submit(request: DecideRequest): Promise<DecideOutcome>;
}

export function createDecideFlow(options: {
  /** Sends one decision; rejects with what `decideComputeAccess` rejects with. */
  decide: (
    id: number,
    decision: ComputeAccessDecision,
    reason: string | undefined,
  ) => Promise<ComputeDecisionResult>;
  /** Reads one account; null when it is not listed. */
  reread: (id: number) => Promise<ComputeAccessRow | null>;
}): DecideFlow {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    async submit(request) {
      if (busy) return { outcome: "ignored" };
      busy = true;
      try {
        try {
          const result = await options.decide(request.id, request.decision, request.reason);
          return { outcome: "done", row: result.account, note: describeDecision(result) };
        } catch (err) {
          const note = describeFailure(classifyDecisionFailure(err), err);
          if (!note.reread) return { outcome: "failed", note, row: null, rereadFailed: false };
          try {
            const row = await options.reread(request.id);
            return { outcome: "failed", note, row, rereadFailed: false };
          } catch {
            return {
              outcome: "failed",
              note: {
                ...note,
                text: `${note.text} ${ACCOUNT_COPY["compute_admin.result.reread_failed"]}`,
              },
              row: null,
              rereadFailed: true,
            };
          }
        }
      } finally {
        busy = false;
      }
    },
  };
}
