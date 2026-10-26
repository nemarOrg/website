/**
 * The reply flow of the ticket page (and, with `kind: "note"`, the note flow, which follows the
 * same rules because a note is stored once per key too), apart from the DOM so it can be tested end to end: one draft
 * (text and `Idempotency-Key` together), its phase, its `sessionStorage` copy, and the single
 * place a send is attempted.
 *
 * The send and the storage are parameters. The page passes `replyToTicket` and
 * `window.sessionStorage`; a test passes the real `replyToTicket` over a `fetch` that returns real
 * `Response`s, and an in-memory storage.
 *
 * The rules this module holds, which the page used to hold inline:
 * - an attempt starts only from `idle` or `in_doubt`, so a second click while a call is out, or a
 *   second confirm, does nothing and sends nothing;
 * - every attempt for a draft sends the draft's key, so a retry is the same request;
 * - a new key is minted in exactly two places: after a success (the old key now replays the sent
 *   reply) and in {@link ReplyFlow.startOver}, which the page puts behind a warning;
 * - the draft is saved after every transition, so a reload keeps it, and a draft saved while
 *   `sending` comes back `in_doubt`.
 */

import { type ReplyFailure, classifyNoteFailure, classifyReplyFailure } from "./mail-admin-api";
import { TEXT_MAX } from "./mail-admin-contract";
import {
  type DraftKind,
  type ReplyDraft,
  clearDraft,
  edit,
  failure,
  loadDraft,
  newDraft,
  saveDraft,
  send,
  startOver,
  success,
} from "./mail-display";

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type AttemptResult =
  /** The reply went out; the draft is a fresh one and the page reloads the thread. */
  | { outcome: "sent" }
  /** The call failed; `kind` says what the draft is now and `error` is what to tell the person. */
  | { outcome: "failed"; kind: ReplyFailure; error: unknown }
  /** Nothing was sent: no text, or too much. */
  | { outcome: "empty" | "too_long" }
  /** Nothing was sent: the draft is not in a state that may send (already sending, or unknown). */
  | { outcome: "ignored" };

export interface ReplyFlow {
  readonly draft: ReplyDraft;
  edit(text: string): void;
  attempt(): Promise<AttemptResult>;
  /** Only from `unknown`: a new key, the text kept. */
  startOver(): void;
}

export function createReplyFlow(options: {
  ticketId: number;
  /** Sends the reply under the given key; rejects with what `replyToTicket` rejects with. */
  sendReply: (text: string, key: string) => Promise<unknown>;
  storage: DraftStorage | undefined;
  /** A note keeps its own draft and key; the rules are the same. Default `reply`. */
  kind?: DraftKind;
  /** Called after every change of the draft, for the page to render. */
  onChange?: () => void;
}): ReplyFlow {
  const { ticketId, sendReply, storage, onChange, kind = "reply" } = options;
  let draft: ReplyDraft = loadDraft(storage, ticketId, kind) ?? newDraft();

  function persist(): void {
    if (draft.phase === "idle" && draft.text.trim() === "") clearDraft(storage, ticketId, kind);
    else saveDraft(storage, ticketId, draft, kind);
  }
  function changed(): void {
    persist();
    onChange?.();
  }

  return {
    get draft() {
      return draft;
    },
    edit(text) {
      const next = edit(draft, text);
      if (next === draft) return;
      draft = next;
      changed();
    },
    startOver() {
      const next = startOver(draft);
      if (next === draft) return;
      draft = next;
      changed();
    },
    async attempt() {
      // `send` moves only an idle or in-doubt draft to `sending`.
      if (draft.phase !== "idle" && draft.phase !== "in_doubt") return { outcome: "ignored" };
      if (draft.text.trim() === "") return { outcome: "empty" };
      if (draft.text.length > TEXT_MAX) return { outcome: "too_long" };
      draft = send(draft);
      changed();
      try {
        await sendReply(draft.text, draft.key);
      } catch (error) {
        // A note has no delivery to be unsure of: it either stored once under its key or it did not.
        const failedKind =
          kind === "note" ? classifyNoteFailure(error) : classifyReplyFailure(error);
        draft = failure(draft, failedKind);
        changed();
        return { outcome: "failed", kind: failedKind, error };
      }
      draft = success();
      clearDraft(storage, ticketId, kind);
      onChange?.();
      return { outcome: "sent" };
    },
  };
}
