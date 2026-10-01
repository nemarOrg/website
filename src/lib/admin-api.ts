/**
 * Admin API client: list publication requests, deny them, and start their
 * approval. SSR callers pass `cookieHeader` and hit `api.nemar.org` directly;
 * browser callers go through the same-origin `/api/v1` proxy (see
 * `dashboardApiBase` in `./api-base.ts`) so the session cookie attaches
 * automatically without broadening it to other `*.nemar.org` hosts.
 */
import { dashboardApiBase, readError } from "./api-base";
import { DashboardApiError, deriveAdminBadgeState } from "./dashboard-api";
import { DEFAULT_REQUEST_TIMEOUT_MS, resolveSignal } from "./request-deadline";

type Init = {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly cookieHeader?: string;
  /** Abort the request after this many ms. See {@link ADMIN_TIMEOUTS_MS}. */
  readonly timeoutMs?: number;
};

/**
 * Per-operation request deadlines, exported so the difference between them is
 * a pinned contract rather than loose magic numbers.
 *
 * - `list`: a D1-backed read that SSRs `/admin/publication-requests`. It is
 *   the page's primary content, so it gets the base deadline.
 * - `deny`: one DB update plus a best-effort email.
 * - `dispatch`: one DB claim plus one GitHub `repository_dispatch`. Approval
 *   itself no longer runs inside this request: the backend hands it to a
 *   GitHub Action and answers 202 (website#200), so this is a short deadline,
 *   not the two minutes the old blocking approve needed.
 */
export const ADMIN_TIMEOUTS_MS = {
  list: DEFAULT_REQUEST_TIMEOUT_MS,
  deny: 15_000,
  dispatch: 15_000,
} as const;

/**
 * `publication_requests.status`. The column is CHECK-constrained to exactly
 * these five values (nemar-cli migration 0026), so a request is always in one
 * of them; there is no "none" here, which belongs to the owner-side
 * `PublicationStatus` for a dataset that has never been requested.
 */
export type PublicationRequestStatus =
  | "requested"
  | "approving"
  | "published"
  | "denied"
  | "blocked";

/**
 * One row of `GET /admin/publish/requests`: the `publication_requests` table
 * joined to the requester, sent as stored (nemar-cli
 * `backend/src/routes/admin/publish.ts`, `SELECT pr.*, u.username ...`).
 *
 * This is deliberately NOT the discriminated `PublicationStatus` that the
 * owner-side `/datasets/:id/publish/status` returns. This page was first built
 * against that nested shape (`status.status`, `status.dataset_id`, a
 * `dataset_name` and an `owner_email` the route never sent), and with the
 * backend's flat rows the first row's render threw, so the queue never listed
 * anything. The shape below is what a production response looks like; see
 * `test/fixtures/admin-publish-requests.json`.
 *
 * Timestamps are SQLite `datetime('now')`, i.e. UTC with no zone marker. Parse
 * them with `parseBackendTimestamp`, not `new Date`.
 *
 * `block_reason` is NOT cleared when a blocked request later moves on, so
 * published and denied rows keep a stale one. Read it only when `status` is
 * `"blocked"`.
 */
export interface PublicationRequest {
  readonly id: number;
  readonly dataset_id: string;
  readonly status: PublicationRequestStatus;
  readonly requested_at: string;
  readonly requested_by_username: string;
  readonly requested_by_email: string;
  readonly approved_at: string | null;
  readonly denied_at: string | null;
  readonly denied_reason: string | null;
  readonly block_reason: string | null;
  /** The orchestrator step an `approving` request is on, or stopped at. */
  readonly current_step: string | null;
  readonly last_error: string | null;
  /** 1 for an anonymous release (the data goes public, the depositor stays concealed). */
  readonly anonymous?: number;
  /**
   * Set by the approval-dispatch backend (nemar-cli `approve-dispatch`).
   * Optional because a backend without the dispatch route omits them. The page
   * reads a missing `approval_in_flight` as "this backend cannot dispatch" and
   * falls back to the CLI hint (see `approvalPhase`).
   *
   * `updated_at` moves on every orchestrator step. `approval_requested_by` is
   * the admin who clicked Approve on the web, and `approval_dispatched_at`
   * when the GitHub Action was asked to run. `approval_in_flight` is the
   * backend's own answer to "is an approval running or queued right now",
   * computed once on the server so no client hard-codes its timing.
   */
  readonly updated_at?: string;
  readonly approval_requested_by?: number | null;
  readonly approval_dispatched_at?: string | null;
  readonly approval_in_flight?: boolean;
}

export interface PublicationRequestListResponse {
  readonly requests: readonly PublicationRequest[];
  readonly count: number;
}

export async function listPublicationRequests(
  query: { status?: PublicationRequestStatus } = {},
  init: Init = {},
): Promise<PublicationRequestListResponse> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  const qs = params.toString();
  const url = `${dashboardApiBase(init.cookieHeader)}/admin/publish/requests${qs ? `?${qs}` : ""}`;
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(url, {
    method: "GET",
    headers,
    credentials: "include",
    signal: resolveSignal(init, ADMIN_TIMEOUTS_MS.list),
  });
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Could not list publication requests: ${detail.message ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as PublicationRequestListResponse;
}

/**
 * What a failed call says. The backend's older admin routes send
 * `{ error: "<a sentence>" }`, and `readError` files that under `code`, so
 * `message` is empty and the sentence would be lost behind the HTTP status
 * text. A `code` with a space in it is such a sentence; a snake_case `code` is
 * a machine code the page maps itself (see `FRIENDLY` in the page).
 */
function failureText(detail: { message?: string; code?: string }, res: Response): string {
  if (detail.message) return detail.message;
  if (detail.code?.includes(" ")) return detail.code;
  return res.statusText;
}

export interface PublicationDispatchResponse {
  readonly status: "dispatched";
  readonly dataset_id: string;
  readonly request_id: number;
  /** True when the run continues finished work instead of starting over. */
  readonly resume: boolean;
}

/**
 * Ask the backend to run a request's approval in a GitHub Action. The route
 * answers 202 as soon as the Action has been asked to start; the run then
 * reports through the request's own `status`, `current_step` and `last_error`.
 * Closing the page afterwards changes nothing.
 */
export async function dispatchPublicationApproval(
  datasetId: string,
  init: Init = {},
): Promise<PublicationDispatchResponse> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/publish/${encodeURIComponent(datasetId)}/approve-dispatch`,
    {
      method: "POST",
      headers,
      credentials: "include",
      body: "{}",
      signal: resolveSignal(init, ADMIN_TIMEOUTS_MS.dispatch),
    },
  );
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Approval was not started: ${failureText(detail, res)}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as PublicationDispatchResponse;
}

/** What `POST /admin/publish/:id/deny` answers (nemar-cli `routes/admin/publish.ts`). */
export interface PublicationDenyResponse {
  readonly message: string;
  readonly dataset_id: string;
  readonly reason: string;
}

export async function denyPublicationRequest(
  datasetId: string,
  reason: string,
  init: Init = {},
): Promise<PublicationDenyResponse> {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new DashboardApiError("Deny requires a non-empty reason", 0, "missing_field");
  }
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/publish/${encodeURIComponent(datasetId)}/deny`,
    {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({ reason: trimmed }),
      signal: resolveSignal(init, ADMIN_TIMEOUTS_MS.deny),
    },
  );
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Deny failed: ${failureText(detail, res)}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as PublicationDenyResponse;
}

/** Re-export to keep admin surfaces importing from a single module. */
export { deriveAdminBadgeState };
