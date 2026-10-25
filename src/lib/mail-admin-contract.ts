/**
 * The wire shapes of the support-ticket admin routes, copied from nemar-cli
 * `shared/contract/mail-admin.ts` (epic nemarOrg/nemar-cli#1893).
 *
 * Hand-copied because the two repos share no package, and drift-tested by
 * `test/mail-admin-contract-drift.test.ts`, which compares the four closed lists below with the
 * contract. `MailErrorCode` is a union in the contract and an array here so the client can prove
 * it has wording for every code; the test reads the union back out of the contract.
 *
 * Left out on purpose: the reprocess route and its types (owner-only, the site has no surface
 * for it). The route limits at the end mirror `backend/src/routes/admin/mail.ts` in nemar-cli
 * (`TEXT_MAX`, `SUMMARY_MAX`, the escalate and away note lengths, the list schema); they are not in the shared
 * contract, so nothing tests them and the API enforces them regardless.
 *
 * Routes:
 *   GET  /admin/mail/tickets, GET /admin/mail/tickets/:id
 *   POST /admin/mail/tickets/:id/{reply,note,assign,status,escalate}
 *   PUT  /admin/mail/tickets/:id/summary (kept after the retention purge)
 *   GET  /admin/mail/queues, PUT /admin/mail/queues/:tag (owner)
 *   GET|PUT /admin/mail/availability, GET|PUT /admin/mail/availability/:userId (owner)
 */

export const TICKET_STATUSES = ["open", "pending", "escalated", "closed", "spam"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** The statuses the status route sets. `escalated` has its own route, which also reassigns. */
export const SETTABLE_STATUSES = ["open", "pending", "closed", "spam"] as const;
export type SettableStatus = (typeof SETTABLE_STATUSES)[number];

export const QUEUE_STRATEGIES = ["fixed", "round_robin", "pool"] as const;
export type QueueStrategy = (typeof QUEUE_STRATEGIES)[number];

export const MAIL_ERROR_CODES = [
  "bad_request",
  "not_found",
  "forbidden",
  "ineligible_assignee",
  "ticket_is_spam",
  "ticket_closed",
  "already_escalated",
  "no_escalation_owner",
  "escalation_owner_ineligible",
  "restricted_locked",
  "restricted_flag_busy",
  "restriction_mismatch",
  "reply_in_progress",
  "fallback_not_restrictable",
  "reply_not_sent",
  "reply_delivery_unknown",
  "summary_has_address",
  "ticket_purged",
  "inbound_not_configured",
  "internal",
] as const;
export type MailErrorCode = (typeof MAIL_ERROR_CODES)[number];

export interface MailErrorBody {
  error: string;
  code: MailErrorCode;
}

export interface TicketSummary {
  id: number;
  /**
   * The ticket's reference: three lowercase words joined by dashes (`amber-falcon-river`) for a
   * ticket created from 2026-10-25, or ten lowercase base32 characters (`wphdw6vce6`) for an older
   * one. Never rewritten. Display it as is.
   */
  ref: string;
  queue_tag: string;
  restricted: boolean;
  status: TicketStatus;
  assignee_user_id: number | null;
  requester_email: string;
  requester_user_id: number | null;
  subject: string;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  /** A summary has been written (the text itself is on the detail only). */
  has_summary: boolean;
  /** The retention purge has run on this ticket: its messages are gone and its address and subject are empty. */
  purged: boolean;
}

/** Query of the list route. `status` absent hides spam and closed tickets. */
export interface ListTicketsQuery {
  status?: TicketStatus;
  queue?: string;
  /** `me`, a user id, or `none` for unassigned. */
  assignee?: string;
  /** Substring of the subject or the requester address. */
  q?: string;
  /**
   * `missing`: closed tickets that are not purged and have no summary yet, whatever their status
   * (the default hiding of closed tickets does not apply). The queue of tickets to summarize.
   */
  summary?: "missing";
  /** The `next_cursor` of the previous page. */
  cursor?: string;
  /** 1 to 100, default 25. */
  limit?: number;
}

export interface ListTicketsResponse {
  tickets: TicketSummary[];
  /** Pass as `cursor` for the next page; null on the last. Order is last_message_at then id, newest first. */
  next_cursor: string | null;
}

export interface TicketMessage {
  id: number;
  direction: "in" | "out" | "note";
  message_id: string | null;
  from_addr: string;
  to_addr: string;
  subject: string;
  text_body: string;
  spf: string;
  dkim: string;
  dmarc: string;
  author_user_id: number | null;
  created_at: string;
}

export interface TicketEvent {
  id: number;
  kind: string;
  actor_user_id: number | null;
  detail: unknown;
  created_at: string;
}

export interface TicketDetail {
  ticket: TicketSummary;
  tags: string[];
  /** Empty once the ticket is purged. */
  messages: TicketMessage[];
  /** After a purge each event keeps its kind, actor and time; `detail` is null. */
  events: TicketEvent[];
  summary: string | null;
  summary_author_user_id: number | null;
  summarized_at: string | null;
  /** When the retention purge ran, else null. */
  purged_at: string | null;
}

/**
 * Plain text, sent as an escaped HTML body with the line breaks kept.
 *
 * The request MAY carry an `Idempotency-Key` header (1 to 64 letters, digits or `. _ : -`), and an
 * agent that can retry after a lost response SHOULD. The key is unique per ticket and stored
 * before anything is sent: a repeat of a reply that was sent returns the same response without
 * sending; a repeat while the first is still being sent is 409 `reply_in_progress`; a repeat of a
 * reply whose outcome was unknown is 409 `reply_delivery_unknown` again and is never re-sent; a
 * reply that certainly sent nothing (`reply_not_sent`) releases its key so the retry can go. Without
 * a key every request sends.
 */
export interface ReplyRequest {
  text: string;
}
export interface ReplyResponse {
  /**
   * The id of the stored outgoing message (a `TicketMessage.id`). 0 means the reply WAS sent but
   * not recorded: the retention purge claimed the ticket between the send and the write, so the
   * ticket holds no trace of it. Replaying that key then answers 409 `ticket_purged`.
   */
  message_id: number;
  /**
   * The Message-ID the mail provider reported for the sent reply, or null. It is set only when the
   * provider returned a valid RFC 5322 msg-id (the Cloudflare binding does; Resend's opaque id is
   * not one). The Worker no longer chooses the Message-ID: the provider controls it. Threading of
   * the requester's answer never depends on this value.
   */
  header_message_id: string | null;
  status: TicketStatus;
}

/**
 * An optional `Idempotency-Key` header (1 to 64 of letters, digits and `. _ : -`) makes a retry
 * safe: the key is unique per ticket, and a repeat returns the stored `message_id` with 200 and
 * stores no second note. A note sends no mail, so there is no in-progress or unknown outcome.
 * Note keys are a separate namespace from reply keys: a key used for a reply never answers a note,
 * and the reverse. Without the header every request stores a note.
 */
export interface NoteRequest {
  text: string;
}
export interface NoteResponse {
  /** The id of the stored note (a `TicketMessage.id`). */
  message_id: number;
}
/**
 * The summary kept after the retention purge: 1 to 4,000 characters after trimming. Describe the
 * request and the outcome. Do not include names, email addresses, account ids or quoted message
 * text: a summary containing an email address is refused (400 `summary_has_address`). The Worker
 * never writes one itself; whoever may see the ticket does, under the same visibility as every
 * other ticket route, so a restricted ticket is summarized only by an owner. Allowed on any ticket
 * that is not purged (a later summary replaces an earlier one); a purged ticket is 409
 * `ticket_purged`. The event records who wrote it, never the text.
 */
export interface SummaryRequest {
  summary: string;
}
export interface SummaryResponse {
  ticket: TicketSummary;
}
export interface AssignRequest {
  user_id: number | null;
}
export interface StatusRequest {
  status: SettableStatus;
}
export interface EscalateRequest {
  reason?: string;
}

export interface TicketActionResponse {
  ticket: TicketSummary;
}

export interface MailQueue {
  tag: string;
  restricted: boolean;
  strategy: QueueStrategy;
  assignee_user_id: number | null;
  backup_user_id: number | null;
  rr_members: number[];
  escalation_user_id: number | null;
  /** Tickets in this queue that are not closed and that the caller may see. */
  open_tickets: number;
}

export interface ListQueuesResponse {
  queues: MailQueue[];
}

/**
 * Every field is optional and merges into the stored queue; a tag with no queue is created.
 * Rules: `security` and `conduct` stay restricted; `*` is never restricted; the restricted flag
 * of a queue with tickets that are not closed cannot change (`restricted_flag_busy`, close or
 * move them first); every person named on a restricted queue must be an owner, and on any other
 * an admin or owner (`ineligible_assignee`). Changing `rr_members` restarts the rotation.
 */
export interface PutQueueRequest {
  restricted?: boolean;
  strategy?: QueueStrategy;
  assignee_user_id?: number | null;
  backup_user_id?: number | null;
  rr_members?: number[];
  escalation_user_id?: number | null;
}

export interface Availability {
  user_id: number;
  away_from: string | null;
  away_until: string | null;
  backup_user_id: number | null;
  note: string | null;
}

/** All fields null (and no backup) clears the window. Dates are ISO 8601 instants. */
export interface PutAvailabilityRequest {
  away_from?: string | null;
  away_until?: string | null;
  backup_user_id?: number | null;
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Route limits (backend/src/routes/admin/mail.ts, nemar-cli). Not in the shared contract.
// ---------------------------------------------------------------------------

/** Longest reply or note, in characters, after trimming. */
export const TEXT_MAX = 20_000;
/** Longest summary, in characters, after trimming. */
export const SUMMARY_MAX = 4_000;
export const ESCALATE_REASON_MAX = 500;
export const AWAY_NOTE_MAX = 500;
/** Longest `q` the list route accepts. */
export const SEARCH_MAX = 100;
export const LIST_LIMIT_MAX = 100;
/** What the API accepts as an `Idempotency-Key`. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
