/**
 * How the Mail tab shows text that came from outside, plus the reply draft's state machine.
 * Pure: no DOM, no network, no Astro.
 *
 * A ticket's subject, addresses and body are email, which an attacker writes. The pages render
 * them only as escaped plain text; this module is the second layer, which makes the characters
 * that hide or reorder text visible instead. The escape set is the CLI's (nemar-cli
 * `src/lib/display-name.ts`): controls, every format character, the line and paragraph
 * separators, and the invisible look-alikes that make two different strings look alike.
 *
 * A body keeps its newlines and tabs and, unlike a one-line field, keeps the direction marks
 * LRM, RLM and ALM: they are ordinary in right-to-left mail, they cannot reorder a run the way an
 * override can, and the body is rendered `dir="auto"`. A subject or an address is one line and
 * has no use for them, so there they are escaped.
 */

import { parseBackendTimestamp } from "./format";
import { IDEMPOTENCY_KEY_PATTERN, TEXT_MAX, type TicketStatus } from "./mail-admin-contract";

// Mirrors nemar-cli `src/lib/display-name.ts`, character for character: the C0 and C1 controls,
// every format character (category Cf: the direction marks, zero-width characters, the soft
// hyphen, invisible operators, the byte order mark, the bidirectional controls and the tag
// characters), the line and paragraph separators, and the invisible look-alikes outside Cf
// (the combining grapheme joiner, the Hangul fillers, the variation selectors).
const UNSAFE_CHARACTERS =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: each listed code point is matched on its own (the u flag), which is the intent: a combining joiner or selector is escaped, never joined.
  /[\p{Cc}\p{Cf}\u2028\u2029\u034f\u115f\u1160\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

/** What a body keeps besides ordinary text: newline, tab and the three implicit direction marks. */
const BODY_KEPT: ReadonlySet<string> = new Set(["\n", "\t", "\u200e", "\u200f", "\u061c"]);

function escapeCharacter(c: string): string {
  if (c === "\n") return "\\n";
  if (c === "\r") return "\\r";
  if (c === "\t") return "\\t";
  const code = c.codePointAt(0) ?? 0;
  if (code <= 0xff) return `\\x${code.toString(16).padStart(2, "0")}`;
  if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, "0")}`;
  return `\\u{${code.toString(16)}}`;
}

/** A subject, an address or any one-line field: every character in the set written out. */
export function displaySafeLine(text: string): string {
  return text.replace(UNSAFE_CHARACTERS, escapeCharacter);
}

/**
 * A message body: line endings normalized to `\n`, newlines and tabs kept, everything else in
 * the set written out except the three direction marks.
 */
export function displaySafeBody(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_CHARACTERS, (c) => (BODY_KEPT.has(c) ? c : escapeCharacter(c)));
}

// ---------------------------------------------------------------------------
// Thread and events
// ---------------------------------------------------------------------------

function time(value: string): number {
  const date = parseBackendTimestamp(value);
  // A row with no readable time sorts last rather than first: it is the odd one out.
  return date ? date.getTime() : Number.POSITIVE_INFINITY;
}

function oldestFirst<T extends { id: number; created_at: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = time(a.created_at);
    const tb = time(b.created_at);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id - b.id;
  });
}

/** A thread oldest first by time, then id. The API's order is not relied on. */
export const sortThread = oldestFirst;
export const sortEvents = oldestFirst;

export type Tone = "ok" | "warn" | "error" | "neutral";

/**
 * The tone of one authentication result (SPF, DKIM or DMARC). Only a pass is green: a value this
 * code has not seen is a warning, never quietly fine.
 */
export function authTone(value: string): Tone {
  switch (value.trim().toLowerCase()) {
    case "pass":
      return "ok";
    case "fail":
    case "permerror":
      return "error";
    case "":
    case "none":
      return "neutral";
    default:
      return "warn";
  }
}

const EVENT_DETAIL_MAX = 500;

/** An event's `detail` (any JSON the API recorded) as one safe line, at most 500 characters. */
export function eventDetailText(detail: unknown): string {
  if (detail === null || detail === undefined) return "";
  let text: string;
  if (typeof detail === "string") {
    text = detail;
  } else {
    try {
      text = JSON.stringify(detail) ?? "";
    } catch {
      return "";
    }
  }
  const safe = displaySafeLine(text);
  const chars = [...safe];
  return chars.length > EVENT_DETAIL_MAX
    ? `${chars.slice(0, EVENT_DETAIL_MAX - 1).join("")}…`
    : safe;
}

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  pending: "Pending",
  escalated: "Escalated",
  closed: "Closed",
  spam: "Spam",
};

export const STATUS_TONE: Record<TicketStatus, Tone> = {
  open: "warn",
  pending: "neutral",
  escalated: "error",
  closed: "ok",
  spam: "neutral",
};

// ---------------------------------------------------------------------------
// Reply draft
// ---------------------------------------------------------------------------

/** A fresh reply key. `web-` plus a UUID is 40 characters, inside the API's 1 to 64. */
export function newReplyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

/**
 * Where a reply draft stands. The key and the text travel together and never apart: a key is
 * what the API knows a reply by, so the SAME key must go with the SAME text on every attempt.
 *
 * - `idle`: editable, not sent.
 * - `sending`: a call is in flight; locked.
 * - `in_doubt`: the call failed in a way that leaves the outcome open (connection lost, timeout,
 *   5xx, still being sent). Locked, because editing the text would change what the key means.
 *   Trying again under the same key is safe.
 * - `unknown`: the API said the provider did not confirm the send. Locked and final for this key.
 *   Only {@link startOver} leaves it, with a new key and a warning that a second copy may go.
 */
export type DraftPhase = "idle" | "sending" | "in_doubt" | "unknown";

export interface ReplyDraft {
  readonly key: string;
  readonly text: string;
  readonly phase: DraftPhase;
}

export type ReplyFailureKind = "retry_same_key" | "key_released" | "outcome_unknown" | "refused";

export function newDraft(text = ""): ReplyDraft {
  return { key: newReplyKey(), text, phase: "idle" };
}

/** Whether the text can be edited and the key's meaning is therefore not yet fixed. */
export function isEditable(draft: ReplyDraft): boolean {
  return draft.phase === "idle";
}

/** A change of text, only while editable. */
export function edit(draft: ReplyDraft, text: string): ReplyDraft {
  return isEditable(draft) ? { ...draft, text } : draft;
}

/** Start (or retry) a send. From `sending` or `unknown` nothing starts. */
export function send(draft: ReplyDraft): ReplyDraft {
  return draft.phase === "idle" || draft.phase === "in_doubt"
    ? { ...draft, phase: "sending" }
    : draft;
}

/** The reply went out: a fresh, empty draft with a NEW key, since the old key now replays. */
export function success(): ReplyDraft {
  return newDraft();
}

/** What a failed call leaves behind. */
export function failure(draft: ReplyDraft, kind: ReplyFailureKind): ReplyDraft {
  switch (kind) {
    case "retry_same_key":
      return { ...draft, phase: "in_doubt" };
    case "outcome_unknown":
      return { ...draft, phase: "unknown" };
    case "key_released":
    case "refused":
      return { ...draft, phase: "idle" };
  }
}

/**
 * Abandon an unknown outcome and write again: a new key, the text kept so it can be reworded.
 * Only from `unknown`; the page puts a warning dialog in front, because the first reply may have
 * been delivered.
 */
export function startOver(draft: ReplyDraft): ReplyDraft {
  return draft.phase === "unknown"
    ? { key: newReplyKey(), text: draft.text, phase: "idle" }
    : draft;
}

export const DRAFT_STORAGE_PREFIX = "nemar:mail-reply:";

export function draftStorageKey(ticketId: number): string {
  return `${DRAFT_STORAGE_PREFIX}${ticketId}`;
}

/** Stored as JSON with a version, so a later shape can be told from this one. */
export function serializeDraft(draft: ReplyDraft): string {
  return JSON.stringify({ v: 1, key: draft.key, text: draft.text, phase: draft.phase });
}

const STORED_PHASES: ReadonlySet<string> = new Set(["idle", "sending", "in_doubt", "unknown"]);

/**
 * A stored draft, or null for anything that is not exactly one: bad JSON, a wrong shape, a key
 * the API would refuse, text longer than the API takes, an unknown phase. A draft saved in
 * `sending` comes back as `in_doubt`: the page was closed with a call in flight, which may have
 * arrived, and a retry under the same key is the safe answer to that.
 */
export function parseDraft(raw: string | null): ReplyDraft | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { v, key, text, phase } = value as Record<string, unknown>;
  if (v !== 1) return null;
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) return null;
  if (typeof text !== "string" || text.length > TEXT_MAX) return null;
  if (typeof phase !== "string" || !STORED_PHASES.has(phase)) return null;
  return { key, text, phase: phase === "sending" ? "in_doubt" : (phase as DraftPhase) };
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Storage can be missing or throw (a private window, blocked site data): every call is guarded. */
export function loadDraft(storage: DraftStorage | undefined, ticketId: number): ReplyDraft | null {
  try {
    return parseDraft(storage?.getItem(draftStorageKey(ticketId)) ?? null);
  } catch {
    return null;
  }
}

export function saveDraft(
  storage: DraftStorage | undefined,
  ticketId: number,
  draft: ReplyDraft,
): void {
  try {
    storage?.setItem(draftStorageKey(ticketId), serializeDraft(draft));
  } catch {
    // Nothing to do: the draft still lives in the page, and only a reload would lose it.
  }
}

export function clearDraft(storage: DraftStorage | undefined, ticketId: number): void {
  try {
    storage?.removeItem(draftStorageKey(ticketId));
  } catch {
    // As above.
  }
}

// ---------------------------------------------------------------------------
// Away window times (UTC)
// ---------------------------------------------------------------------------

/**
 * An away time as the `datetime-local` input wants it: `YYYY-MM-DDTHH:mm` in UTC. The Mail pages
 * label those inputs "(UTC)" and never use the browser's zone, so a window means the same thing
 * to every admin who reads it. Null for a missing or unreadable time.
 */
export function awayInputValue(instant: string | null): string {
  const date = parseBackendTimestamp(instant);
  return date ? date.toISOString().slice(0, 16) : "";
}

/**
 * The instant to send for a `datetime-local` value read as UTC, or null for an empty or
 * malformed one. A value with seconds keeps them.
 */
export function awayInstant(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) return `${trimmed}:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(trimmed)) return `${trimmed}Z`;
  return null;
}

/** `2026-10-20 09:00 UTC`, for showing the stored window. Empty for a missing time. */
export function formatUtc(instant: string | null): string {
  const date = parseBackendTimestamp(instant);
  return date ? `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC` : "";
}
