/**
 * The pure logic behind the administrator approval page's review panel (website#459,
 * nemar-cli#1731, Phase 4 of epic nemar-cli#1726).
 *
 * The page prints the API's own words: a reason's `statement` and neutral `cure`, the identifier
 * screen's headline and lines, the review's headline and the model's text under a label that says
 * the model wrote it. It never computes a verdict, never offers Approve for a reason no override
 * clears, and never prints the words the API words for a terminal. What it owns is below:
 *
 * - the wire types, as TRANSCRIPTIONS (each marked `transcribed from`) of nemar-cli
 *   `shared/contract/publication-review-admin.ts` and its Phase 4 additions. The repositories share
 *   no package, so a change there is a change here; the captured fixtures under
 *   `test/fixtures/publication-review/` are what notices. The types leave out, on purpose, every
 *   field a page must not print, so the compiler stops one from reaching the screen: the per-reason
 *   terminal wording, the description's lines and next step, the review's evidence and history;
 * - the state machine of the Approve control (`approveControl`), the body it sends
 *   (`approveBody`), the model the panel is drawn from (`panelModel`) and the chips of a list row
 *   (`rowChips`);
 * - the words for a failed call (`describeFailure`) and a started review (`describeStartSuccess`);
 * - the page-owned UI words, which have no CLI counterpart and so are not in the mirrored table.
 *
 * Pure: no network call, no DOM, no node module, nothing from the request context, so a browser
 * script can import it (`test/client-bundle-guard.test.ts`). Each of the 22 mirrored copy keys is
 * named below as a QUOTED LITERAL in a table or a call, because the consumer rule in
 * `publication-review-copy.test.ts` greps for exactly that; a template literal would hide it.
 */
import type { PublicationRequest } from "./admin-api";
import { PUBLICATION_REVIEW_COPY, type PublicationReviewCopyKey } from "./publication-review-copy";

/** One word of the mirrored table. */
const say = (key: PublicationReviewCopyKey): string => PUBLICATION_REVIEW_COPY[key];

// ---------------------------------------------------------------------------------------------
// Limits (comment-marked copies of nemar-cli `shared/publication-limits.ts`)
// ---------------------------------------------------------------------------------------------

/** Copy of nemar-cli `shared/publication-limits.ts`: the shortest acknowledgment reason. */
export const ACK_MIN = 10;
/** Copy of nemar-cli `shared/publication-limits.ts`: the longest acknowledgment reason. */
export const ACK_MAX = 500;
/** Copy of nemar-cli `shared/publication-limits.ts`: the longest denial reason. */
export const DENIAL_MAX = 2000;

// ---------------------------------------------------------------------------------------------
// Wire types (transcriptions)
// ---------------------------------------------------------------------------------------------

/** transcribed from `ReasonView.cleared_by` in the contract. */
export type ClearedBy = "nothing" | "screen_acknowledgment" | "override";
/** transcribed from the screen gate's words in nemar-cli `shared/identifier-screen-report.ts`. */
export type ScreenGate = "clear" | "blocks" | "acknowledge" | "rerun" | "wait";
/** The five gate words plus `exempt`, which a detail may carry and which imposes nothing. */
export type DetailScreenGate = ScreenGate | "exempt";
/** transcribed from the review gate's refusal words in nemar-cli `shared/publication-review.ts`. */
export type ReviewGateRefusal =
  | "hard_reason"
  | "needs_override"
  | "override_not_covering"
  | "review_changed"
  | "no_review_row"
  | "unverified";
/** The `gate` of a 409 identifier_screen_not_clear: the detail's refusal words plus two found at the click. */
export type ScreenGateRefusal =
  | "blocks"
  | "acknowledge"
  | "rerun"
  | "wait"
  | "stale"
  | "unverified";
/** transcribed from the `reason` of a started review in the contract. */
export type StartStartedReason = "dispatched" | "redispatched" | "dispatch_claimed";
/** The tone words a headline carries. */
export type Tone = "ok" | "note" | "warn" | "stop";

/** transcribed from `ReasonView` in the contract; no per-reason terminal wording is typed. */
export interface ReasonView {
  /** The 24 codes are nemar-cli's vocabulary; the page needs only the word. */
  readonly code: string;
  readonly class: "fail" | "unknown";
  readonly cleared_by: ClearedBy;
  /** Never printed. */
  readonly detail: string | null;
  /** Absent from a Worker that predates the page. */
  readonly statement?: string;
  readonly sentence: string;
  /** Neutral: it names no terminal. */
  readonly cure: string;
}

/** transcribed from `PublicationReviewRecord` in the contract, minus evidence, history and override. */
export interface PublicationReviewRecord {
  readonly id: number;
  /** The model's text. */
  readonly summary: string | null;
  readonly fact_notes: readonly { readonly text: string }[];
  /** `label` is the Worker's word for the finding; a Worker that predates the page omits it. */
  readonly findings: readonly {
    readonly label?: string;
    readonly document_label?: string | null;
    readonly note: string;
  }[];
}

/** transcribed from `PublicationReviewDetail` in the contract, plus the Phase 4 additions. */
export interface PublicationReviewDetail {
  readonly dataset_id: string;
  readonly request_id: number;
  readonly request_status: string;
  readonly anonymous: boolean;
  readonly applies: boolean;
  readonly gate: "enforced" | "off" | "n/a";
  readonly started_publishing: boolean;
  readonly block_reason: string | null;
  /** Phase 4; optional so an older Worker types honestly. */
  readonly start_offered?: boolean;
  /** Phase 4; optional so an older Worker types honestly. */
  readonly screen_gate?: DetailScreenGate;
  readonly identifier_screen: {
    readonly state: string | null;
    readonly headline: string;
    readonly tone: Tone;
    readonly lines: readonly string[];
  };
  readonly screen_acknowledgment: { readonly by: number; readonly at: string } | null;
  readonly reasons: readonly ReasonView[];
  /** The headline and tone only; the description's lines and next step are not typed. */
  readonly description: { readonly headline: string; readonly tone: Tone };
  readonly review: PublicationReviewRecord | null;
}

/** What `readFailure` extracts from a failed answer; every field but the status is optional. */
export interface ApiFailure {
  readonly status: number;
  /** The WORD, whichever convention carried it. */
  readonly code?: string;
  /** A sentence the Worker meant for a person. */
  readonly message?: string;
  readonly refusal?: string;
  readonly gate?: string;
  readonly headline?: string;
}

/** The body of an Approve click. The Worker's schema is strict, so no other key is ever sent. */
export interface ApproveBody {
  readonly request_id: number;
  readonly acknowledge_identifier_screen?: string;
  readonly override_publication_review?: {
    readonly review_id: number | null;
    readonly reasons: readonly string[];
  };
}

// ---------------------------------------------------------------------------------------------
// Page-owned words (not mirrored: no CLI counterpart)
// ---------------------------------------------------------------------------------------------

/** A Worker newer or older than this page: the reasons are not shown and Approve is not offered. */
export const OUT_OF_STEP =
  "This page and the API are out of step, so the review's reasons are not shown and Approve is not offered. Try again after the API is updated.";

/**
 * Shown when an override-class reason stands, there is no review row to attach the override to and
 * the Worker offers no start (an approving request that never started publishing). The mirrored
 * `gate.no_review_row` says to start the review, which is wrong here, so this line is the page's own.
 */
export const NO_START_LINE =
  "No review of this commit is on record and none can be started from this page, so Approve is not offered.";

/** Shown above the other withheld lines when a reason stands that no override clears. */
export const HARD_REASON_LINE =
  "A reason below cannot be approved over, so Approve is not offered.";

/** Headings, buttons and tags of the panel. */
export const UI_WORDS = {
  headings: {
    review: "Publication review",
    screen: "Identifier screen",
    reasons: "Reasons",
    checks: "What the platform's own checks found",
    summary: "Summary",
    notes: "Notes",
  },
  buttons: {
    show: "Show review",
    hide: "Hide review",
    loading: "Loading the review...",
    start: "Start review",
    refresh: "Refresh the review",
    approve: "Approve and publish",
    resume: "Continue approval",
    retry: "Retry approval",
  },
  classTags: {
    fail: "Failed",
    unknown: "Could not be established",
  },
  clearedTags: {
    nothing: "Cannot be approved over",
    screen_acknowledgment: "Needs a recorded reason",
    override: "Needs your confirmation to approve over it",
  },
} as const;

// ---------------------------------------------------------------------------------------------
// The literal-key tables (each key named as a quoted literal for the consumer rule)
// ---------------------------------------------------------------------------------------------

/** The copy key of each review-gate refusal word. */
export const GATE_REFUSAL_COPY: Record<ReviewGateRefusal, PublicationReviewCopyKey> = {
  hard_reason: "gate.hard_reason",
  needs_override: "gate.needs_override",
  override_not_covering: "gate.override_not_covering",
  review_changed: "gate.review_changed",
  no_review_row: "gate.no_review_row",
  unverified: "gate.unverified",
};

/** The copy key of each identifier-screen refusal word. */
export const SCREEN_GATE_COPY: Record<ScreenGateRefusal, PublicationReviewCopyKey> = {
  acknowledge: "screen_gate.acknowledge",
  blocks: "screen_gate.blocks",
  wait: "screen_gate.wait",
  rerun: "screen_gate.rerun",
  stale: "screen_gate.stale",
  unverified: "screen_gate.unverified",
};

/** The copy key of each reason a review start can answer with HTTP 202. */
export const START_STARTED_COPY: Record<StartStartedReason, PublicationReviewCopyKey> = {
  dispatched: "start.dispatched",
  redispatched: "start.redispatched",
  dispatch_claimed: "start.dispatch_claimed",
};

// ---------------------------------------------------------------------------------------------
// The approve control
// ---------------------------------------------------------------------------------------------

export type ApproveControl =
  | { readonly kind: "unavailable"; readonly text: string }
  | { readonly kind: "none"; readonly lines: readonly string[] }
  | { readonly kind: "withheld"; readonly lines: readonly string[] }
  | {
      readonly kind: "offered";
      readonly mode: "approve" | "resume";
      readonly dialogId: "admin-approve" | "admin-approve-anonymous" | "admin-resume";
      readonly requestId: number;
      readonly reviewId: number | null;
      /** Every override-class code of the detail shown, each once, in shown order; empty when none is needed. */
      readonly overrideReasons: readonly string[];
      readonly needsOverride: boolean;
      readonly needsAck: boolean;
      readonly notice: string | null;
    };

export type OfferedControl = Extract<ApproveControl, { readonly kind: "offered" }>;

/** What the row's own start says: the panel's row can approve, resume, or start nothing. */
export interface ControlContext {
  readonly rowStart: "approve" | "resume" | null;
}

const SCREEN_GATE_WORDS: readonly string[] = [
  "clear",
  "blocks",
  "acknowledge",
  "rerun",
  "wait",
  "exempt",
];

/**
 * A reason is hard unless the Worker says an override or a recorded acknowledgment clears it. A
 * word this page does not know is hard: the page never approves over what it cannot read.
 */
export function isHardReason(clearedBy: string): boolean {
  return clearedBy !== "override" && clearedBy !== "screen_acknowledgment";
}

/**
 * A detail the page can read: it carries the Phase 4 fields, every reason has its statement, and
 * the screen gate is a word the page knows. Anything else is a Worker out of step with the page.
 */
function isCurrentWorker(detail: PublicationReviewDetail): boolean {
  return (
    typeof detail.start_offered === "boolean" &&
    typeof detail.screen_gate === "string" &&
    SCREEN_GATE_WORDS.includes(detail.screen_gate) &&
    Array.isArray(detail.reasons) &&
    detail.reasons.every((r) => typeof r.statement === "string")
  );
}

/** Whether the Worker offers to start a review: its own word, never the page's reasoning. */
export function startOffered(detail: PublicationReviewDetail | null): boolean {
  return detail !== null && isCurrentWorker(detail) && detail.start_offered === true;
}

const withheld = (lines: readonly string[]): ApproveControl => ({ kind: "withheld", lines });

/**
 * What the Approve control offers for a detail, evaluated top to bottom; the first row that
 * applies decides, except that the two withheld rows (a hard reason, the screen gate) add their
 * lines together.
 */
export function approveControl(
  detail: PublicationReviewDetail | null,
  ctx: ControlContext,
): ApproveControl {
  if (detail === null) return { kind: "unavailable", text: say("approve.unavailable") };
  if (!isCurrentWorker(detail)) return { kind: "unavailable", text: OUT_OF_STEP };
  // Blocked comes before started: approve-dispatch refuses every blocked request, even a walked-back run.
  if (detail.request_status === "blocked") return withheld([say("approve.blocked")]);
  if (ctx.rowStart === null) return { kind: "none", lines: [] };

  const reviewId = detail.review?.id ?? null;
  if (detail.started_publishing) {
    // A run that has started publishing passed the gates when it started and passes none now.
    return {
      kind: "offered",
      mode: "resume",
      dialogId: "admin-resume",
      requestId: detail.request_id,
      reviewId,
      overrideReasons: [],
      needsOverride: false,
      needsAck: false,
      notice: say("approve.resume"),
    };
  }

  const lines: string[] = [];
  if (detail.reasons.some((r) => isHardReason(r.cleared_by))) lines.push(HARD_REASON_LINE);
  const gate = detail.screen_gate;
  if (gate === "blocks" || gate === "rerun" || gate === "wait") {
    lines.push(say(SCREEN_GATE_COPY[gate]));
  }
  if (lines.length > 0) return withheld(lines);

  const overrideReasons: string[] = [];
  for (const r of detail.reasons) {
    if (r.cleared_by === "override" && !overrideReasons.includes(r.code))
      overrideReasons.push(r.code);
  }
  const needsOverride = detail.gate === "enforced" && overrideReasons.length > 0;
  if (needsOverride && reviewId === null) {
    // The web path refuses an override with no review row to attach it to.
    return withheld([detail.start_offered === true ? say("gate.no_review_row") : NO_START_LINE]);
  }
  return {
    kind: "offered",
    mode: "approve",
    dialogId: detail.anonymous ? "admin-approve-anonymous" : "admin-approve",
    requestId: detail.request_id,
    reviewId,
    overrideReasons: needsOverride ? overrideReasons : [],
    needsOverride,
    needsAck: gate === "acknowledge",
    notice: null,
  };
}

export interface ApproveInput {
  readonly overrideConfirmed: boolean;
  readonly acknowledgment: string;
}

export type ApproveBodyResult =
  | { readonly ok: true; readonly body: ApproveBody }
  | {
      readonly ok: false;
      readonly problem:
        | "override_unconfirmed"
        | "acknowledgment_too_short"
        | "acknowledgment_too_long";
    };

/**
 * The body of an Approve click, built from the control the panel was drawn with so it names
 * exactly what the administrator was looking at. `request_id` is always there; a field nothing
 * asked for is never sent, because the Worker's schema is strict.
 */
export function approveBody(control: OfferedControl, input: ApproveInput): ApproveBodyResult {
  if (control.mode === "resume") return { ok: true, body: { request_id: control.requestId } };
  if (control.needsOverride && !input.overrideConfirmed) {
    return { ok: false, problem: "override_unconfirmed" };
  }
  let acknowledgment: string | undefined;
  if (control.needsAck) {
    const trimmed = input.acknowledgment.trim();
    if (trimmed.length < ACK_MIN) return { ok: false, problem: "acknowledgment_too_short" };
    if (trimmed.length > ACK_MAX) return { ok: false, problem: "acknowledgment_too_long" };
    acknowledgment = trimmed;
  }
  return {
    ok: true,
    body: {
      request_id: control.requestId,
      ...(acknowledgment === undefined ? {} : { acknowledge_identifier_screen: acknowledgment }),
      ...(control.needsOverride
        ? {
            override_publication_review: {
              review_id: control.reviewId,
              reasons: control.overrideReasons,
            },
          }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The panel model
// ---------------------------------------------------------------------------------------------

export interface PanelModel {
  readonly headline: { readonly text: string; readonly tone: Tone } | null;
  readonly screen: {
    readonly headline: string;
    readonly tone: Tone;
    readonly lines: readonly string[];
  } | null;
  /** Empty when the reasons are withheld. */
  readonly reasons: readonly {
    readonly statement: string;
    readonly cure: string;
    readonly classLabel: string;
    readonly clearedLabel: string;
  }[];
  /** The out-of-step words when the reasons are withheld. */
  readonly reasonsWithheld: string | null;
  readonly factNotes: readonly string[];
  readonly model: {
    readonly summaryLabel: string;
    readonly summary: string | null;
    readonly findingsLabel: string;
    readonly findings: readonly {
      readonly label: string;
      readonly documentLabel: string | null;
      readonly note: string;
    }[];
  } | null;
  readonly standing: string | null;
  readonly start: { readonly offered: boolean };
  readonly approve: ApproveControl;
  /** The label of the confirmation box, present exactly when the control needs the confirmation. */
  readonly overrideLabel: string | null;
  readonly ackPrompt: string | null;
}

const RANK: Record<string, number> = { nothing: 0, screen_acknowledgment: 1, override: 2 };
const rankOf = (clearedBy: string): number => RANK[clearedBy] ?? 0;

function clearedLabel(clearedBy: string): string {
  return clearedBy === "override"
    ? UI_WORDS.clearedTags.override
    : clearedBy === "screen_acknowledgment"
      ? UI_WORDS.clearedTags.screen_acknowledgment
      : UI_WORDS.clearedTags.nothing;
}

/**
 * Everything the script draws, as plain data it assigns with `textContent`. A detail the page
 * cannot read yields no headline, no screen, no reasons and no model text: only the control's
 * line and, when the Worker is out of step, the words that say so.
 */
export function panelModel(
  detail: PublicationReviewDetail | null,
  ctx: ControlContext,
): PanelModel {
  const approve = approveControl(detail, ctx);
  const empty: PanelModel = {
    headline: null,
    screen: null,
    reasons: [],
    reasonsWithheld: null,
    factNotes: [],
    model: null,
    standing: null,
    start: { offered: false },
    approve,
    overrideLabel: null,
    ackPrompt: null,
  };
  if (detail === null) return empty;
  if (!isCurrentWorker(detail)) return { ...empty, reasonsWithheld: OUT_OF_STEP };

  // Hard first, then a recorded acknowledgment, then an override; stable within a class.
  const reasons = detail.reasons
    .map((r, index) => ({ r, index }))
    .sort((a, b) => rankOf(a.r.cleared_by) - rankOf(b.r.cleared_by) || a.index - b.index)
    .map(({ r }) => ({
      statement: r.statement && r.statement.length > 0 ? r.statement : r.sentence,
      cure: r.cure,
      classLabel: r.class === "fail" ? UI_WORDS.classTags.fail : UI_WORDS.classTags.unknown,
      clearedLabel: clearedLabel(r.cleared_by),
    }));

  const review = detail.review;
  const summary = review?.summary ? review.summary : null;
  // A finding with no label comes from a Worker that predates the page: it is dropped with its note.
  const findings = (review?.findings ?? []).flatMap((f) =>
    typeof f.label === "string" && f.label.length > 0
      ? [{ label: f.label, documentLabel: f.document_label ?? null, note: f.note }]
      : [],
  );
  const model =
    summary === null && findings.length === 0
      ? null
      : {
          summaryLabel: `${UI_WORDS.headings.summary} (${say("review.model_summary_label")})`,
          summary,
          findingsLabel: `${UI_WORDS.headings.notes} (${say("review.model_findings_label")})`,
          findings,
        };

  return {
    headline: { text: detail.description.headline, tone: detail.description.tone },
    screen: {
      headline: detail.identifier_screen.headline,
      tone: detail.identifier_screen.tone,
      lines: detail.identifier_screen.lines,
    },
    reasons,
    reasonsWithheld: null,
    factNotes: (review?.fact_notes ?? []).map((n) => n.text),
    model,
    standing: detail.applies ? say("review.not_assessed") : null,
    start: { offered: startOffered(detail) },
    approve,
    overrideLabel:
      approve.kind === "offered" && approve.needsOverride ? say("approve.override_control") : null,
    ackPrompt:
      approve.kind === "offered" && approve.needsAck ? say("screen_gate.acknowledge") : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Chips of a list row
// ---------------------------------------------------------------------------------------------

export interface Chip {
  readonly text: string;
  readonly tone: Tone;
}

const TONES: readonly string[] = ["ok", "note", "warn", "stop"];
/** The detail route answers only for an active request, so a chip on a closed row is noise. */
const ACTIVE_STATUSES: readonly string[] = ["requested", "approving", "blocked"];

function chipOf(
  piece: { readonly headline?: string; readonly tone?: string } | undefined,
): Chip | null {
  if (!piece || typeof piece.headline !== "string" || piece.headline.length === 0) return null;
  const tone =
    piece.tone !== undefined && TONES.includes(piece.tone) ? (piece.tone as Tone) : "note";
  return { text: piece.headline, tone };
}

/** The review chip and the screen chip of a row: the Worker's headlines verbatim, decided by nothing. */
export function rowChips(request: PublicationRequest): {
  review: Chip | null;
  screen: Chip | null;
} {
  if (!ACTIVE_STATUSES.includes(request.status)) return { review: null, screen: null };
  return {
    review: chipOf(request.publication_review),
    screen: chipOf(request.identifier_screen),
  };
}

// ---------------------------------------------------------------------------------------------
// Failures and started reviews
// ---------------------------------------------------------------------------------------------

export type FailureOp = "approve" | "deny" | "start" | "detail";

/** What the page does with a failure: the words, and what to do about the panel. */
export interface FailureView {
  readonly text: string;
  /** Read the detail again: what the administrator saw may no longer be true. */
  readonly refetch: boolean;
  /** Untick the override box; the confirmation was given for a review that has moved. */
  readonly resetOverride: boolean;
  /** Put the focus in the reason field. */
  readonly focusAck: boolean;
  /** Offer the link that reloads the page. */
  readonly refreshLink: boolean;
}

/**
 * The page's own sentences for the codes of the approval and denial routes, moved here from the
 * page script. `not_dispatchable` is gone (the mirrored `approve.blocked` says it) and so is
 * `origin_not_allowed` (the Worker's own sentence is printed instead). They name no terminal.
 */
export const FRIENDLY_WORDS = {
  forbidden: "You no longer have admin access. Sign in again.",
  not_invitable: "This request is no longer pending.",
  already_in_flight:
    "An approval is already running for this dataset. Give it a minute, then refresh.",
  dispatch_failed:
    "GitHub did not accept the request, so nothing was started. Try again in a moment.",
  dispatch_unconfirmed:
    "GitHub did not confirm the request. It may have started, so check again in a few minutes before trying again.",
  dispatch_unconfigured:
    "The backend has no GitHub credential, so it cannot start an approval. Retrying will not help; tell an admin who manages the backend.",
  not_found: "Request not found.",
  missing_field: "Provide a reason for denial.",
  internal_error: "Server error. Try again in a moment.",
  invalid_body:
    "The approval could not be sent as built. Reload this page and try again; if it keeps happening, tell an admin who manages the backend.",
  deny_rejected:
    "The denial was not accepted. Give a reason of 1 to 2,000 characters and try again.",
  network: "Could not reach the server. Check your connection and try again.",
  approve_unconfirmed:
    "No answer came back, and the approval may have started. Refresh and check the request before trying again.",
  generic: "The action did not complete. Try again in a moment.",
} as const;

const NO_FLAGS = { refetch: false, resetOverride: false, focusAck: false, refreshLink: false };

const view = (text: string, flags: Partial<Omit<FailureView, "text">> = {}): FailureView => ({
  text,
  ...NO_FLAGS,
  ...flags,
});

const isOwn = (table: object, word: string | undefined): word is string =>
  word !== undefined && Object.hasOwn(table, word);

/**
 * What a thrown value says about the Worker's answer, or null when it did not come from one (a
 * dead connection, a missed deadline). `PublicationApiError` is recognized by its `failure`, so
 * this module needs nothing from the client; the older client error carries a status and a code.
 */
function failureOf(err: unknown): ApiFailure | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { failure?: unknown; status?: unknown; code?: unknown; name?: unknown };
  if (typeof e.failure === "object" && e.failure !== null) {
    const f = e.failure as { status?: unknown };
    if (typeof f.status === "number") return e.failure as ApiFailure;
  }
  if (e.name === "DashboardApiError" && typeof e.status === "number") {
    return { status: e.status, ...(typeof e.code === "string" ? { code: e.code } : {}) };
  }
  return null;
}

/** "Headline. Sentence": the Worker's headline, then the page's words, joined by one full stop. */
function withHeadline(headline: string | undefined, sentence: string): string {
  if (!headline) return sentence;
  return `${headline.replace(/[.\s]+$/, "")}. ${sentence}`;
}

const sentenceOr = (f: ApiFailure): string => f.message ?? FRIENDLY_WORDS.generic;

const isGateRefusal = (word: string | undefined): word is ReviewGateRefusal =>
  isOwn(GATE_REFUSAL_COPY, word);
const isScreenRefusal = (word: string | undefined): word is ScreenGateRefusal =>
  isOwn(SCREEN_GATE_COPY, word);

/** The page's words for a code, then a sentence-only 401 or 403, then the generic sentence. */
function common(f: ApiFailure): FailureView {
  if (isOwn(FRIENDLY_WORDS, f.code))
    return view(FRIENDLY_WORDS[f.code as keyof typeof FRIENDLY_WORDS]);
  if ((f.status === 401 || f.status === 403) && f.code === undefined && f.message) {
    return view(f.message);
  }
  return view(FRIENDLY_WORDS.generic);
}

/** The request is gone: the page's word for the code, or the Worker's sentence when it sent only that. */
function notFound(f: ApiFailure): FailureView {
  const text = f.code === undefined && f.message ? f.message : FRIENDLY_WORDS.not_found;
  return view(text, { refetch: true, refreshLink: true });
}

function describeApprove(f: ApiFailure): FailureView {
  if (f.status === 404) return notFound(f);
  switch (f.code) {
    case "publication_review_not_clear":
      return isGateRefusal(f.refusal)
        ? view(withHeadline(f.headline, say(GATE_REFUSAL_COPY[f.refusal])), {
            refetch: true,
            resetOverride: true,
          })
        : view(OUT_OF_STEP, { refetch: true, resetOverride: true });
    case "identifier_screen_not_clear":
      return isScreenRefusal(f.gate)
        ? view(withHeadline(f.headline, say(SCREEN_GATE_COPY[f.gate])), {
            refetch: true,
            focusAck: f.gate === "acknowledge",
          })
        : view(OUT_OF_STEP, { refetch: true });
    case "not_dispatchable":
      return view(say("approve.blocked"), { refetch: true });
    case "already_in_flight":
      return view(FRIENDLY_WORDS.already_in_flight, { refreshLink: true });
    case "request_mismatch":
      return view(sentenceOr(f), { refetch: true });
    case "invalid_dataset_id":
      return view(sentenceOr(f));
    case "dispatch_failed":
    case "dispatch_unconfirmed":
    case "dispatch_unconfigured":
      return view(FRIENDLY_WORDS[f.code], { refreshLink: true });
    default:
      return common(f);
  }
}

function describeDeny(f: ApiFailure): FailureView {
  if (f.status === 404) return notFound(f);
  switch (f.code) {
    case "request_mismatch":
    case "deny_after_publishing":
    case "approval_in_flight":
      return view(sentenceOr(f), { refetch: true, refreshLink: true });
    default:
      // The route's validation failure names no code the page can read.
      return f.status === 400 && f.code === undefined
        ? view(FRIENDLY_WORDS.deny_rejected)
        : common(f);
  }
}

/** The review start's own words: its `error` sentence, web-safe and pinned, never the approval's map. */
const START_MESSAGE_CODES: readonly string[] = [
  "review_disabled",
  "not_applicable",
  "not_owned_here",
  "request_not_requested",
  "screen_not_ready",
  "running",
  "has_result",
  "platform_limit",
  "dispatch_failed",
  "dispatch_unconfigured",
  "not_found",
];

function describeStart(f: ApiFailure): FailureView {
  if (f.code !== undefined && START_MESSAGE_CODES.includes(f.code)) {
    return view(sentenceOr(f), { refetch: true });
  }
  if (f.code === "bad_dataset" || f.code === "internal") return view(sentenceOr(f));
  return common(f);
}

function describeDetail(f: ApiFailure): FailureView {
  const sentence =
    f.message &&
    (f.status === 404 || ((f.status === 401 || f.status === 403) && f.code === undefined))
      ? f.message
      : f.code === "forbidden"
        ? FRIENDLY_WORDS.forbidden
        : null;
  const unavailable = say("approve.unavailable");
  return view(sentence === null ? unavailable : `${sentence} ${unavailable}`);
}

/**
 * The words and the follow-up for a failed call. A value that is not the Worker's answer (a dead
 * connection, a missed deadline) is the network sentence, except for an approve, which may have
 * started and says so. The order is: the proxy's own failures,
 * the origin guard's sentence, then the operation's own table. A gate or screen refusal prints the
 * mirrored copy, never the Worker's message, which words a terminal.
 */
export function describeFailure(op: FailureOp, err: unknown): FailureView {
  const f = failureOf(err);
  if (f === null) {
    // A missed deadline can follow a dispatch that went out: the Worker's lease makes a retry a
    // safe 409, but the administrator should look first.
    return op === "approve"
      ? view(FRIENDLY_WORDS.approve_unconfirmed, { refetch: true, refreshLink: true })
      : view(FRIENDLY_WORDS.network);
  }
  if (f.status === 502 && (f.code === "upstream_unreachable" || f.code === "upstream_redirect")) {
    return view(FRIENDLY_WORDS.network);
  }
  if (f.code === "origin_not_allowed") return view(sentenceOr(f));
  switch (op) {
    case "approve":
      return describeApprove(f);
    case "deny":
      return describeDeny(f);
    case "start":
      return describeStart(f);
    case "detail":
      return describeDetail(f);
  }
}

/** The words for a review start that went (HTTP 202); null for a reason this page does not know. */
export function describeStartSuccess(body: { readonly reason: string }): string | null {
  return isOwn(START_STARTED_COPY, body.reason)
    ? say(START_STARTED_COPY[body.reason as StartStartedReason])
    : null;
}
