/**
 * Pure view models for the admin Compute tab (website ADR 0030; epic nemarOrg/website#493 phase
 * E4, issue #497). No DOM, no network, no Astro: every rule the page applies to what the backend
 * served is here so it is tested, and the page only lays the result out.
 *
 * Three rules hold throughout:
 *
 *  - Nothing is computed that the backend did not serve. Every figure is printed from a served
 *    integer with {@link formatSu}; a row's buttons mirror the state machine but the backend
 *    still decides.
 *  - Every string that came from outside (a name, a purpose, a country, an affiliation, a
 *    username, an ORCID string, an email, a failure detail, a Slurm id) goes through
 *    `displaySafeLine` or `displaySafeBody` (website ADR 0029), so a character that hides or
 *    reorders text is written out and the page renders the result as a text node.
 *  - Every sentence comes from `ACCOUNT_COPY` (the `compute_admin.` keys transcribed from
 *    nemar-cli) or from the backend's own `error`. A fixed word the API sends that this build has
 *    no copy for is printed as the word.
 */

import { ACCOUNT_COPY, fillCopy } from "./account-copy";
import { type BadgeTone, badgeIcon } from "./admin-badges";
import { isValidOrcid } from "./auth";
import {
  type ComputeAccessRow,
  type ComputeDecisionResult,
  type ComputeJobRow,
  type ComputePoolRow,
  type ComputeRequestsCount,
  type ComputeUnmatchedRow,
  type DecisionFailure,
  computeAdminErrorText,
  isJobFlag,
  isListedState,
} from "./compute-admin-api";
import {
  COMPUTE_ACCESS_DECISIONS,
  COMPUTE_ACCESS_TRANSITIONS,
  COMPUTE_DECISION_TARGET,
  COMPUTE_JOB_FLAGS,
  type ComputeAccessDecision,
  type ComputeJobFlag,
} from "./compute-admin-contract";
import { formatSu } from "./compute-format";
import { formatDate, formatRelativeTime, parseBackendTimestamp } from "./format";
import { displaySafeBody, displaySafeLine } from "./mail-display";
import type { IconName } from "./status-icons";

// ---------------------------------------------------------------------------
// Views and query parameters
// ---------------------------------------------------------------------------

export const COMPUTE_VIEWS = ["requests", "pools", "usage", "flagged", "drift"] as const;
export type ComputeView = (typeof COMPUTE_VIEWS)[number];

/** Unknown or missing is the default view. */
export function parseView(raw: string | null | undefined): ComputeView {
  return (COMPUTE_VIEWS as readonly string[]).includes(raw ?? "")
    ? (raw as ComputeView)
    : "requests";
}

export const REQUEST_FILTERS = [
  "requested",
  "active",
  "suspended",
  "denied",
  "revoked",
  "all",
] as const;
export type RequestFilter = (typeof REQUEST_FILTERS)[number];

/** The requests view's chip: unknown or missing is the open queue. */
export function parseRequestFilter(raw: string | null | undefined): RequestFilter {
  return (REQUEST_FILTERS as readonly string[]).includes(raw ?? "")
    ? (raw as RequestFilter)
    : "requested";
}

/** The flagged view's chip: unknown or missing is `unreserved`. */
export function parseFlag(raw: string | null | undefined): ComputeJobFlag {
  return isJobFlag(raw ?? "") ? (raw as ComputeJobFlag) : "unreserved";
}

/** A cursor: a positive safe integer, written in digits. Anything else is ignored. */
export function parseAfter(raw: string | null | undefined): number | undefined {
  if (typeof raw !== "string" || !/^[1-9]\d{0,15}$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** `2026Q4` for a date, in UTC (the backend's quarters are UTC). */
export function currentQuarter(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
}

/** The `count` quarters ending with the current one, newest first (`2026Q4`, `2026Q3`, ...). */
export function recentQuarters(now: Date = new Date(), count = 6): string[] {
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${year}Q${quarter}`);
    quarter -= 1;
    if (quarter === 0) {
      quarter = 4;
      year -= 1;
    }
  }
  return out;
}

/** The usage view's quarter: `yyyyQn`, else the current one. */
export function parseQuarter(raw: string | null | undefined, now: Date = new Date()): string {
  return typeof raw === "string" && /^\d{4}Q[1-4]$/.test(raw) ? raw : currentQuarter(now);
}

export interface PagerLinks {
  /** The next page, or null on the last. */
  readonly next: string | null;
  /** The first page (the same view without a cursor), or null when already on it. */
  readonly first: string | null;
}

/**
 * Keyset links that keep every other parameter. The list is ordered by the backend and a cursor is
 * only ever the `next_after` it served, so the page never re-sorts across pages.
 */
export function pagerLinks(
  path: string,
  params: Readonly<Record<string, string | undefined>>,
  after: number | undefined,
  nextAfter: number | null,
): PagerLinks {
  const href = (cursor: number | undefined) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "" && key !== "after") q.set(key, value);
    }
    if (cursor !== undefined) q.set("after", String(cursor));
    const qs = q.toString();
    return qs ? `${path}?${qs}` : path;
  };
  return {
    next: nextAfter === null ? null : href(nextAfter),
    first: after === undefined ? null : href(undefined),
  };
}

// ---------------------------------------------------------------------------
// The request row
// ---------------------------------------------------------------------------

/** Longer than this and the purpose is cut, with the whole text one click away. */
export const PURPOSE_PREVIEW_CHARS = 280;

/** The word an administrator types to confirm a revocation, as on the Users tab. */
export const REVOKE_CONFIRM_WORD = "REVOKE";

const NOT_SET = ACCOUNT_COPY["compute_admin.row.not_set"];

// The words chosen by a state, a decision or a flag are spelled out key by key, so each key has a
// reader the copy rule can see (account-copy.ts rule 4) and a typo is a type error.
export const STATE_FILTER_LABELS: Readonly<Record<RequestFilter, string>> = {
  requested: ACCOUNT_COPY["compute_admin.state.requested"],
  active: ACCOUNT_COPY["compute_admin.state.active"],
  suspended: ACCOUNT_COPY["compute_admin.state.suspended"],
  denied: ACCOUNT_COPY["compute_admin.state.denied"],
  revoked: ACCOUNT_COPY["compute_admin.state.revoked"],
  all: ACCOUNT_COPY["compute_admin.state.all"],
};
const ACTION_LABELS: Readonly<Record<ComputeAccessDecision, string>> = {
  grant: ACCOUNT_COPY["compute_admin.action.grant"],
  deny: ACCOUNT_COPY["compute_admin.action.deny"],
  suspend: ACCOUNT_COPY["compute_admin.action.suspend"],
  revoke: ACCOUNT_COPY["compute_admin.action.revoke"],
};
const FLAG_LABELS: Readonly<Record<ComputeJobFlag, string>> = {
  unreserved: ACCOUNT_COPY["compute_admin.flag.unreserved"],
  unattributed: ACCOUNT_COPY["compute_admin.flag.unattributed"],
  mismatch: ACCOUNT_COPY["compute_admin.flag.mismatch"],
  overrun: ACCOUNT_COPY["compute_admin.flag.overrun"],
};
const FLAG_MEANINGS: Readonly<Record<ComputeJobFlag, string>> = {
  unreserved: ACCOUNT_COPY["compute_admin.flag.meaning.unreserved"],
  unattributed: ACCOUNT_COPY["compute_admin.flag.meaning.unattributed"],
  mismatch: ACCOUNT_COPY["compute_admin.flag.meaning.mismatch"],
  overrun: ACCOUNT_COPY["compute_admin.flag.meaning.overrun"],
};

function lineOrNotSet(value: string | null | undefined): string {
  const text = displaySafeLine((value ?? "").trim());
  return text || NOT_SET;
}

export interface PurposeView {
  /** The text to show. The whole purpose unless it is longer than {@link PURPOSE_PREVIEW_CHARS}. */
  readonly preview: string;
  /** The whole purpose, escaped. Always present: nothing the person wrote is unreachable. */
  readonly full: string;
  readonly truncated: boolean;
}

/**
 * A purpose as text. The cut is made on the raw text by code point (never inside a surrogate
 * pair) and escaped afterwards, so an escape sequence is never cut in half; the full text is the
 * same escape applied to everything.
 */
export function purposeView(raw: string | null | undefined): PurposeView | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const points = Array.from(text);
  const truncated = points.length > PURPOSE_PREVIEW_CHARS;
  const full = displaySafeBody(text);
  return {
    preview: truncated
      ? `${displaySafeBody(points.slice(0, PURPOSE_PREVIEW_CHARS).join("").trimEnd())}…`
      : full,
    full,
    truncated,
  };
}

export interface StatePill {
  /** The state word as the backend sent it. */
  readonly word: string;
  readonly label: string;
  readonly tone: BadgeTone;
  readonly icon: IconName;
}

const STATE_TONES: Readonly<Record<string, BadgeTone>> = {
  requested: "warning",
  active: "success",
  suspended: "warning",
  denied: "danger",
  revoked: "danger",
};

/** The pill for an access state: the administrator's exact word, or a neutral pill carrying the raw word. */
export function statePill(word: string): StatePill {
  const known = isListedState(word);
  const tone = known ? STATE_TONES[word] : "neutral";
  return {
    word,
    label: known ? STATE_FILTER_LABELS[word] : displaySafeLine(word.trim() || "unknown"),
    tone,
    icon: badgeIcon(tone),
  };
}

/**
 * The decisions the state machine allows from a state, in the backend's order. A decision is
 * allowed when its target is one of the state's edges, which is the table the backend enforces in
 * the flip's WHERE clause. A state this build does not know allows none.
 */
export function allowedDecisions(state: string): ComputeAccessDecision[] {
  if (!Object.hasOwn(COMPUTE_ACCESS_TRANSITIONS, state)) return [];
  const edges: readonly string[] =
    COMPUTE_ACCESS_TRANSITIONS[state as keyof typeof COMPUTE_ACCESS_TRANSITIONS];
  return COMPUTE_ACCESS_DECISIONS.filter((d) => edges.includes(COMPUTE_DECISION_TARGET[d]));
}

/** The words on the button: a grant from `suspended` lifts a suspension; from `denied` or `revoked` it is a second grant. */
export function actionLabel(decision: ComputeAccessDecision, state: string): string {
  if (decision === "grant") {
    if (state === "suspended") return ACCOUNT_COPY["compute_admin.action.lift_suspension"];
    if (state === "denied" || state === "revoked") {
      return ACCOUNT_COPY["compute_admin.action.grant_again"];
    }
  }
  return ACTION_LABELS[decision];
}

export interface RowAction {
  readonly decision: ComputeAccessDecision;
  readonly label: string;
  /** True when the button is shown but cannot be used; `why` says so. */
  readonly disabled: boolean;
  readonly why: string | null;
}

export interface Viewer {
  /** `session.user.id`, a string. */
  readonly userId: string;
  /** `session.user.backend_role === "owner"`. */
  readonly isOwner: boolean;
}

export interface RequestRowModel {
  readonly id: number;
  readonly heading: string;
  /** `@name`, or the "no username" words. */
  readonly usernameText: string;
  readonly hasUsername: boolean;
  /** `/admin/users/<username>` only when the account has a username. */
  readonly usersHref: string | null;
  /** A chip when the account is not a person ("service account"). */
  readonly kindChip: string | null;
  readonly state: StatePill;
  readonly country: string;
  readonly city: string;
  readonly affiliation: string;
  readonly email: string;
  readonly orcid: { readonly text: string; readonly href: string | null };
  readonly requested: { readonly absolute: string; readonly relative: string } | null;
  readonly terms: string;
  readonly purpose: PurposeView | null;
  /** The served fact that nobody was emailed about an open request. */
  readonly notNotified: boolean;
  /** "Granted <date> by account #N" for an account that holds or held an active grant. */
  readonly granted: string | null;
  readonly actions: readonly RowAction[];
}

function absoluteAndRelative(
  value: string | null,
  now: Date,
): { absolute: string; relative: string } | null {
  const date = parseBackendTimestamp(value);
  if (!date) return null;
  return { absolute: formatDate(date), relative: formatRelativeTime(date, now) };
}

/**
 * One request as the page shows it. A missing name, affiliation, city or country reads "not
 * set"; a missing username reads "no username" and offers no Users link. On the signed-in
 * person's own row, Grant is disabled for anyone who is not an owner (the backend refuses it with
 * `self_decision`); deny, suspend and revoke of oneself stay allowed because they only take
 * access away.
 */
export function requestRowModel(
  row: ComputeAccessRow,
  viewer: Viewer,
  now: Date = new Date(),
): RequestRowModel {
  const name = [row.given_name, row.family_name]
    .map((p) => displaySafeLine((p ?? "").trim()))
    .filter((p) => p.length > 0)
    .join(" ");
  const username = row.username ? displaySafeLine(row.username) : null;
  const orcidRaw = (row.orcid ?? "").trim();
  const grantedDate = absoluteAndRelative(row.compute_access_granted_at, now);
  const termsDate = absoluteAndRelative(row.compute_terms_accepted_at, now);
  const own = String(row.id) === String(viewer.userId);
  const holds = row.compute_access === "active" || row.compute_access === "suspended";
  return {
    id: row.id,
    heading: name || displaySafeLine(row.email),
    usernameText: username ? `@${username}` : ACCOUNT_COPY["compute_admin.row.no_username"],
    hasUsername: username !== null,
    usersHref: row.username ? `/admin/users/${encodeURIComponent(row.username)}` : null,
    kindChip:
      row.account_kind && row.account_kind !== "person"
        ? fillCopy(ACCOUNT_COPY["compute_admin.row.account_kind"], {
            kind: displaySafeLine(row.account_kind),
          })
        : null,
    state: statePill(row.compute_access),
    country: lineOrNotSet(row.country),
    city: lineOrNotSet(row.city),
    affiliation: lineOrNotSet(row.affiliation),
    email: displaySafeLine(row.email),
    orcid: {
      text: orcidRaw ? displaySafeLine(orcidRaw) : NOT_SET,
      href: orcidRaw && isValidOrcid(orcidRaw) ? `https://orcid.org/${orcidRaw}` : null,
    },
    requested: absoluteAndRelative(row.compute_access_requested_at, now),
    terms: row.compute_terms_version
      ? fillCopy(ACCOUNT_COPY["compute_admin.row.terms_value"], {
          version: displaySafeLine(row.compute_terms_version),
          date: termsDate?.absolute ?? NOT_SET,
        })
      : NOT_SET,
    purpose: purposeView(row.compute_purpose),
    notNotified: row.compute_access === "requested" && row.compute_access_notified_at === null,
    granted:
      holds && grantedDate && row.compute_access_granted_by !== null
        ? fillCopy(ACCOUNT_COPY["compute_admin.row.granted"], {
            date: grantedDate.absolute,
            id: String(row.compute_access_granted_by),
          })
        : null,
    actions: allowedDecisions(row.compute_access).map((decision) => {
      const selfGrant = decision === "grant" && own && !viewer.isOwner;
      return {
        decision,
        label: actionLabel(decision, row.compute_access),
        disabled: selfGrant,
        why: selfGrant ? ACCOUNT_COPY["compute_admin.self_grant.disabled"] : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// The result of a decision
// ---------------------------------------------------------------------------

export interface DecisionNote {
  /** What happened, from the served fields. */
  readonly text: string;
  /** A second line, when the person could not be emailed. */
  readonly emailNote: string | null;
}

/**
 * The sentence for a decision that went through, composed from the served fields and the copy.
 * A success body carries no sentence of its own, so none is invented beyond the copy's: the
 * allocation figures come from `formatSu`, an allocation word this build does not know is
 * printed as the word, and `email_sent: false` is said (the decision stands, the person is told
 * by hand).
 */
export function describeDecision(result: ComputeDecisionResult): DecisionNote {
  let text: string;
  switch (result.decision) {
    case "grant": {
      const a = result.allocation;
      if (a?.granted) {
        text = fillCopy(ACCOUNT_COPY["compute_admin.result.granted_opened"], {
          cpu: formatSu(a.cpu_milli),
          gpu: formatSu(a.gpu_milli),
        });
      } else if (a?.reason === "policy_default_zero") {
        text = ACCOUNT_COPY["compute_admin.result.granted_zero_default"];
      } else if (a?.reason === "already_granted") {
        text = ACCOUNT_COPY["compute_admin.result.granted_already"];
      } else if (a?.reason) {
        text = fillCopy(ACCOUNT_COPY["compute_admin.result.granted_other"], {
          reason: displaySafeLine(a.reason),
        });
      } else {
        text = ACCOUNT_COPY["compute_admin.result.granted"];
      }
      break;
    }
    case "deny":
      text = ACCOUNT_COPY["compute_admin.result.denied"];
      break;
    case "suspend":
      text = ACCOUNT_COPY["compute_admin.result.suspended"];
      break;
    case "revoke":
      text = ACCOUNT_COPY["compute_admin.result.revoked"];
      break;
    default:
      text = `${displaySafeLine(result.decision)}: ${displaySafeLine(result.from)} → ${displaySafeLine(result.to)}`;
  }
  return {
    text,
    emailNote:
      result.email_sent === false ? ACCOUNT_COPY["compute_admin.result.email_not_sent"] : null,
  };
}

export interface FailureNote {
  /** What to print. */
  readonly text: string;
  /** Read the account again and draw the row from what the server says. */
  readonly reread: boolean;
  /** The row's buttons come back as they were (nothing changed). */
  readonly restore: boolean;
  /** The row is marked stale: the account is not there. */
  readonly stale: boolean;
}

/**
 * What to tell the person after a decision failed, and what to do next, from
 * `classifyDecisionFailure`. The backend's refusal sentence is printed as it came (the backend's
 * words are the page's words); the page adds only the copy's line about someone else having
 * decided, and the line saying a result is not confirmed. A 5xx or a lost answer is never
 * reported as failed: it may have been committed, so the page says so and reads the account.
 */
export function describeFailure(kind: DecisionFailure, err: unknown): FailureNote {
  const sentence = displaySafeLine(computeAdminErrorText(err));
  switch (kind) {
    case "refused":
      return { text: sentence, reread: false, restore: true, stale: false };
    case "state_changed":
      return {
        text: `${sentence} ${ACCOUNT_COPY["compute_admin.result.state_changed"]}`,
        reread: true,
        restore: false,
        stale: false,
      };
    case "not_found":
      return {
        text: `${sentence} ${ACCOUNT_COPY["compute_admin.result.stale"]}`,
        reread: false,
        restore: false,
        stale: true,
      };
    case "signed_out":
      return {
        text: ACCOUNT_COPY["compute_admin.result.signed_out"],
        reread: false,
        restore: true,
        stale: false,
      };
    default:
      return {
        text: ACCOUNT_COPY["compute_admin.result.unconfirmed"],
        reread: true,
        restore: false,
        stale: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Pools, jobs, reconciliation
// ---------------------------------------------------------------------------

export interface PoolRowModel {
  readonly holder: string;
  readonly pool: string;
  readonly granted: string;
  readonly held: string;
  readonly charged: string;
  /** Printed from the served figure; a negative one reads negative. */
  readonly available: string;
  readonly negative: boolean;
  /** A word, not a colour: frozen pools say so. */
  readonly frozen: boolean;
  readonly frozenText: string;
  readonly updated: string;
}

/** Account pools read "account #N" (a plain number: the Users tab is keyed by username). */
export function holderText(kind: string, ref: string): string {
  if (kind === "account" && /^\d+$/.test(ref)) {
    return fillCopy(ACCOUNT_COPY["compute_admin.ref.account"], { id: ref });
  }
  return displaySafeLine(ref);
}

export function poolRowModel(pool: ComputePoolRow): PoolRowModel {
  const date = parseBackendTimestamp(pool.updated_at);
  return {
    holder: holderText(pool.holder_kind, pool.holder_ref),
    pool: displaySafeLine(pool.pool),
    granted: formatSu(pool.granted_milli),
    held: formatSu(pool.held_milli),
    charged: formatSu(pool.charged_milli),
    available: formatSu(pool.available_milli),
    negative: pool.available_milli < 0,
    frozen: pool.frozen,
    frozenText: pool.frozen
      ? ACCOUNT_COPY["compute_admin.pools.frozen"]
      : ACCOUNT_COPY["compute_admin.pools.open"],
    updated: date ? formatDate(date) : NOT_SET,
  };
}

export function flagLabel(flag: string): string {
  return isJobFlag(flag) ? FLAG_LABELS[flag] : displaySafeLine(flag);
}

/** One line on what a flag means, or null for a flag this build has no wording for. */
export function flagMeaning(flag: string): string | null {
  return isJobFlag(flag) ? FLAG_MEANINGS[flag] : null;
}

export const FLAG_CHIPS: ReadonlyArray<{ flag: ComputeJobFlag; label: string }> =
  COMPUTE_JOB_FLAGS.map((flag) => ({ flag, label: flagLabel(flag) }));

export interface JobRowModel {
  readonly id: string;
  readonly account: string;
  readonly flags: readonly string[];
  readonly source: string;
  readonly partition: string;
  readonly pool: string;
  readonly state: string;
  readonly charged: string;
  readonly held: string;
  readonly platformFailure: boolean;
  readonly failure: string | null;
  readonly partner: string | null;
  readonly created: string;
  readonly ended: string;
}

export function jobRowModel(job: ComputeJobRow): JobRowModel {
  const created = parseBackendTimestamp(job.created_at);
  const ended = parseBackendTimestamp(job.ended_at);
  const failureParts = [job.failure_code, job.failure_detail]
    .map((p) => displaySafeLine((p ?? "").trim()))
    .filter((p) => p.length > 0);
  return {
    id: displaySafeLine(job.id),
    account:
      job.account_id === null
        ? ACCOUNT_COPY["compute_admin.ref.no_account"]
        : fillCopy(ACCOUNT_COPY["compute_admin.ref.account"], { id: String(job.account_id) }),
    flags: job.flags.map(flagLabel),
    source: displaySafeLine(job.source),
    partition: displaySafeLine(job.partition),
    pool: displaySafeLine(job.pool),
    state: job.state,
    charged: formatSu(job.charged_milli),
    held: formatSu(job.held_milli),
    platformFailure: job.platform_failure,
    failure: failureParts.length > 0 ? failureParts.join(": ") : null,
    partner:
      job.partner_state || job.partner_flag
        ? fillCopy(ACCOUNT_COPY["compute_admin.flagged.partner"], {
            state: displaySafeLine(job.partner_state ?? NOT_SET),
            flag: displaySafeLine(job.partner_flag ?? NOT_SET),
          })
        : null,
    created: created ? formatDate(created) : NOT_SET,
    ended: ended ? formatDate(ended) : NOT_SET,
  };
}

export interface UnmatchedRowModel {
  readonly slurm: string;
  readonly partition: string;
  readonly state: string;
  readonly elapsed: string;
  readonly resources: string;
  readonly charged: string;
  readonly ingested: string;
}

export function unmatchedRowModel(row: ComputeUnmatchedRow): UnmatchedRowModel {
  const ingested = parseBackendTimestamp(row.ingested_at);
  return {
    slurm: displaySafeLine(row.slurm_job_id),
    partition: displaySafeLine(row.partition),
    state: displaySafeLine(row.state),
    elapsed: String(row.elapsed_seconds),
    resources: `${row.alloc_nodes}, ${row.alloc_cpus}, ${row.alloc_gpus}`,
    charged:
      row.charged_milli === null
        ? ACCOUNT_COPY["compute_admin.drift.not_priced"]
        : formatSu(row.charged_milli),
    ingested: ingested ? formatDate(ingested) : NOT_SET,
  };
}

/** "Showing the newest N of T." Both numbers are the served ones. */
export function unmatchedSummary(shown: number, total: number): string {
  return fillCopy(ACCOUNT_COPY["compute_admin.drift.unmatched_shown"], {
    shown: String(shown),
    total: String(total),
  });
}

/** "Scheduler gateway: token X, health Y." with both words as served. */
export function tapisLine(status: { tapis_token: string; tapis_health: string }): string {
  return fillCopy(ACCOUNT_COPY["compute_admin.drift.tapis"], {
    token: displaySafeLine(status.tapis_token),
    health: displaySafeLine(status.tapis_health),
  });
}

/**
 * The attention record of the status route as lines, in the order served. A positive count is
 * `word: count`; a zero is left out (nothing waits); a value that is not a count (a key the
 * Worker adds in another shape) is printed as text and is never read as zero.
 */
export function attentionLines(attention: Readonly<Record<string, unknown>>): string[] {
  const lines: string[] = [];
  for (const [word, value] of Object.entries(attention)) {
    const label = displaySafeLine(word);
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value > 0) lines.push(`${label}: ${value}`);
      else if (value < 0) lines.push(`${label}: ${value}`);
      continue;
    }
    const shown = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
    lines.push(`${label}: ${displaySafeLine(shown.slice(0, 120))}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

/** The tab badge text: the count, `200+` when the first page was full, nothing for zero or unknown. */
export function requestsBadge(count: ComputeRequestsCount | null): string | null {
  if (count === null || count.count === 0) return null;
  return count.capped ? `${count.count}+` : String(count.count);
}
