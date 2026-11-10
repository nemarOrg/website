/**
 * The vocabulary the `/compute` page depends on, copied by hand from nemar-cli (website ADR 0030 and
 * its phase E2 addendum; ADR 0015: transcribed, not imported). `test/compute-user-contract-drift.test.ts`
 * reads the originals as text, so a word that moves on one side fails CI instead of rendering as an
 * unknown pill.
 *
 * Sources, all in nemar-cli:
 *  - `shared/compute-state.ts`: the ten job states, the terminal ones, the four front doors.
 *  - `shared/compute-access-state.ts`: see `./compute-access-state.ts` (already transcribed).
 *  - `shared/contract/compute-user.ts`: the page bounds, the usage groups, the minimum queue sample,
 *    and the words a read refusal carries.
 *  - `shared/contract/compute.ts`: the job id shape.
 *  - `shared/compute-state.ts` again (phase E3, the job page): the three groups of failure codes and
 *    the status each job-route refusal answers with.
 *  - `shared/contract/compute-submit.ts` (phase E3): the truncated-log header, the log and result-page
 *    bounds, and the one sentence this site transcribes (`upload_expired`; every other refusal sentence
 *    is shown as the backend served it).
 *  - `shared/contract/compute-responses.ts` (phase E3): the cancel outcomes.
 *
 * This is the ONE place the job-state and front-door vocabulary lives on this site
 * (`COMPUTE_JOB_STATES`, `COMPUTE_JOB_SOURCES`, ...): the dashboard and the admin compute tab import it.
 * A leaf module on purpose: it imports nothing and is safe in the browser bundle. It carries words and
 * numbers only; what they mean is the backend's (ADR 0030).
 */

/** Every state of a job, in the order of the backend's table. */
export const COMPUTE_JOB_STATES = [
  "created",
  "uploading",
  "submitted",
  "queued",
  "running",
  "archiving",
  "finished",
  "failed",
  "cancelled",
  "unreported",
] as const;

export type ComputeJobState = (typeof COMPUTE_JOB_STATES)[number];

/** A terminal job never moves again, so its charge is settled once. */
export const COMPUTE_TERMINAL_STATES = ["finished", "failed", "cancelled"] as const;

/** The front door that submitted a job. */
export const COMPUTE_JOB_SOURCES = ["cli", "web", "partner", "pipeline"] as const;

export type ComputeJobSource = (typeof COMPUTE_JOB_SOURCES)[number];

/** The groups `GET /compute/me/usage` may be grouped by. */
export const COMPUTE_USAGE_GROUPS = ["day", "app", "partition", "source"] as const;

/** The most jobs one page of `GET /compute/me/jobs` holds, and the page when `limit` is absent. */
export const COMPUTE_JOBS_PAGE_DEFAULT = 25;
export const COMPUTE_JOBS_PAGE_MAX = 100;

/** The longest usage window the route answers for, both ends counted. */
export const COMPUTE_WINDOW_MAX_DAYS = 366;

/** Fewer started jobs than this give null queue figures with the count. */
export const COMPUTE_QUEUE_MIN_SAMPLES = 5;

/** A job id: `job_` and 24 lowercase hex digits. */
export const COMPUTE_JOB_ID_RE = /^job_[0-9a-f]{24}$/;

/** Every word a read route answers a refusal with, and its status. */
export const COMPUTE_USER_ERROR_STATUS = {
  forbidden_credential: 403,
  insufficient_scope: 403,
  invalid_token: 401,
  missing_credential: 401,
  invalid_range: 400,
  invalid_group: 400,
  invalid_state: 400,
  invalid_limit: 400,
  invalid_cursor: 400,
  job_not_found: 404,
  policy_unavailable: 503,
} as const;

export type ComputeUserErrorCode = keyof typeof COMPUTE_USER_ERROR_STATUS;

export function isComputeJobState(value: unknown): value is ComputeJobState {
  return typeof value === "string" && (COMPUTE_JOB_STATES as readonly string[]).includes(value);
}

export function isTerminalComputeState(state: string): boolean {
  return (COMPUTE_TERMINAL_STATES as readonly string[]).includes(state);
}

// --- The job page (phase E3, website#496) ---------------------------------------------------------

/**
 * What the launcher on the node writes, in the order of its exit numbers (nemar-cli
 * `LAUNCHER_FAILURE_CODES`).
 */
export const COMPUTE_LAUNCHER_FAILURE_CODES = [
  "code_fetch_failed",
  "dataset_fetch_failed",
  "entry_not_found",
  "runtime_error",
  "out_of_memory",
  "time_limit",
  "result_upload_failed",
] as const;

/** The failures of the platform's own steps (nemar-cli `PLATFORM_FAILURE_CODES`; three repeat the launcher's). */
export const COMPUTE_PLATFORM_FAILURE_CODES = [
  "code_fetch_failed",
  "dataset_fetch_failed",
  "tapis_submit_failed",
  "submit_timeout",
  "staging_failed",
  "launch_failed",
  "archive_failed",
  "tapis_error",
  "result_verification_failed",
  "records_unavailable",
  "result_upload_failed",
  "tapis_record_lost",
] as const;

/** Failures that are no launcher code (nemar-cli `SUBMITTER_FAILURE_CODES`). */
export const COMPUTE_SUBMITTER_FAILURE_CODES = ["upload_expired"] as const;

/**
 * Every code a failed job may carry, each once, in the backend's order: the launcher's, the platform's
 * rest, the submitter's. The groups above are transcribed and drift-tested separately so a code that
 * moves between them still passes.
 */
export const COMPUTE_FAILURE_CODES: readonly string[] = [
  ...COMPUTE_LAUNCHER_FAILURE_CODES,
  ...COMPUTE_PLATFORM_FAILURE_CODES.filter(
    (c) => !(COMPUTE_LAUNCHER_FAILURE_CODES as readonly string[]).includes(c),
  ),
  ...COMPUTE_SUBMITTER_FAILURE_CODES,
];

/** What `POST /compute/jobs/:id/cancel` may answer in `outcome` today (the field is open). */
export const COMPUTE_CANCEL_OUTCOMES = [
  "cancel_requested",
  "already_cancelled",
  "already_ended",
] as const;

/** The response header on a log cut at {@link COMPUTE_LOG_MAX_BYTES}; its value is `true`. */
export const COMPUTE_TRUNCATED_HEADER = "X-Nemar-Truncated";

/** The most bytes the log route returns: the FIRST 1 MiB of the log. */
export const COMPUTE_LOG_MAX_BYTES = 1024 * 1024;

/** The most result links one answer holds; `next_after` pages on. */
export const COMPUTE_RESULTS_PAGE_MAX = 1000;

/** The status each refusal of the job routes (log, results, renew, cancel, job read) answers with. */
export const COMPUTE_JOB_ROUTE_STATUS = {
  job_not_found: 404,
  logs_not_available: 404,
  bad_state: 409,
  results_expired: 410,
  invalid_spec: 400,
  compute_disabled: 503,
  storage_unavailable: 503,
} as const;

export type ComputeJobRouteCode = keyof typeof COMPUTE_JOB_ROUTE_STATUS;

/** The backend's sentence for a job whose code bundle was never finalized (nemar-cli `COMPUTE_SUBMIT_SENTENCES`). */
export const COMPUTE_UPLOAD_EXPIRED_SENTENCE =
  "The upload window closed and the job was ended; submit it again.";
