/**
 * Admin API client: list pending publication requests across all owners and
 * approve or deny them. Today these calls go to the local `/api/admin/*`
 * mock; point them at `api.nemar.org/admin/publish/*` once nemar-cli#572
 * (cookie-aware auth on /admin) lands.
 */
import { DashboardApiError, type PublicationStatus } from "./dashboard-api";

export interface PublicationRequest {
  readonly dataset_id: string;
  readonly dataset_name: string;
  readonly owner_email: string;
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
  const url = `/api/admin/publication-requests${qs ? `?${qs}` : ""}`;
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
    `/api/admin/publication-requests/${encodeURIComponent(datasetId)}/approve`,
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
    `/api/admin/publication-requests/${encodeURIComponent(datasetId)}/deny`,
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

async function readError(res: Response): Promise<{ message?: string; code?: string }> {
  try {
    const body = (await res.json()) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return {};
    const code = typeof body.error === "string" ? body.error : undefined;
    const message =
      typeof body.message === "string" && body.message.length > 0 ? body.message : undefined;
    return { message, code };
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}
