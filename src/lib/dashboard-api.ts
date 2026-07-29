/**
 * Dashboard API client: list owned datasets, request publication, delete a
 * draft. SSR callers pass `cookieHeader` and hit `api.nemar.org` directly.
 * Browser callers hit the same-origin `/api/v1` proxy (see `dashboardApiBase`
 * in `./api-base.ts`) so the `Domain=app.nemar.org` session cookie attaches
 * automatically without broadening it to all `*.nemar.org` siblings.
 */
import { dashboardApiBase, readError } from "./api-base";
import {
  DECORATIVE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveSignal,
} from "./request-deadline";
import type { Dataset, DatasetListResponse } from "./types";

type Init = {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly cookieHeader?: string;
  /** Abort the request after this many ms. See {@link DASHBOARD_TIMEOUTS_MS}. */
  readonly timeoutMs?: number;
};

/**
 * Per-operation request deadlines, exported so the difference between them is
 * a pinned contract rather than loose magic numbers.
 *
 * - `list` — the dashboard's primary content; base deadline.
 * - `status` — `getPublishStatus`, fanned out one call per visible dataset
 *   (up to the 50-per-page cap) to render a badge. `Promise.all` means the
 *   fan-out costs one deadline rather than N, and each failure already
 *   degrades to a "draft" badge, so this gets the decorative deadline: a
 *   degraded backend should cost the dashboard its pills, not its render.
 * - `mutate` — `requestPublication` and `deleteDraftDataset`. Both do real
 *   backend work (handing off to the publish orchestrator; a cascade delete)
 *   and both are user-initiated clicks with a spinner, so a longer wait
 *   degrades one button rather than the whole page.
 */
export const DASHBOARD_TIMEOUTS_MS = {
  list: DEFAULT_REQUEST_TIMEOUT_MS,
  status: DECORATIVE_TIMEOUT_MS,
  mutate: 15_000,
} as const;

/**
 * The DB-side status of a publication_request row. Mirrors the backend's
 * enum exactly so we can shuttle values through without lossy translation.
 * Distinct from the derived rendering state in {@link DatasetPublishState}.
 */
export type PublicationRequestStatus =
  | "none"
  | "requested"
  | "approving"
  | "published"
  | "denied"
  | "blocked";

/**
 * The frontend's rendering state for a dataset on the dashboard, computed
 * from `visibility + concept_doi + publication_request.status`.
 */
export type DatasetPublishState =
  | "draft"
  | "awaiting_review"
  | "published"
  | "validation_failed"
  | "denied";

/**
 * Discriminated union for the publication-request side. Required fields
 * differ by status; the union encodes the invariants so callers don't have
 * to guard timestamps after narrowing on `status`. `requested_by` is required
 * on every non-`"none"` branch — the backend creates these rows in response
 * to a user-initiated request, so the field is always set in practice.
 */
export type PublicationStatus =
  | { readonly dataset_id: string; readonly status: "none" }
  | {
      readonly dataset_id: string;
      readonly status: "requested";
      readonly requested_at: string;
      readonly requested_by: string;
      readonly ci_url?: string;
    }
  | {
      readonly dataset_id: string;
      readonly status: "approving";
      readonly requested_at: string;
      readonly approval_started_at: string;
      readonly requested_by: string;
      readonly ci_url?: string;
    }
  | {
      // The backend always reaches `"published"` via `"approving"`, so
      // `approval_started_at` and `published_at` are both required.
      readonly dataset_id: string;
      readonly status: "published";
      readonly requested_at: string;
      readonly approval_started_at: string;
      readonly published_at: string;
      readonly requested_by: string;
      readonly ci_url?: string;
    }
  | {
      readonly dataset_id: string;
      readonly status: "denied";
      readonly requested_at: string;
      readonly denied_at: string;
      readonly denied_reason: string;
      readonly requested_by: string;
      readonly ci_url?: string;
    }
  | {
      readonly dataset_id: string;
      readonly status: "blocked";
      readonly requested_at: string;
      readonly blocked_at: string;
      readonly block_reason: string;
      readonly requested_by: string;
      readonly ci_url?: string;
    };

export type KnownErrorCode =
  | "not_implemented"
  | "bad_content_type"
  | "unauthenticated"
  | "forbidden"
  | "invalid_json"
  | "invalid_name"
  | "invalid_files"
  | "empty_files"
  | "missing_id"
  | "missing_field"
  | "not_found"
  | "already_published"
  | "already_in_flight"
  | "not_deletable"
  | "not_invitable"
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
  init: Init = {},
): Promise<DatasetListResponse> {
  const params = new URLSearchParams({ mine: "true" });
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const url = `${dashboardApiBase(init.cookieHeader)}/datasets?${params.toString()}`;
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(url, {
    method: "GET",
    headers,
    credentials: "include",
    signal: resolveSignal(init, DASHBOARD_TIMEOUTS_MS.list),
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

export async function getPublishStatus(
  datasetId: string,
  init: Init = {},
): Promise<PublicationStatus | null> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/datasets/${encodeURIComponent(datasetId)}/publish/status`,
    {
      method: "GET",
      headers,
      credentials: "include",
      signal: resolveSignal(init, DASHBOARD_TIMEOUTS_MS.status),
    },
  );
  // 404 here means "no publication-request row yet"; that's a valid domain
  // default for fresh datasets and maps to the "draft" badge state.
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Publish status failed: ${detail.message ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as PublicationStatus;
}

export async function requestPublication(id: string, init: Init = {}): Promise<PublicationStatus> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/datasets/${encodeURIComponent(id)}/publish/request`,
    {
      method: "POST",
      headers,
      credentials: "include",
      body: "{}",
      signal: resolveSignal(init, DASHBOARD_TIMEOUTS_MS.mutate),
    },
  );
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

export async function deleteDraftDataset(id: string, init: Init = {}): Promise<{ ok: true }> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/datasets/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers,
      credentials: "include",
      body: "{}",
      signal: resolveSignal(init, DASHBOARD_TIMEOUTS_MS.mutate),
    },
  );
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
  // Dataset visibility is authoritative: if the orchestrator has flipped
  // the dataset to public (or assigned a DOI), the surface is published
  // regardless of the publication-request row.
  if (dataset.visibility === "public" || dataset.concept_doi) return "published";
  if (publishStatus?.status === "blocked") return "validation_failed";
  if (publishStatus?.status === "denied") return "denied";
  // `"published"` here means the backend's publication_request row says
  // published but the dataset hasn't flipped yet — the orchestrator window.
  // We show "awaiting review" until the visibility check above resolves it.
  if (
    publishStatus?.status === "requested" ||
    publishStatus?.status === "approving" ||
    publishStatus?.status === "published"
  ) {
    return "awaiting_review";
  }
  return "draft";
}

/**
 * Status-only badge state for admin surfaces, where we don't have a Dataset
 * on hand. `"published"` here surfaces as "Published" (the orchestrator is
 * done from the admin's perspective). The owner-side `derivePublishState`
 * keeps it as "awaiting_review" until the dataset row flips.
 */
export function deriveAdminBadgeState(
  publishStatus: PublicationStatus | null,
): DatasetPublishState {
  if (!publishStatus || publishStatus.status === "none") return "draft";
  if (publishStatus.status === "published") return "published";
  if (publishStatus.status === "blocked") return "validation_failed";
  if (publishStatus.status === "denied") return "denied";
  return "awaiting_review";
}

export function isDeletable(
  dataset: Pick<Dataset, "visibility" | "concept_doi">,
  publishStatus: PublicationStatus | null,
): boolean {
  if (dataset.visibility !== "private") return false;
  if (dataset.concept_doi) return false;
  if (
    publishStatus?.status === "requested" ||
    publishStatus?.status === "approving" ||
    publishStatus?.status === "published"
  ) {
    return false;
  }
  return true;
}

export function isPublishRequestable(
  dataset: Pick<Dataset, "visibility" | "concept_doi">,
  publishStatus: PublicationStatus | null,
): boolean {
  if (dataset.visibility !== "private") return false;
  if (dataset.concept_doi) return false;
  if (
    publishStatus?.status === "requested" ||
    publishStatus?.status === "approving" ||
    publishStatus?.status === "published"
  ) {
    return false;
  }
  // Blocked (BIDS validation failed) requires the owner to fix and re-upload
  // before re-requesting. Denied (admin rejected with a reason) allows the
  // owner to re-request after addressing the feedback.
  if (publishStatus?.status === "blocked") return false;
  return true;
}
