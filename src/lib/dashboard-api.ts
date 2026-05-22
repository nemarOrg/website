/**
 * Dashboard API client: list owned datasets, request publication, delete a
 * draft. Today these calls go to the local `/api/datasets/*` mock; at Phase 5
 * cutover the same call sites point at `api.nemar.org` once the upstream
 * cookie-aware auth (nemar-cli#572) and owner-deletion (nemar-cli#575) land.
 */
import type { Dataset, DatasetListResponse } from "./types";

export type PublishState = "draft" | "awaiting_review" | "published" | "validation_failed";

export type PublishStatusState = "none" | "requested" | "approved" | "blocked";

export interface PublicationStatus {
  readonly dataset_id: string;
  readonly status: PublishStatusState;
  readonly requested_at?: string;
  readonly approved_at?: string;
  readonly denied_at?: string;
  readonly block_reason?: string;
  readonly requested_by?: string;
  readonly ci_url?: string;
}

export class DashboardApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
    this.code = code;
  }
}

export async function listMyDatasets(
  query: { limit?: number; offset?: number } = {},
  init: { signal?: AbortSignal; fetch?: typeof fetch; cookieHeader?: string } = {},
): Promise<DatasetListResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const qs = params.toString();
  const url = `/api/datasets/list${qs ? `?${qs}` : ""}`;
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  // Server-side rendering needs explicit cookie forwarding because Astro's
  // server-side fetch doesn't carry the request's cookie jar automatically.
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
      `List datasets failed: ${detail.message ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as DatasetListResponse;
}

export async function requestPublication(
  id: string,
  init: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<PublicationStatus> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(`/api/datasets/${encodeURIComponent(id)}/publish-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    body: "{}",
    signal: init.signal,
  });
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Publication request failed: ${detail.message ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as PublicationStatus;
}

export async function deleteDraftDataset(
  id: string,
  init: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<{ ok: true }> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(`/api/datasets/${encodeURIComponent(id)}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    body: "{}",
    signal: init.signal,
  });
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Delete failed: ${detail.message ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return { ok: true };
}

export function derivePublishState(
  dataset: Pick<Dataset, "visibility" | "concept_doi">,
  publishStatus?: PublicationStatus | null,
): PublishState {
  if (dataset.visibility === "public" || dataset.concept_doi) return "published";
  if (publishStatus?.status === "blocked") return "validation_failed";
  if (publishStatus?.status === "requested" || publishStatus?.status === "approved") {
    return "awaiting_review";
  }
  return "draft";
}

export function isDeletable(
  dataset: Pick<Dataset, "visibility" | "concept_doi">,
  publishStatus?: PublicationStatus | null,
): boolean {
  if (dataset.visibility !== "private") return false;
  if (dataset.concept_doi) return false;
  if (publishStatus?.status === "approved" || publishStatus?.status === "requested") return false;
  return true;
}

export function isPublishRequestable(
  dataset: Pick<Dataset, "visibility" | "concept_doi">,
  publishStatus?: PublicationStatus | null,
): boolean {
  if (dataset.visibility !== "private") return false;
  if (dataset.concept_doi) return false;
  if (publishStatus?.status === "requested" || publishStatus?.status === "approved") return false;
  if (publishStatus?.status === "blocked") return false;
  return true;
}

async function readError(res: Response): Promise<{ message?: string; code?: string }> {
  try {
    const body = (await res.json()) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return {};
    return {
      message:
        typeof body.message === "string"
          ? body.message
          : typeof body.error === "string"
            ? body.error
            : undefined,
      code: typeof body.error === "string" ? body.error : undefined,
    };
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}
