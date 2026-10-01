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
 * requests: it is denied, the researcher fixes it and asks again. Production
 * has 29 datasets whose older denied request sits beside a later published
 * one. Listing the history would put a dataset under Denied that is in fact
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

/**
 * The terminal command that carries a request forward. The CLI is the only
 * client that drives approval to completion today (see
 * `WEB_PUBLISH_APPROVE_ENABLED`), so the page points at it. An `approving`
 * request has already done part of the work, so it must `--resume` to skip the
 * finished steps rather than run them again. The dataset id comes straight
 * from the backend and is only ever printed as text.
 */
export function cliApproveCommand(
  request: Pick<PublicationRequest, "dataset_id" | "status">,
): string {
  const base = `nemar admin publish approve ${request.dataset_id}`;
  return request.status === "approving" ? `${base} --resume` : base;
}
