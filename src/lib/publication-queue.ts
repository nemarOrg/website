/**
 * The admin publication queue's tabs, and the bucketing behind them.
 *
 * There is no "All" tab. The question an admin asks of this page is one of
 * four, and each has its own tab: what is waiting on me (Pending), what is
 * already public (Published), what did I turn down (Denied), and what is stuck
 * on the researcher (Blocked). A fifth tab that is their union answers none of
 * them and buries the two requests that need action under hundreds of
 * published ones.
 *
 * **One row per dataset, the latest request.** A dataset can have several
 * requests: it is denied, the researcher fixes it and asks again. On
 * 2026-10-01 production had 29 datasets whose older denied request sat beside
 * a later published one. Listing the history would put a dataset under Denied that is in fact
 * public, so every tab shows only each dataset's most recent request. The
 * history is still in the database; this page is a queue, not an audit log.
 *
 * **"Approving" lives under Pending.** It is a request an admin already acted
 * on whose orchestrator run is in flight or stopped partway (the row carries
 * `current_step` and `last_error`). With no "All" tab it would otherwise match
 * no tab at all, and a request stuck there is exactly the kind an admin needs
 * to find. The row still prints its own status, so it reads differently from a
 * fresh request.
 */
import type { PublicationRequest } from "./admin-api";

export type QueueTabId = "pending" | "published" | "denied" | "blocked";

export interface QueueTab {
  readonly id: QueueTabId;
  readonly label: string;
  readonly empty: { readonly title: string; readonly body: string };
}

export const QUEUE_TABS: readonly QueueTab[] = [
  {
    id: "pending",
    label: "Pending",
    empty: {
      title: "Nothing is waiting for review",
      body: "New requests appear here as researchers submit their datasets.",
    },
  },
  {
    id: "published",
    label: "Published",
    empty: {
      title: "No datasets have been published yet",
      body: "Datasets appear here once a publication request is approved.",
    },
  },
  {
    id: "denied",
    label: "Denied",
    empty: {
      title: "No denied requests",
      body: "A dataset whose latest request was denied appears here until it is requested again.",
    },
  },
  {
    id: "blocked",
    label: "Blocked",
    empty: {
      title: "No blocked requests",
      body: "Requests the backend stopped for a fixable reason, such as failing validation, appear here.",
    },
  },
];

export const DEFAULT_QUEUE_TAB: QueueTabId = "pending";

const TAB_IDS: ReadonlySet<string> = new Set(QUEUE_TABS.map((t) => t.id));

/**
 * Resolve the `?status=` query value to a tab. The values `requested` and
 * `approving` were the page's own filter keys before the tabs were reworked,
 * so an old bookmark still lands on Pending; anything else, including the
 * retired `all`, falls back to the default tab rather than an empty page.
 */
export function resolveQueueTab(param: string | null | undefined): QueueTabId {
  if (param && TAB_IDS.has(param)) return param as QueueTabId;
  return DEFAULT_QUEUE_TAB;
}

/**
 * The tab a request belongs under. Anything that is not published, denied or
 * blocked is Pending, including a status this code has never heard of: a row
 * that matched no tab would be invisible, which is the failure this page
 * exists to prevent. The database constrains `status` to five values, so the
 * fallback is for a future sixth, not for today.
 */
export function tabOf(status: string): QueueTabId {
  return status === "published" || status === "denied" || status === "blocked" ? status : "pending";
}

/**
 * Keep only the most recent request for each dataset, in the input's order.
 * Recency is the autoincrement `id` rather than `requested_at`: the id is
 * strictly ordered by insertion, whereas two requests in one second would tie
 * on a timestamp with one-second resolution.
 */
export function latestPerDataset(rows: readonly PublicationRequest[]): PublicationRequest[] {
  const newest = new Map<string, number>();
  for (const row of rows) {
    const seen = newest.get(row.dataset_id);
    if (seen === undefined || row.id > seen) newest.set(row.dataset_id, row.id);
  }
  return rows.filter((row) => newest.get(row.dataset_id) === row.id);
}

/** Every dataset's latest request, grouped by tab, each keeping the input's order. */
export function bucketQueue(
  rows: readonly PublicationRequest[],
): Record<QueueTabId, PublicationRequest[]> {
  const buckets: Record<QueueTabId, PublicationRequest[]> = {
    pending: [],
    published: [],
    denied: [],
    blocked: [],
  };
  for (const row of latestPerDataset(rows)) buckets[tabOf(row.status)].push(row);
  return buckets;
}

/** The shape of a NEMAR dataset id (`nm000290`, `on008862`). */
const DATASET_ID_SHAPE = /^[a-z]{2}\d{6}$/;

/**
 * The terminal command that carries a request forward. It is the way forward
 * when the web cannot start approval (a backend without the dispatch route, or
 * the flag off) and the fallback when a run stalls or fails. An `approving`
 * request has already done part of the work, so it must `--resume` to skip the
 * finished steps rather than run them again.
 *
 * The id comes from the backend and the command is meant to be pasted into a
 * shell, so anything that is not a NEMAR dataset id yields no command at all.
 */
export function cliApproveCommand(
  request: Pick<PublicationRequest, "dataset_id" | "status">,
): string | null {
  if (!DATASET_ID_SHAPE.test(request.dataset_id)) return null;
  const base = `nemar admin publish approve ${request.dataset_id}`;
  return request.status === "approving" ? `${base} --resume` : base;
}

/**
 * What the web can do for a request right now, from the backend's own fields.
 *
 * - `none`: published, denied or blocked. Nothing to start.
 * - `unsupported`: the backend sent no `approval_in_flight`, so it predates the
 *   dispatch route. The web cannot start approval; a terminal can. Detecting
 *   this from the data means a site deployed before its backend degrades to
 *   the CLI hint instead of a button that answers 404.
 * - `ready`: requested and never dispatched. The Approve button.
 * - `running`: the backend says an approval is queued or in progress.
 *   `queued` is true until the orchestrator has written a step since the
 *   dispatch. No start button.
 * - `stalled`: an approval was started and has gone quiet, so it will not
 *   finish by itself. `resume` is true when steps already ran, which is the
 *   case for any `approving` request; the retry then skips finished steps.
 *
 * The timing lives in the backend (`approval_in_flight`), so this never
 * compares a timestamp with the clock.
 */
export type ApprovalPhase =
  | { readonly kind: "none" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "ready" }
  | { readonly kind: "running"; readonly queued: boolean; readonly step: string | null }
  | { readonly kind: "stalled"; readonly resume: boolean };

export function approvalPhase(
  request: Pick<
    PublicationRequest,
    "status" | "current_step" | "updated_at" | "approval_in_flight" | "approval_dispatched_at"
  >,
): ApprovalPhase {
  if (request.status !== "requested" && request.status !== "approving") return { kind: "none" };
  if (request.approval_in_flight === undefined) return { kind: "unsupported" };
  if (request.approval_in_flight) {
    // Both stamps are `datetime('now')` text, which sorts like time: a dispatch
    // newer than the last progress write means no step has run since it.
    const noStepSinceDispatch =
      Boolean(request.approval_dispatched_at) &&
      Boolean(request.updated_at) &&
      (request.approval_dispatched_at as string) > (request.updated_at as string);
    return {
      kind: "running",
      queued: request.status === "requested" || noStepSinceDispatch,
      step: request.current_step,
    };
  }
  if (request.status === "approving") return { kind: "stalled", resume: true };
  // Requested. Dispatched before but quiet now means the Action never started.
  return request.approval_dispatched_at ? { kind: "stalled", resume: false } : { kind: "ready" };
}

/**
 * Whether the backend behind this list can start an approval. Every row from a
 * backend with the dispatch route carries `approval_in_flight`, so one row
 * answers for all of them; an empty list has nothing to approve, so the answer
 * does not matter and is `true`.
 */
export function backendDispatches(rows: readonly PublicationRequest[]): boolean {
  return rows.length === 0 || rows.some((r) => r.approval_in_flight !== undefined);
}

/** Everything a queue row decides to show, so the decision is testable. */
export interface RowView {
  /** An anonymous release: the data goes public, the depositor stays concealed. */
  readonly anonymous: boolean;
  readonly canDeny: boolean;
  /**
   * The web action offered. `approve` opens the dialog that asks for a typed
   * PUBLISH, and is used whenever NOTHING has run yet, including a retry of a
   * request that never started: that is the first, irreversible approval, not
   * a continuation. `resume` is only for a request that already has steps done.
   */
  readonly start: { readonly kind: "approve" | "resume"; readonly label: string } | null;
  /** `active` is true while the backend holds a lease, so the page keeps refreshing. */
  readonly progress: { readonly text: string; readonly active: boolean } | null;
  readonly note: { readonly label: string; readonly text: string } | null;
  readonly terminal: { readonly lead: string; readonly command: string } | null;
}

const stepLabel = (step: string | null): string | null => (step ? step.replaceAll("_", " ") : null);

export function rowView(request: PublicationRequest, webEnabled: boolean): RowView {
  const phase = approvalPhase(request);
  const canStart = webEnabled && (phase.kind === "ready" || phase.kind === "stalled");
  // The orchestrator writes `last_error` when a step fails and clears it when a
  // step succeeds, so a non-empty one on an approving request is a stopped run
  // whether or not the backend's lease on it has lapsed yet.
  const failed = request.status === "approving" && Boolean(request.last_error);

  const start = !canStart
    ? null
    : phase.kind === "ready"
      ? { kind: "approve" as const, label: "Approve and publish" }
      : phase.kind === "stalled" && phase.resume
        ? { kind: "resume" as const, label: "Resume approval" }
        : { kind: "approve" as const, label: "Retry approval" };

  let progress: RowView["progress"] = null;
  if (phase.kind === "running") {
    const text = failed
      ? "The last step failed and the run has stopped."
      : phase.queued
        ? "Approval queued. Waiting for GitHub Actions to start it."
        : `Approval in progress${phase.step ? `: ${stepLabel(phase.step)}` : ""}. It continues if you close this page.`;
    progress = { text, active: true };
  } else if (phase.kind === "stalled") {
    progress = {
      text: phase.resume
        ? "Approval stopped making progress. Resume continues from the last finished step."
        : "The approval was requested but never started. Retrying starts it from the beginning.",
      active: false,
    };
  }

  // `block_reason` is not cleared when a blocked request later moves on, so a
  // published or denied row can still carry one. Only a blocked row's counts.
  const note =
    request.status === "denied" && request.denied_reason
      ? { label: "Reason", text: request.denied_reason }
      : request.status === "blocked" && request.block_reason
        ? { label: "Reason", text: request.block_reason }
        : failed
          ? {
              label: request.current_step
                ? `Stopped at ${stepLabel(request.current_step)}`
                : "Last error",
              text: request.last_error as string,
            }
          : null;

  const command = cliApproveCommand(request);
  const wantsTerminal =
    phase.kind === "stalled" ||
    (phase.kind === "running" && failed) ||
    (!canStart && (phase.kind === "ready" || phase.kind === "unsupported"));
  const terminal =
    command && wantsTerminal
      ? {
          lead: canStart
            ? "Or from a terminal"
            : request.status === "approving"
              ? "Continue from a terminal"
              : "Approve from a terminal",
          command,
        }
      : null;

  return {
    anonymous: request.anonymous === 1,
    canDeny: request.status === "requested" && phase.kind !== "running",
    start,
    progress,
    note,
    terminal,
  };
}
