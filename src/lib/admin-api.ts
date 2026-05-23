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
  init: { signal?: AbortSignal; fetch?: typeof fetch; cookieHeader?: string } = {},
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
    signal: init.signal,
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
  init: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<{ status: PublicationStatus }> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(
    `${dashboardApiBase()}/admin/publish/${encodeURIComponent(datasetId)}/approve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      body: "{}",
      signal: init.signal,
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
  init: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<{ status: PublicationStatus }> {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new DashboardApiError("Deny requires a non-empty reason", 0, "missing_field");
  }
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(
    `${dashboardApiBase()}/admin/publish/${encodeURIComponent(datasetId)}/deny`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      body: JSON.stringify({ reason: trimmed }),
      signal: init.signal,
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
