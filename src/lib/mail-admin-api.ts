/**
 * Admin Mail client: the support-ticket routes `/admin/mail/*` (nemar-cli epic #1893), plus the
 * two fail-soft helpers the Mail pages lean on, the badge count and the staff directory.
 *
 * Browser-safe, like `users-admin-api.ts`: plain `fetch`, never `api-fetch.ts` (the client bundle
 * guard forbids it). SSR callers pass `cookieHeader` and hit the API directly; browser callers
 * omit it and go through the same-origin `/api/v1` proxy, which forwards `Idempotency-Key` and
 * `Origin` (the API checks `Origin` on cookie-authenticated admin writes).
 *
 * ERRORS. Mail routes answer `{ error: <sentence>, code: <MailErrorCode> }`, the reverse of the
 * rest of the admin API, where `readError()` in `api-base.ts` reads `error` as the code. So this
 * client has its own reader, {@link readMailError}. Other things also arrive here and are told
 * apart: the plain admin gate (`{ error: "Admin access required" }`, no code), the proxy's own
 * `upstream_unreachable` and `upstream_redirect` words, a 429, and a gateway page that is not
 * JSON at all.
 *
 * REPLIES are the one call that must never run twice. {@link replyToTicket} always sends an
 * `Idempotency-Key`; {@link classifyReplyFailure} says what a caller may do after a failure.
 */

import { dashboardApiBase } from "./api-base";
import {
  type Availability,
  IDEMPOTENCY_KEY_PATTERN,
  type ListQueuesResponse,
  type ListTicketsResponse,
  MAIL_ERROR_CODES,
  type MailErrorCode,
  type MailQueue,
  type NoteResponse,
  type PutAvailabilityRequest,
  type PutQueueRequest,
  type ReplyResponse,
  SEARCH_MAX,
  type SettableStatus,
  TICKET_STATUSES,
  type TicketActionResponse,
  type TicketDetail,
} from "./mail-admin-contract";
import { displaySafeLine } from "./mail-display";
import { resolveSignal } from "./request-deadline";
import { type AdminUserListRow, listAdminUsers } from "./users-admin-api";

type Init = {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly cookieHeader?: string;
  /** Abort the request after this many ms. Defaults to the shared 5 s deadline. */
  readonly timeoutMs?: number;
};

/** A reply goes through an external mail provider, so it gets longer than a D1 read. */
const REPLY_TIMEOUT_MS = 30_000;
/** The badge sits on every admin page, so it gets less than a page read. */
const BADGE_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A refusal or failure from a mail route, or from the proxy in front of it. */
export class MailApiError extends Error {
  readonly status: number;
  /** The closed word, when the API sent one this client knows. */
  readonly code?: MailErrorCode;
  /** The body's `error` text: a sentence from the API, or a word from the proxy. */
  readonly sentence?: string;
  constructor(status: number, code?: MailErrorCode, sentence?: string) {
    super(sentence ?? code ?? `Mail request failed (${status})`);
    this.name = "MailApiError";
    this.status = status;
    this.code = code;
    this.sentence = sentence;
  }
}

const KNOWN_CODES: ReadonlySet<string> = new Set(MAIL_ERROR_CODES);

/**
 * What a non-OK response says, whatever shape it has. Never throws: a body that is not JSON (a
 * gateway page, maintenance mode) yields `{}` and the caller falls back on the status.
 */
export async function readMailError(
  res: Response,
): Promise<{ code?: MailErrorCode; sentence?: string }> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {};
  }
  if (!body || typeof body !== "object") return {};
  const { error, code } = body as Record<string, unknown>;
  const sentence = typeof error === "string" && error.length > 0 ? error : undefined;
  return {
    code: typeof code === "string" && KNOWN_CODES.has(code) ? (code as MailErrorCode) : undefined,
    sentence,
  };
}

/**
 * Wording for each closed word, in the site's voice: what happened and what to do, with no CLI
 * commands. `not_found` is one sentence whatever the cause, because the API answers 404 for a
 * ticket the caller may not see exactly as for one that does not exist.
 */
export const MAIL_ERROR_TEXT: Record<MailErrorCode, string> = {
  bad_request: "The server rejected that request as malformed.",
  not_found: "There is no such ticket, or it is not visible to you.",
  forbidden:
    "Your account is not permitted to do that. It may be an owner-only action, or your account may not be active.",
  ineligible_assignee:
    "That person cannot take it. On a restricted queue everyone named must be an owner; on any other queue, an admin or an owner.",
  ticket_is_spam: "The ticket is marked spam. Set its status to Open before changing it.",
  ticket_closed: "The ticket is closed. Set its status to Open before changing it.",
  already_escalated: "The ticket is already escalated.",
  no_escalation_owner:
    "The queue has no escalation owner. An owner can set one on the Queues page.",
  escalation_owner_ineligible:
    "The queue's escalation owner cannot take this ticket. An owner can name another on the Queues page.",
  restricted_locked: "The ticket is in a restricted queue, which locks this change. Ask an owner.",
  restricted_flag_busy:
    "The queue still has open tickets, so its restricted setting cannot change. Close or move them first.",
  restriction_mismatch:
    "The ticket's restricted flag no longer matches its queue, so it cannot be reopened. Ask an owner.",
  reply_in_progress: "A reply with this key is still being sent. Wait a moment, then try again.",
  fallback_not_restrictable: "The fallback queue is never restricted.",
  reply_not_sent:
    "Nothing was sent, and the reply can be sent again. Try again if you still want to reply.",
  reply_delivery_unknown:
    "The mail provider did not confirm the send, so the reply may or may not have reached the requester. This reply will never be sent again automatically. Reload the thread to see whether it was recorded, and ask the requester if needed. Writing a new reply sends again and may deliver a second copy.",
  inbound_not_configured: "This deployment has no inbound mail storage.",
  internal: "The mail service failed unexpectedly. Try again, and report it if it keeps happening.",
};

/** Failures that come from the proxy or the connection rather than from a mail route. */
export const TRANSPORT_TEXT = {
  upstream_unreachable: "The server could not be reached. Check your connection and try again.",
  upstream_redirect: "The server answered in a way this page cannot follow. Try again later.",
  origin_not_allowed:
    "This page was not accepted as the source of the request. Reload and try again.",
  unauthenticated: "Sign in again.",
  forbidden: "Your account is not permitted to do that.",
  rate_limited: "Too many requests. Wait a moment, then try again.",
  timeout: "The server did not answer in time. Try again.",
  network: "The server could not be reached. Check your connection and try again.",
} as const;

function joinDistinct(head: string, tail: string | undefined): string {
  const t = (tail ?? "").trim();
  return t && t !== head ? `${head} ${t}` : head;
}

/**
 * One line for a person, from whatever a mail call threw. The closed word's wording comes first;
 * the API's own sentence follows when it adds something (a `bad_request` names the field), and is
 * dropped when it repeats the wording. A `not_found` never carries the API's sentence, so nothing
 * about why a ticket is unavailable can leak into the page.
 */
export function mailErrorText(err: unknown): string {
  if (err instanceof MailApiError) {
    if (err.code === "not_found") return MAIL_ERROR_TEXT.not_found;
    if (err.code) return joinDistinct(MAIL_ERROR_TEXT[err.code], err.sentence);
    const word = err.sentence;
    if (word && Object.hasOwn(TRANSPORT_TEXT, word)) {
      return TRANSPORT_TEXT[word as keyof typeof TRANSPORT_TEXT];
    }
    if (err.status === 401) return TRANSPORT_TEXT.unauthenticated;
    if (err.status === 429) return TRANSPORT_TEXT.rate_limited;
    if (err.status === 403) return TRANSPORT_TEXT.forbidden;
    if (word) return word;
    return `The request failed (${err.status}). Try again.`;
  }
  if (err instanceof DOMException && err.name === "TimeoutError") return TRANSPORT_TEXT.timeout;
  if (err instanceof TypeError) return TRANSPORT_TEXT.network;
  return err instanceof Error && err.message ? err.message : "Something went wrong. Try again.";
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function mailFetch<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  init: Init,
  options: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchImpl(`${dashboardApiBase(init.cookieHeader)}/admin/mail${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: "include",
    signal: resolveSignal({
      signal: init.signal,
      timeoutMs: init.timeoutMs ?? options.timeoutMs,
    }),
  });
  if (!res.ok) {
    const { code, sentence } = await readMailError(res);
    throw new MailApiError(res.status, code, sentence);
  }
  try {
    return (await res.json()) as T;
  } catch {
    // The call succeeded and its answer is unreadable. Say so with the real status, so a caller
    // that cannot tell what happened (a reply) treats it as unknown rather than as a refusal.
    throw new MailApiError(
      res.status,
      undefined,
      "The server sent an answer this page could not read.",
    );
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface MailTicketsQueryInput {
  status?: string | null;
  queue?: string | null;
  assignee?: string | null;
  q?: string | null;
  cursor?: string | null;
  limit?: number | string | null;
}

const ASSIGNEE_PATTERN = /^(me|none|\d{1,12})$/;
/** `"YYYY-MM-DD HH:MM:SS|id"`, the shape the API's `next_cursor` has. */
const CURSOR_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\|\d{1,12}$/;

/**
 * The list route's query string. Anything the route would refuse (an unknown status, a
 * 101-character search, a malformed cursor) is dropped instead of sent, so a hand-edited URL
 * shows the default list rather than a 400. The values that remain are the ones a person chose.
 */
export function mailTicketsQuery(input: MailTicketsQueryInput): string {
  const params = new URLSearchParams();
  const status = input.status ?? "";
  if ((TICKET_STATUSES as readonly string[]).includes(status)) params.set("status", status);
  const queue = input.queue ?? "";
  if (queue.length > 0 && queue.length <= 64) params.set("queue", queue);
  const assignee = input.assignee ?? "";
  if (ASSIGNEE_PATTERN.test(assignee)) params.set("assignee", assignee);
  const q = (input.q ?? "").trim();
  if (q.length > 0 && q.length <= SEARCH_MAX) params.set("q", q);
  const cursor = input.cursor ?? "";
  if (CURSOR_PATTERN.test(cursor)) params.set("cursor", cursor);
  const limit = typeof input.limit === "string" ? Number(input.limit) : input.limit;
  if (typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 100) {
    params.set("limit", String(limit));
  }
  return params.toString();
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export function listTickets(
  input: MailTicketsQueryInput = {},
  init: Init = {},
): Promise<ListTicketsResponse> {
  const qs = mailTicketsQuery(input);
  return mailFetch("GET", `/tickets${qs ? `?${qs}` : ""}`, init);
}

export function getTicket(id: number, init: Init = {}): Promise<TicketDetail> {
  return mailFetch("GET", `/tickets/${id}`, init);
}

/**
 * Send a reply. The `Idempotency-Key` is required and always sent: it is what makes a double
 * click, a retry after a lost response and a reload safe, because the API stores the key before
 * it sends and never sends under one key twice. The caller keeps the key with its draft.
 */
export function replyToTicket(
  id: number,
  text: string,
  key: string,
  init: Init = {},
): Promise<ReplyResponse> {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return Promise.reject(
      new MailApiError(400, "bad_request", "The reply key is not valid. Reload the page."),
    );
  }
  return mailFetch("POST", `/tickets/${id}/reply`, init, {
    body: { text },
    headers: { "Idempotency-Key": key },
    timeoutMs: REPLY_TIMEOUT_MS,
  });
}

export function addNote(id: number, text: string, init: Init = {}): Promise<NoteResponse> {
  return mailFetch("POST", `/tickets/${id}/note`, init, { body: { text } });
}

export function assignTicket(
  id: number,
  userId: number | null,
  init: Init = {},
): Promise<TicketActionResponse> {
  return mailFetch("POST", `/tickets/${id}/assign`, init, { body: { user_id: userId } });
}

export function setTicketStatus(
  id: number,
  status: SettableStatus,
  init: Init = {},
): Promise<TicketActionResponse> {
  return mailFetch("POST", `/tickets/${id}/status`, init, { body: { status } });
}

/** `reason` is optional; without one the body is `{}`. */
export function escalateTicket(
  id: number,
  reason?: string,
  init: Init = {},
): Promise<TicketActionResponse> {
  const trimmed = (reason ?? "").trim();
  return mailFetch("POST", `/tickets/${id}/escalate`, init, {
    body: trimmed ? { reason: trimmed } : {},
  });
}

// ---------------------------------------------------------------------------
// Queues and availability
// ---------------------------------------------------------------------------

export async function listQueues(init: Init = {}): Promise<MailQueue[]> {
  const body = await mailFetch<ListQueuesResponse>("GET", "/queues", init);
  return body.queues;
}

export async function putQueue(
  tag: string,
  request: PutQueueRequest,
  init: Init = {},
): Promise<MailQueue> {
  const body = await mailFetch<{ queue: MailQueue }>(
    "PUT",
    `/queues/${encodeURIComponent(tag)}`,
    init,
    { body: request },
  );
  return body.queue;
}

/** The caller's own window, or another person's when an owner passes `userId`. */
export async function getAvailability(userId?: number, init: Init = {}): Promise<Availability> {
  const path = userId === undefined ? "/availability" : `/availability/${userId}`;
  const body = await mailFetch<{ availability: Availability }>("GET", path, init);
  return body.availability;
}

export async function putAvailability(
  request: PutAvailabilityRequest,
  userId?: number,
  init: Init = {},
): Promise<Availability> {
  const path = userId === undefined ? "/availability" : `/availability/${userId}`;
  const body = await mailFetch<{ availability: Availability }>("PUT", path, init, {
    body: request,
  });
  return body.availability;
}

// ---------------------------------------------------------------------------
// Reply failures
// ---------------------------------------------------------------------------

/**
 * What a caller may do after a reply call failed.
 *
 * - `retry_same_key`: the outcome is not known yet, or the send is still running. Retrying under
 *   the SAME key is safe whichever it was, because the API replays a sent reply and never sends
 *   twice under one key. A lost connection, a timeout, any 5xx (including the proxy's) and
 *   `reply_in_progress` land here.
 * - `key_released`: the API certainly sent nothing and released the key. The same key may be
 *   used again, and the draft is editable.
 * - `outcome_unknown`: `reply_delivery_unknown`. Final for this key: the API will not send under
 *   it again, so retrying is pointless. Only a new key sends, and it may deliver a second copy.
 * - `refused`: a definite 4xx. Nothing was sent, and the same request would be refused again.
 */
export type ReplyFailure = "retry_same_key" | "key_released" | "outcome_unknown" | "refused";

/** What the three reply words mean for the key, whatever the status they arrive with. */
const REPLY_CODE_OUTCOME: Partial<Record<MailErrorCode, ReplyFailure>> = {
  reply_delivery_unknown: "outcome_unknown",
  reply_not_sent: "key_released",
  reply_in_progress: "retry_same_key",
};

/**
 * One table, in order, so every branch is a decision and not an accident:
 *
 * 1. A reply word decides by itself (`REPLY_CODE_OUTCOME`).
 * 2. Any other mail code is the route speaking, so the request was understood: a 5xx
 *    (`internal`) may have been sent, a 4xx certainly was not (`refused`).
 * 3. No mail code, so the answer may not have come from the mail route at all:
 *    - `origin_not_allowed`, 401 and 403 are the API refusing before it reached the send: `refused`.
 *    - 429 is a limiter and says nothing about the send: `retry_same_key`.
 *    - any other 4xx (a 408, a gateway's 400) and every 5xx or 2xx with an unreadable body are
 *      `retry_same_key`: the request may have arrived, and the same key makes a retry harmless.
 * 4. Not an API answer at all (a lost connection, a timeout, an abort): `retry_same_key`.
 */
export function classifyReplyFailure(err: unknown): ReplyFailure {
  if (!(err instanceof MailApiError)) return "retry_same_key";
  if (err.code) {
    return REPLY_CODE_OUTCOME[err.code] ?? (err.status >= 500 ? "retry_same_key" : "refused");
  }
  if (err.sentence === "origin_not_allowed") return "refused";
  if (err.status === 401 || err.status === 403) return "refused";
  return "retry_same_key";
}

// ---------------------------------------------------------------------------
// Badge and directory
// ---------------------------------------------------------------------------

/** The most the badge asks for, and so the most it can count. */
const BADGE_LIMIT = 100;

/**
 * Open tickets assigned to the caller, for the Mail tab badge. `more` is true when the API had
 * another page, so the badge reads `100+`. Never throws, like the other badge fetches: the
 * shared admin shell renders on every page and must not break on a mail hiccup, and a null is
 * logged so a broken mail route is not indistinguishable from an empty queue.
 */
export async function fetchMyOpenTicketCount(
  init: Init = {},
): Promise<{ count: number; more: boolean } | null> {
  try {
    const page = await listTickets(
      { status: "open", assignee: "me", limit: BADGE_LIMIT },
      { ...init, timeoutMs: init.timeoutMs ?? BADGE_TIMEOUT_MS },
    );
    return { count: Math.min(page.tickets.length, BADGE_LIMIT), more: page.next_cursor !== null };
  } catch (err) {
    console.warn(
      "[mail-admin-api] mail badge degraded to null:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export interface StaffPerson {
  readonly id: number;
  /** Already escaped by {@link displaySafeLine}: a name is data from outside. */
  readonly label: string;
  readonly role: "owner" | "admin";
  readonly status: string;
}

export interface StaffDirectory {
  /**
   * Who a select may offer: admins and owners whose account is approved, which is what the API
   * requires of an assignee. `GET /admin/users?role=` returns every non-deleted account with the
   * role whatever its status, so the list is filtered here, and only this list feeds a picker.
   */
  readonly assignable: readonly StaffPerson[];
  /** Everyone the lists returned, revoked included, for naming an assignee or an actor in history. */
  readonly byId: ReadonlyMap<number, string>;
  /** True when either list failed: names may be missing and the selects may be short. */
  readonly failed: boolean;
}

/** The only status the API accepts for an assignee. */
const ASSIGNABLE_STATUS = "approved";

/** A username, then a name, then `#id`, escaped once here so no caller has to remember to. */
function staffLabel(user: AdminUserListRow): string {
  const username = (user.username ?? "").trim();
  if (username) return displaySafeLine(username);
  const name = `${user.given_name ?? ""} ${user.family_name ?? ""}`.trim();
  return name ? displaySafeLine(name) : `#${user.id}`;
}

/**
 * Everyone who can hold a ticket, as one list. Fail-soft: a failure of either list leaves the
 * other, and `failed` says so, because a mail page with no names is still usable and a mail page
 * that throws on a users hiccup is not. Reads the role and the status only, never the kind of
 * account: a person and an agent are listed alike.
 */
export async function loadStaffDirectory(init: Init = {}): Promise<StaffDirectory> {
  const [owners, admins] = await Promise.allSettled([
    listAdminUsers({ role: "owner" }, init),
    listAdminUsers({ role: "admin" }, init),
  ]);
  const people = new Map<number, StaffPerson>();
  let failed = false;
  for (const [result, role] of [
    [owners, "owner"],
    [admins, "admin"],
  ] as const) {
    if (result.status === "rejected") {
      failed = true;
      console.warn(
        `[mail-admin-api] staff directory is missing the ${role} list:`,
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
      continue;
    }
    for (const user of result.value.users) {
      if (!people.has(user.id)) {
        people.set(user.id, { id: user.id, label: staffLabel(user), role, status: user.status });
      }
    }
  }
  const sorted = [...people.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id - b.id);
  return {
    assignable: sorted.filter((p) => p.status === ASSIGNABLE_STATUS),
    byId: new Map(sorted.map((p) => [p.id, p.label])),
    failed,
  };
}

/** A person by id as the directory knows them, or `#id` when it does not. */
export function personLabel(directory: StaffDirectory, id: number | null): string {
  if (id === null) return "Unassigned";
  return directory.byId.get(id) ?? `#${id}`;
}

/** Whether a select may offer this person (see {@link StaffDirectory.assignable}). */
export function isAssignable(directory: StaffDirectory, id: number): boolean {
  return directory.assignable.some((p) => p.id === id);
}

/**
 * The label of a person a select must still show because they are already named (a queue's
 * assignee, a ticket's assignee) but cannot be offered: shown selected, so a save does not
 * silently change them, and marked, so nobody picks them on purpose.
 */
export function notAssignableLabel(directory: StaffDirectory, id: number): string {
  return `${personLabel(directory, id)} (not assignable)`;
}
