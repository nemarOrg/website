/**
 * Admin API client: list pending publication requests and approve or deny
 * them. SSR callers pass `cookieHeader` and hit `api.nemar.org` directly;
 * browser callers go through the same-origin `/api/v1` proxy (see
 * `dashboardApiBase` in `./api-base.ts`) so the session cookie attaches
 * automatically without broadening it to other `*.nemar.org` hosts.
 */
import { dashboardApiBase, readError } from "./api-base";
import {
  DashboardApiError,
  type DatasetPublishState,
  type PublicationStatus,
  deriveAdminBadgeState,
} from "./dashboard-api";
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
 * - `list` — a D1-backed read that SSRs `/admin/publication-requests`. It is
 *   the page's primary content, so it gets the base deadline.
 * - `deny` — one DB update plus a best-effort email. Slower than a read
 *   because it writes, but nowhere near `approve`.
 * - `approve` — the outlier, and the reason this table has three entries
 *   instead of two. `POST /admin/publish/:id/approve` fully awaits
 *   `runPublicationApproval`, a sixteen-step state machine (nemar-cli
 *   `backend/src/services/publication-orchestrator.ts`) that walks GitHub
 *   (tree read, blob read, workflow check, workflow deploy, run poll,
 *   visibility flip, repo spec, tag protection), verifies S3, and mints a
 *   Zenodo DOI — several steps wrapped in `withRetry` at three attempts. Only
 *   `waitForPublicPropagation` is deferred to `waitUntil`; everything else
 *   blocks the response. A single retried GitHub step can push a *healthy*
 *   run past fifteen seconds, and an abort there is worse than a slow spinner:
 *   the Worker-side run is not tied to our AbortController, so it keeps going
 *   while the page re-enables the button and invites a second click.
 *
 * Even at two minutes this is still a bound, which is the point — the bug in
 * website#173 was an *unbounded* wait, not a short one. Making approve
 * non-blocking (kick off the job, poll for progress) is the real fix, tracked
 * in website#200; it needs a backend change, not a constant. When that lands,
 * `approve` drops back to a normal deadline and this comment goes away.
 */
export const ADMIN_TIMEOUTS_MS = {
  list: DEFAULT_REQUEST_TIMEOUT_MS,
  deny: 15_000,
  approve: 120_000,
} as const;

export interface PublicationRequest {
  /** Human-readable dataset name, included for display without a second fetch. */
  readonly dataset_name: string;
  /** Email of the dataset owner; used for the "Requested by" column. */
  readonly owner_email: string;
  /**
   * Full discriminated-union status. `status.dataset_id` is the canonical
   * id for this row; we deliberately do not duplicate it at this level to
   * avoid two-sources-of-truth drift.
   */
  readonly status: PublicationStatus;
}

export interface PublicationRequestListResponse {
  readonly requests: readonly PublicationRequest[];
  readonly count: number;
}

export async function listPublicationRequests(
  query: { status?: PublicationStatus["status"] } = {},
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

export async function approvePublicationRequest(
  datasetId: string,
  init: Init = {},
): Promise<{ status: PublicationStatus }> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/publish/${encodeURIComponent(datasetId)}/approve`,
    {
      method: "POST",
      headers,
      credentials: "include",
      body: "{}",
      signal: resolveSignal(init, ADMIN_TIMEOUTS_MS.approve),
    },
  );
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Approve failed: ${detail.message ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as { status: PublicationStatus };
}

export async function denyPublicationRequest(
  datasetId: string,
  reason: string,
  init: Init = {},
): Promise<{ status: PublicationStatus }> {
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
      `Deny failed: ${detail.message ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as { status: PublicationStatus };
}

/**
 * True when an admin can act on this request right now. Approve and deny
 * are only meaningful in the `"requested"` state; the orchestrator handles
 * intermediate transitions on the backend.
 */
export function isAdminActionable(req: PublicationRequest): boolean {
  return req.status.status === "requested";
}

/** Re-export to keep admin surfaces importing from a single module. */
export { deriveAdminBadgeState };
export type { DatasetPublishState };
