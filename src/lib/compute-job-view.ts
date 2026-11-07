/**
 * Pure view models for the job page `/compute/jobs/<id>` (website ADR 0030 phase E3, issue #496). The
 * server template, the browser script and the tests read one place. Nothing here decides what a state
 * MEANS (the backend does); it decides what the page shows for each state it was told, and it claims
 * only what the record carries: three times (created, started, ended), no per-stage times
 * (nemar-cli#2097), no results expiry (nemar-cli#2096), no log tail (nemar-cli#2094), result links that
 * download rather than render (nemar-cli#2095).
 *
 * Rules every function keeps:
 *  - A backend string passes through `displaySafeLine` and is rendered as a text node by the callers.
 *  - A state outside the closed ten is shown as its escaped word and nothing else.
 *  - No function reads a clock: `nowMs` and the random number are arguments.
 */
import { ACCOUNT_COPY } from "./account-copy";
import {
  ComputeApiError,
  type ComputeCancel,
  type ComputeJobRead,
  type ComputeResultFile,
} from "./compute-api";
import { type JobBadge, jobBadge, sourceLabel } from "./compute-badges";
import {
  COMPUTE_CANCEL_OUTCOMES,
  isComputeJobState,
  isTerminalComputeState,
} from "./compute-contract";
import { JOB_COPY } from "./compute-copy";
import { type FailureView, failureView } from "./compute-failure";
import {
  dbTimeToIso,
  formatDuration,
  formatEpochUtcMinute,
  formatUtcMinute,
  formatUtcSecond,
  parseDbTime,
} from "./compute-format";
import { COMPUTE_LABELS } from "./compute-labels";
import { chargeText } from "./compute-view";
import { formatBytes } from "./format";
import { displaySafeLine } from "./mail-display";
import type { IconName } from "./status-icons";

const DAY_MS = 86_400_000;

// --- State ---------------------------------------------------------------------------------------

/** A known, ended state: the record will not change again. */
export function isTerminal(state: string): boolean {
  return isComputeJobState(state) && isTerminalComputeState(state);
}

/** A known state that has not ended: the page keeps asking. An unknown state is neither. */
export function isLive(state: string): boolean {
  return isComputeJobState(state) && !isTerminalComputeState(state);
}

/**
 * Whether the page offers Cancel. The route refuses nothing by state (an ended job answers 200
 * `already_ended`), so this is the PAGE's own choice: a known live state, with no cancel already
 * recorded. Every front door is offered it, partner included; the backend resolves the intent.
 */
export function canCancel(job: { state: string; cancel_requested: boolean }): boolean {
  return isLive(job.state) && !job.cancel_requested;
}

// --- Timeline ------------------------------------------------------------------------------------

export type StepStatus = "passed" | "current" | "pending" | "unknown";

export interface StepTime {
  readonly label: string | null;
  readonly text: string;
  readonly iso: string | null;
  readonly title: string;
}

export interface TimelineStep {
  readonly key: "created" | "submitted" | "queued" | "running" | "archiving" | "terminal";
  readonly label: string;
  readonly status: StepStatus;
  readonly statusWord: string;
  readonly icon: IconName;
  readonly time: StepTime | null;
}

export interface TimelineView {
  readonly steps: readonly TimelineStep[];
  /** The escaped raw word of a state this build does not know; the timeline is then empty. */
  readonly unknownState: string | null;
  readonly unreported: boolean;
}

const LIVE_INDEX: Readonly<Record<string, number>> = {
  created: 0,
  uploading: 0,
  submitted: 1,
  queued: 2,
  running: 3,
  archiving: 4,
};

const STEP_KEYS = ["created", "submitted", "queued", "running", "archiving"] as const;

const STATUS_ICON: Readonly<Record<StepStatus, IconName>> = {
  passed: "ok",
  current: "progress",
  pending: "neutral",
  unknown: "flat",
};

function stepTime(value: string | null, label: string | null): StepTime | null {
  if (value === null) return null;
  return {
    label,
    text: formatUtcMinute(value),
    iso: dbTimeToIso(value),
    title: formatUtcSecond(value),
  };
}

const STATE_LABEL = (state: string): string =>
  isComputeJobState(state) ? jobBadge(state).label : displaySafeLine(state);

/**
 * The line of stages for a job. It claims only what is known: the record has three times, and Tapis may
 * skip states, so a stage the record cannot vouch for reads "not known", never "done".
 */
export function timeline(job: {
  state: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}): TimelineView {
  if (!isComputeJobState(job.state)) {
    return { steps: [], unknownState: displaySafeLine(job.state), unreported: false };
  }
  const state = job.state;
  const started = job.started_at !== null;
  const terminal = isTerminalComputeState(state);
  const statuses: StepStatus[] = [];
  let terminalStatus: StepStatus;
  if (Object.hasOwn(LIVE_INDEX, state)) {
    const at = LIVE_INDEX[state];
    for (let i = 0; i < STEP_KEYS.length; i++) {
      statuses.push(i < at ? "passed" : i === at ? "current" : "pending");
    }
    terminalStatus = "pending";
  } else if (state === "unreported") {
    // A side state with no place on the line: through Running only if it started, else only Created.
    for (let i = 0; i < STEP_KEYS.length; i++) {
      statuses.push(i === 0 || (started && i <= 3) ? "passed" : "unknown");
    }
    terminalStatus = "unknown";
  } else if (state === "finished") {
    for (let i = 0; i < STEP_KEYS.length; i++) statuses.push("passed");
    terminalStatus = "current";
  } else {
    // failed or cancelled: Archiving is never claimed.
    for (let i = 0; i < STEP_KEYS.length; i++) {
      statuses.push(i === 0 ? "passed" : i <= 3 && started ? "passed" : "unknown");
    }
    terminalStatus = "current";
  }
  const stateLabel = STATE_LABEL(state);
  const steps: TimelineStep[] = STEP_KEYS.map((key, i) => {
    const status = statuses[i];
    const label =
      key === "created" && state === "uploading" ? STATE_LABEL("uploading") : STATE_LABEL(key);
    let time: StepTime | null = null;
    if (status === "passed" || status === "current") {
      if (key === "created") time = stepTime(job.created_at, null);
      else if (key === "running") time = stepTime(job.started_at, JOB_COPY.timeline.started);
    }
    return {
      key,
      label,
      status,
      statusWord: JOB_COPY.timeline.stepWord[status],
      icon: STATUS_ICON[status],
      time,
    };
  });
  steps.push({
    key: "terminal",
    label: terminal ? stateLabel : JOB_COPY.timeline.ended,
    status: terminalStatus,
    statusWord: JOB_COPY.timeline.stepWord[terminalStatus],
    icon: terminal
      ? state === "finished"
        ? "ok"
        : state === "failed"
          ? "error"
          : "neutral"
      : STATUS_ICON[terminalStatus],
    time: terminal ? stepTime(job.ended_at, null) : null,
  });
  return { steps, unknownState: null, unreported: state === "unreported" };
}

// --- The whole page ------------------------------------------------------------------------------

export interface DetailRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Set for a time: the machine value and the tooltip. */
  readonly time?: { readonly iso: string | null; readonly title: string };
}

export interface JobDetailView {
  readonly id: string;
  /** A name the job was given (not served today, nemar-cli#2079); escaped. */
  readonly title: string | null;
  readonly badge: JobBadge;
  /** The state word, escaped. */
  readonly state: string;
  readonly known: boolean;
  readonly live: boolean;
  readonly terminal: boolean;
  /** True only for a live job with a cancel on record. */
  readonly cancelRequested: boolean;
  readonly canCancel: boolean;
  readonly stale: boolean;
  readonly app: string;
  readonly appVersion: string;
  readonly frontDoor: string;
  readonly timeline: TimelineView;
  readonly rows: readonly DetailRow[];
  readonly charge: { readonly text: string; readonly kind: "terminal" | "live" | "unknown" };
  readonly failure: FailureView | null;
  readonly unreportedNote: string | null;
  readonly unitsNote: string;
}

function poolLabel(pool: string): string {
  return Object.hasOwn(COMPUTE_LABELS.pools, pool)
    ? COMPUTE_LABELS.pools[pool as "cpu" | "gpu"]
    : displaySafeLine(pool);
}

export function jobDetailView(read: ComputeJobRead): JobDetailView {
  const { job } = read;
  const R = JOB_COPY.rows;
  const known = isComputeJobState(job.state);
  const live = isLive(job.state);
  const terminal = isTerminal(job.state);
  const charge = chargeText(job);
  const rows: DetailRow[] = [
    {
      key: "partition",
      label: R.partition,
      value: `${displaySafeLine(job.partition)} (${poolLabel(job.pool)})`,
    },
    { key: "nodes", label: R.nodes, value: String(job.resources.nodes) },
    { key: "cores", label: R.cores, value: String(job.resources.cores_per_node) },
  ];
  if (job.resources.gpus > 0) {
    rows.push({ key: "gpus", label: R.gpus, value: String(job.resources.gpus) });
  }
  if (job.resources.memory_mb !== null) {
    rows.push({
      key: "memory",
      label: R.memory,
      value: `${job.resources.memory_mb.toLocaleString("en-US")} MB`,
    });
  }
  rows.push({
    key: "runtime",
    label: R.runTime,
    value: `${R.upTo} ${formatDuration(job.resources.minutes * 60)}`,
  });
  const timed = (key: string, label: string, value: string | null): void => {
    if (value === null) return;
    rows.push({
      key,
      label,
      value: formatUtcMinute(value),
      time: { iso: dbTimeToIso(value), title: formatUtcSecond(value) },
    });
  };
  timed("created", R.created, job.created_at);
  timed("started", R.started, job.started_at);
  timed("ended", R.ended, job.ended_at);
  return {
    id: displaySafeLine(job.id),
    title: job.name === null ? null : displaySafeLine(job.name),
    badge: jobBadge(job.state),
    state: displaySafeLine(job.state),
    known,
    live,
    terminal,
    cancelRequested: job.cancel_requested && live,
    canCancel: canCancel(job),
    stale: read.stale,
    app: displaySafeLine(job.app_id),
    appVersion: displaySafeLine(job.app_version),
    frontDoor: sourceLabel(job.source),
    timeline: timeline(job),
    rows,
    charge,
    failure: job.failure_code === null ? null : failureView(job.failure_code, job.id),
    unreportedNote:
      job.state === "unreported" ? ACCOUNT_COPY["compute_page.unreported_note"] : null,
    unitsNote: ACCOUNT_COPY["compute_page.units_note"],
  };
}

// --- Results retention ---------------------------------------------------------------------------

/** Three days or fewer left counts as "expiring"; website-owned. */
export const RESULTS_EXPIRING_DAYS = 3;

export type ResultsState = "not_ready" | "none" | "available" | "expiring" | "expired";

export interface ResultsWindow {
  readonly state: ResultsState;
  readonly untilMs: number | null;
  readonly untilText: string | null;
  readonly untilIso: string | null;
  readonly daysLeft: number | null;
  readonly days: number | null;
}

/**
 * Where a job's results stand, DERIVED from `ended_at` and `limits.results_days` until the server states
 * a date (nemar-cli#2096). The rule is the backend's own (`resultsRetentionPassed`): expired once
 * `now > ended_at + days`, so the instant itself is still available. The 410 stays authoritative: the
 * page keeps its button in `expired` and lets the backend decide.
 */
export function resultsWindow(input: {
  state: string;
  endedAt: string | null;
  resultsDays: number | null;
  nowMs: number;
}): ResultsWindow {
  const none = (state: ResultsState, days: number | null = null): ResultsWindow => ({
    state,
    untilMs: null,
    untilText: null,
    untilIso: null,
    daysLeft: null,
    days,
  });
  if (input.state === "failed" || input.state === "cancelled") return none("none");
  if (input.state !== "finished") return none("not_ready");
  const ended = input.endedAt === null ? null : parseDbTime(input.endedAt);
  if (ended === null || input.resultsDays === null) return none("available", input.resultsDays);
  const untilMs = ended + input.resultsDays * DAY_MS;
  const left = untilMs - input.nowMs;
  const state: ResultsState =
    left < 0 ? "expired" : left <= RESULTS_EXPIRING_DAYS * DAY_MS ? "expiring" : "available";
  return {
    state,
    untilMs,
    untilText: formatEpochUtcMinute(untilMs),
    untilIso: new Date(untilMs).toISOString(),
    daysLeft: left < 0 ? 0 : Math.ceil(left / DAY_MS),
    days: input.resultsDays,
  };
}

export interface ResultsPanelView {
  readonly window: ResultsWindow;
  readonly headline: string;
  /** Whether the "Get download links" button shows. It stays in `expired`: the 410 decides. */
  readonly canGetLinks: boolean;
}

export function resultsPanelView(input: {
  state: string;
  endedAt: string | null;
  resultsDays: number | null;
  nowMs: number;
}): ResultsPanelView {
  const w = resultsWindow(input);
  const C = JOB_COPY.results;
  let headline: string;
  switch (w.state) {
    case "not_ready":
      headline = C.notReady;
      break;
    case "none":
      headline = C.none;
      break;
    case "expired":
      headline = C.expiredDerived(w.days ?? 0);
      break;
    case "expiring":
      headline = C.expiring(w.daysLeft ?? 0, w.untilText ?? "");
      break;
    default:
      headline =
        w.untilText === null || w.days === null ? C.keptLimited : C.kept(w.days, w.untilText);
  }
  return { window: w, headline, canGetLinks: input.state === "finished" };
}

// --- Failures of the log, the results and the cancel ---------------------------------------------

export interface FailureNotice {
  readonly kind: "none" | "expired" | "not_ready" | "not_found" | "session" | "account" | "message";
  readonly sentence: string;
}

function transport(err: unknown): FailureNotice {
  const n = COMPUTE_LABELS.notice;
  if (err instanceof ComputeApiError) {
    if (err.code === "job_not_found") return { kind: "not_found", sentence: JOB_COPY.notFoundBody };
    if (err.kind === "session") return { kind: "session", sentence: JOB_COPY.live.sessionEnded };
    if (err.kind === "account") return { kind: "account", sentence: n.account };
    const reason = n[err.kind === "rejected" ? "rejected" : err.kind];
    return {
      kind: "message",
      sentence: err.sentence ? `${reason} ${displaySafeLine(err.sentence)}` : reason,
    };
  }
  return { kind: "message", sentence: n.shape };
}

/** What the results panel says for a failed links call. A 410 is the expired state; a 409 means no files. */
export function resultsFailure(
  err: unknown,
  resultsDays: number | null,
  source = "",
): FailureNotice {
  if (err instanceof ComputeApiError) {
    if (err.code === "results_expired") {
      return { kind: "expired", sentence: JOB_COPY.results.expired410(resultsDays) };
    }
    if (err.code === "bad_state") {
      // A partner job's files are the person's only once NEMAR has checked the job; say so, as the log does.
      const sentence =
        source === "partner" ? JOB_COPY.results.badStatePartner : JOB_COPY.results.badState;
      return { kind: "not_ready", sentence };
    }
  }
  return transport(err);
}

/** What the log panel says for a failed log call. */
export function logFailure(err: unknown, source: string): FailureNotice {
  if (err instanceof ComputeApiError) {
    if (err.code === "logs_not_available") {
      return {
        kind: "none",
        sentence: source === "partner" ? JOB_COPY.logs.nonePartner : JOB_COPY.logs.none,
      };
    }
    if (err.code === "storage_unavailable") {
      return { kind: "message", sentence: JOB_COPY.logs.unavailable };
    }
  }
  return transport(err);
}

// --- Result rows ---------------------------------------------------------------------------------

/** Rows shown at first and added by each "Show more". */
export const RESULT_ROWS_STEP = 100;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The only way a result address reaches an `href`: `https:`, or `http:` on a loopback host (the local
 * backend's object store, for the browser check). `javascript:`, `data:` and anything else render no
 * link.
 */
export function safeResultHref(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === "https:") return parsed.href;
  if (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname)) return parsed.href;
  return null;
}

export interface ResultRow {
  readonly path: string;
  readonly size: string;
  readonly shaShort: string;
  readonly sha: string;
  /** Null renders "link unavailable". */
  readonly href: string | null;
}

export function resultRow(file: ComputeResultFile): ResultRow {
  return {
    path: displaySafeLine(file.path),
    size: formatBytes(file.size),
    shaShort: displaySafeLine(file.sha256.slice(0, 12)),
    sha: displaySafeLine(file.sha256),
    href: safeResultHref(file.url),
  };
}

export interface ResultsPaging {
  /** How many more rows the next "Show more" adds from the page already held. */
  readonly showMore: number;
  /** Files beyond the held page that another call would fetch; null when there is nothing more. */
  readonly nextPageRemaining: number | null;
}

/**
 * What the list offers after `shown` of `held` rows are visible. The held page is up to 1,000 files;
 * only when it is used up and the backend gave a cursor is a next call offered.
 */
export function resultsPaging(p: {
  held: number;
  shown: number;
  offset: number;
  total: number;
  nextAfter: string | null;
}): ResultsPaging {
  const showMore = Math.max(0, Math.min(RESULT_ROWS_STEP, p.held - p.shown));
  const remaining = p.total - (p.offset + p.held);
  return {
    showMore,
    nextPageRemaining: showMore === 0 && p.nextAfter !== null && remaining > 0 ? remaining : null,
  };
}

/** True once the links' own expiry has passed; an unreadable date counts as expired (never keep a link we cannot date). */
export function linksExpired(expiresAtIso: string, nowMs: number): boolean {
  const at = Date.parse(expiresAtIso);
  return Number.isNaN(at) || at <= nowMs;
}

/** Whether the links outlive the files (a link minted late): the retention date is before the link expiry. */
export function linksOutliveFiles(expiresAtIso: string, untilMs: number | null): boolean {
  const at = Date.parse(expiresAtIso);
  return untilMs !== null && !Number.isNaN(at) && at > untilMs;
}

// --- Cancel --------------------------------------------------------------------------------------

export interface CancelOutcomeView {
  readonly kind: "recorded" | "canceled" | "already_recorded" | "ended" | "unknown";
  readonly sentence: string;
  /** The job is always read again: the answer may have changed its state. */
  readonly refresh: true;
  /** Keep polling for the cluster to carry it out. */
  readonly poll: boolean;
}

/**
 * The words for the backend's cancel answer. The codes are the backend's; the sentences are the page's
 * and promise nothing about a charge beyond what the dialog already said and the refreshed record shows.
 */
export function cancelOutcome(answer: ComputeCancel): CancelOutcomeView {
  const C = JOB_COPY.cancel;
  const known = (COMPUTE_CANCEL_OUTCOMES as readonly string[]).includes(answer.outcome);
  const ended = answer.outcome === "already_ended" || answer.cancelled === false;
  if (ended) {
    const state = answer.state === null ? "unknown" : STATE_LABEL(answer.state).toLowerCase();
    return { kind: "ended", sentence: C.ended(state), refresh: true, poll: false };
  }
  if (!known) return { kind: "unknown", sentence: C.unknown, refresh: true, poll: true };
  if (answer.state === "cancelled") {
    return { kind: "canceled", sentence: C.canceled, refresh: true, poll: false };
  }
  if (answer.outcome === "already_cancelled") {
    return { kind: "already_recorded", sentence: C.alreadyRecorded, refresh: true, poll: true };
  }
  return { kind: "recorded", sentence: C.recorded, refresh: true, poll: true };
}

// --- Polling -------------------------------------------------------------------------------------

export const POLL_BASE_MS = 10_000;
export const POLL_MAX_MS = 60_000;
export const POLL_ERROR_LIMIT = 5;
export const POLL_HARD_STOP_MS = 2 * 3_600_000;
export const POLL_JITTER = 0.15;
/** On becoming visible, a read older than this is refreshed at once. */
export const POLL_STALE_AFTER_MS = 5_000;

export type StopReason =
  | "terminal"
  | "unknown_state"
  | "errors"
  | "hard_stop"
  | "session"
  | "not_found";

export interface PollState {
  /** The un-jittered delay last scheduled. */
  readonly delayMs: number;
  readonly errors: number;
  /** When the page loaded (or Resume was pressed). */
  readonly sinceMs: number;
  readonly stopped: StopReason | null;
}

export function initialPoll(nowMs: number): PollState {
  return { delayMs: POLL_BASE_MS, errors: 0, sinceMs: nowMs, stopped: null };
}

export type PollEvent =
  | { readonly kind: "read"; readonly state: string; readonly changed: boolean }
  | { readonly kind: "error"; readonly fatal?: "session" | "not_found" }
  | { readonly kind: "hidden" }
  | { readonly kind: "visible"; readonly sinceLastReadMs: number };

export type PollStep =
  | { readonly action: "wait"; readonly delayMs: number }
  | { readonly action: "refresh_now" }
  | { readonly action: "pause" }
  | { readonly action: "stop"; readonly reason: StopReason };

const jitter = (base: number, random: number): number =>
  Math.round(base * (1 + (random * 2 - 1) * POLL_JITTER));

/**
 * The poller's whole schedule, pure (the browser module only holds the timer and the abort controller).
 * The first read comes `POLL_BASE_MS` after load; an unchanged answer doubles the delay up to
 * `POLL_MAX_MS` (the backend refreshes a live job from the cluster at most once a minute, so asking
 * faster adds load and no freshness) and a changed one resets it; an error doubles it too, and the fifth
 * in a row stops; a terminal or unknown state, a 401, a not-found and the two-hour mark stop for good;
 * a hidden tab pauses and a visible one refreshes at once if the last read is stale. `random` is in
 * [0, 1) and moves each delay by at most 15 percent. Once stopped it stays stopped.
 */
export function nextPoll(
  prev: PollState,
  event: PollEvent,
  nowMs: number,
  random = 0.5,
): { step: PollStep; next: PollState } {
  const stop = (reason: StopReason): { step: PollStep; next: PollState } => ({
    step: { action: "stop", reason },
    next: { ...prev, stopped: prev.stopped ?? reason },
  });
  if (prev.stopped !== null) return { step: { action: "stop", reason: prev.stopped }, next: prev };
  if (nowMs - prev.sinceMs >= POLL_HARD_STOP_MS) return stop("hard_stop");
  switch (event.kind) {
    case "hidden":
      return { step: { action: "pause" }, next: prev };
    case "visible": {
      const next = { ...prev, delayMs: POLL_BASE_MS };
      return event.sinceLastReadMs > POLL_STALE_AFTER_MS
        ? { step: { action: "refresh_now" }, next }
        : { step: { action: "wait", delayMs: jitter(POLL_BASE_MS, random) }, next };
    }
    case "error": {
      if (event.fatal) return stop(event.fatal);
      const errors = prev.errors + 1;
      if (errors >= POLL_ERROR_LIMIT)
        return { ...stop("errors"), next: { ...prev, errors, stopped: "errors" } };
      const base = Math.min(prev.delayMs * 2, POLL_MAX_MS);
      return {
        step: { action: "wait", delayMs: jitter(base, random) },
        next: { ...prev, errors, delayMs: base },
      };
    }
    case "read": {
      if (!isComputeJobState(event.state)) return stop("unknown_state");
      if (isTerminalComputeState(event.state)) return stop("terminal");
      const base = event.changed ? POLL_BASE_MS : Math.min(prev.delayMs * 2, POLL_MAX_MS);
      return {
        step: { action: "wait", delayMs: jitter(base, random) },
        next: { ...prev, errors: 0, delayMs: base },
      };
    }
  }
}
