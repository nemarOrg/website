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
