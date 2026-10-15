/**
 * Admin API client: list publication requests, read a request's publication
 * review, start that review, deny a request, and start its approval. SSR callers pass `cookieHeader` and hit `api.nemar.org` directly;
 * browser callers go through the same-origin `/api/v1` proxy (see
 * `dashboardApiBase` in `./api-base.ts`) so the session cookie attaches
 * automatically without broadening it to other `*.nemar.org` hosts.
 */
import { dashboardApiBase, readError } from "./api-base";
import { DashboardApiError, deriveAdminBadgeState } from "./dashboard-api";
import type {
  ApiFailure,
  ApproveBody,
  PublicationReviewDetail,
  StartStartedReason,
  Tone,
} from "./publication-review";
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
 * - `review`: the review detail reads several tables, so it sits above a plain
 *   list read. A judgment, not a measurement.
 * - `start`: one DB claim plus one GitHub `repository_dispatch`, like `dispatch`.
 */
export const ADMIN_TIMEOUTS_MS = {
  list: DEFAULT_REQUEST_TIMEOUT_MS,
  deny: 15_000,
  dispatch: 15_000,
  review: 10_000,
  start: 15_000,
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
  /**
   * The identifier screen's verdict as the Worker words it, and the publication review's summary.
   * List rows of a Worker that predates the review omit both, so the page reads them as optional.
   */
  readonly identifier_screen?: {
    readonly state: string | null;
    readonly headline: string;
    readonly tone: Tone;
    readonly lines: readonly string[];
  };
  /**
   * The list row's review summary. `kind`, `gate` and `outcome` are LOOSE on purpose (plain
   * strings, not the contract's unions): the page only prints the headline and tone and never
   * branches on these words, so a word a newer Worker adds cannot break it.
   */
  readonly publication_review?: {
    readonly kind: string;
    readonly enabled: boolean;
    readonly gate: string;
    readonly outcome: string | null;
    readonly headline: string;
    readonly tone: Tone;
    readonly reasons: readonly string[];
    readonly start_offered: boolean;
    readonly review_id: number | null;
    readonly head_sha: string | null;
  };
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

/**
 * A failed call of the publication routes: a `DashboardApiError` that also carries what the Worker
 * said, so `describeFailure` can pick the words (the mapper in `publication-review.ts` reads
 * `failure`; `message` and the `name` stay what every older caller reads).
 *
 * `code` is the Worker's WORD on every route (`failure.code`), or undefined when the Worker sent
 * only a sentence; it is never a sentence. `failure` carries the rest, and is what callers read.
 */
export class PublicationApiError extends DashboardApiError {
  readonly failure: ApiFailure;
  constructor(message: string, status: number, code: string | undefined, failure: ApiFailure) {
    super(message, status, code);
    this.failure = failure;
  }
}

const CODE_WORD = /^[a-z][a-z0-9_]*$/;

/**
 * Read a failed answer into what the page needs, whichever convention carried it.
 *
 * Three conventions meet at these routes: the approval, deny and gate routes send the code in
 * `error` and a sentence in `message`; the review routes send a sentence in `error` and the code in
 * `code`; the origin guard sends the word in both and a sentence in `message`. The deny route's
 * validation failure sends an OBJECT in `error`, which names no code and no sentence, so it is read
 * as unknown rather than printed. `readError` (shared by every client) is left as it is.
 */
export async function readFailure(res: Response): Promise<ApiFailure> {
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    if (err instanceof SyntaxError) return { status: res.status };
    throw err;
  }
  if (!body || typeof body !== "object") return { status: res.status };
  const b = body as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const error = str(b.error);
  const errorIsWord = error !== undefined && CODE_WORD.test(error);
  const message =
    typeof b.message === "string" && b.message.length > 0
      ? b.message
      : error !== undefined && error.length > 0 && !errorIsWord
        ? error
        : undefined;
  const code = str(b.code) ?? (errorIsWord ? error : undefined);
  const refusal = str(b.refusal);
  const gate = str(b.gate);
  const headline = str(b.headline);
  return {
    status: res.status,
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    ...(refusal === undefined ? {} : { refusal }),
    ...(gate === undefined ? {} : { gate }),
    ...(headline === undefined ? {} : { headline }),
  };
}

/**
 * Throw the failure of a mutation. The older message text (from `readError`, whose sentence-valued
 * `code` becomes the message when nothing else says it) is kept so every existing caller and test
 * reads what it always read; `code` is the word, as on the review routes, and `failure` the reading.
 */
async function throwFailure(res: Response, lead: string): Promise<never> {
  const legacy = await readError(res.clone());
  const failure = await readFailure(res);
  throw new PublicationApiError(
    `${lead}: ${failureText(legacy, res)}`,
    res.status,
    failure.code,
    failure,
  );
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
 *
 * The body is REQUIRED: it names the request the click was for and carries the
 * administrator's answers to the gates. There is no bodyless click.
 */
export async function dispatchPublicationApproval(
  datasetId: string,
  init: Init & { readonly body: ApproveBody },
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
      body: JSON.stringify(init.body),
      signal: resolveSignal(init, ADMIN_TIMEOUTS_MS.dispatch),
    },
  );
  if (!res.ok) await throwFailure(res, "Approval was not started");
  return (await res.json()) as PublicationDispatchResponse;
}

/** What `POST /admin/publish/:id/deny` answers (nemar-cli `routes/admin/publish.ts`). */
export interface PublicationDenyResponse {
  readonly message: string;
  readonly dataset_id: string;
  readonly reason: string;
}

/** The request id is REQUIRED: a denial names the request the click was for, so a stale row is refused. */
export async function denyPublicationRequest(
  datasetId: string,
  reason: string,
  init: Init & { readonly requestId: number },
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
      body: JSON.stringify({ reason: trimmed, request_id: init.requestId }),
      signal: resolveSignal(init, ADMIN_TIMEOUTS_MS.deny),
    },
  );
  if (!res.ok) await throwFailure(res, "Deny failed");
  return (await res.json()) as PublicationDenyResponse;
}

/**
 * What a started review answers (HTTP 202); a refusal is a failure, not this. Transcribed from
 * `StartedPublicationReview` in nemar-cli `shared/contract/publication-review-admin.ts`. The page
 * reads only `reason`, and a word it does not know says nothing (`describeStartSuccess`).
 */
export interface StartedPublicationReview {
  readonly environment: "production" | "non-production";
  readonly started: true;
  readonly reason: StartStartedReason;
  readonly review_id: number;
}

/** Throw the failure of a review route, whose `error` is a sentence and whose `code` is the word. */
async function throwReviewFailure(res: Response, lead: string): Promise<never> {
  const failure = await readFailure(res);
  throw new PublicationApiError(
    `${lead}: ${failure.message ?? res.statusText}`,
    res.status,
    failure.code,
    failure,
  );
}

/**
 * The review of a dataset's active publication request: the reasons, the identifier screen and the
 * model's text, in the API's own words. A GET with no body and no content type.
 */
export async function getPublicationReview(
  datasetId: string,
  init: Init = {},
): Promise<PublicationReviewDetail> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/publish/${encodeURIComponent(datasetId)}/review`,
    {
      method: "GET",
      headers,
      credentials: "include",
      signal: resolveSignal(init, ADMIN_TIMEOUTS_MS.review),
    },
  );
  if (!res.ok) await throwReviewFailure(res, "Could not read the review");
  return (await res.json()) as PublicationReviewDetail;
}

/**
 * Ask the API to start the review of the request's screened commit. The route reads no body, so
 * this sends none and no content type.
 */
export async function startPublicationReview(
  datasetId: string,
  init: Init = {},
): Promise<StartedPublicationReview> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/publish/${encodeURIComponent(datasetId)}/review/start`,
    {
      method: "POST",
      headers,
      credentials: "include",
      signal: resolveSignal(init, ADMIN_TIMEOUTS_MS.start),
    },
  );
  if (!res.ok) await throwReviewFailure(res, "The review was not started");
  return (await res.json()) as StartedPublicationReview;
}

/** Re-export to keep admin surfaces importing from a single module. */
export { deriveAdminBadgeState };
