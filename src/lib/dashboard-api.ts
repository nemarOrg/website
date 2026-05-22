/**
 * Dashboard API client: list owned datasets, request publication, delete a
 * draft. These calls currently go to the local `/api/datasets/*` mock routes;
 * point them at `api.nemar.org` once nemar-cli#572 (cookie-aware auth) and
 * #575 (owner-deletion) land.
 */
import type { Dataset, DatasetListResponse } from "./types";

/**
 * The DB-side status of a publication_request row. Distinct from the
 * derived rendering state in {@link DatasetPublishState}.
 */
export type PublicationRequestStatus = "none" | "requested" | "approved" | "blocked";

/**
 * The frontend's rendering state for a dataset on the dashboard, computed
 * from `visibility + concept_doi + publication_request.status`.
 */
export type DatasetPublishState = "draft" | "awaiting_review" | "published" | "validation_failed";

/**
 * Discriminated union for the publication-request side. Required fields
 * differ by status; the union encodes the invariants so callers don't have
 * to guard timestamps after narrowing on `status`.
 */
export type PublicationStatus =
  | { readonly dataset_id: string; readonly status: "none" }
  | {
      readonly dataset_id: string;
      readonly status: "requested";
      readonly requested_at: string;
      readonly requested_by?: string;
      readonly ci_url?: string;
    }
  | {
      readonly dataset_id: string;
      readonly status: "approved";
      readonly requested_at: string;
      readonly approved_at: string;
      readonly requested_by?: string;
      readonly ci_url?: string;
    }
  | {
      readonly dataset_id: string;
      readonly status: "blocked";
      readonly requested_at: string;
      readonly block_reason: string;
      readonly requested_by?: string;
      readonly ci_url?: string;
    };

/**
 * Codes the dashboard mocks emit. `code` on `DashboardApiError` stays
 * `string` so that unknown codes from a future real backend don't blow up
 * type-checking at call sites; the union below documents what we expect.
 */
export type KnownErrorCode =
  | "not_implemented"
  | "bad_content_type"
  | "unauthenticated"
  | "invalid_json"
  | "invalid_name"
  | "invalid_files"
  | "empty_files"
  | "missing_id"
  | "not_found"
  | "already_published"
  | "already_in_flight"
  | "not_deletable"
  | "internal_error";

export class DashboardApiError extends Error {
  readonly status: number;
  readonly code?: KnownErrorCode | string;
  constructor(message: string, status: number, code?: KnownErrorCode | string) {
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
  // Explicit cookie forwarding for SSR callers: Astro's server-side fetch
  // doesn't carry the request cookie jar automatically. Currently unused
  // because dashboard.astro reads the store directly; needed once nemar-cli#572
  // routes through this function.
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
  publishStatus: PublicationStatus | null,
): DatasetPublishState {
  if (dataset.visibility === "public" || dataset.concept_doi) return "published";
  if (publishStatus?.status === "blocked") return "validation_failed";
  if (publishStatus?.status === "requested" || publishStatus?.status === "approved") {
    return "awaiting_review";
  }
  return "draft";
}

export function isDeletable(
  dataset: Pick<Dataset, "visibility" | "concept_doi">,
  publishStatus: PublicationStatus | null,
): boolean {
  if (dataset.visibility !== "private") return false;
  if (dataset.concept_doi) return false;
  if (publishStatus?.status === "approved" || publishStatus?.status === "requested") return false;
  return true;
}

export function isPublishRequestable(
  dataset: Pick<Dataset, "visibility" | "concept_doi">,
  publishStatus: PublicationStatus | null,
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
    const code = typeof body.error === "string" ? body.error : undefined;
    const message =
      typeof body.message === "string" && body.message.length > 0 ? body.message : undefined;
    return { message, code };
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}
