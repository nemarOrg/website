/**
 * The closed lists and bounds the admin Compute tab branches on, transcribed from nemar-cli
 * (website ADR 0030; epic nemarOrg/website#493 phase E4). A hand copy, drift-tested by
 * `test/compute-admin-contract-drift.test.ts` against:
 *
 *   shared/compute-access-state.ts      the states, the edges, the decisions and their targets
 *   shared/compute-state.ts             the job flags (the job states and front doors are
 *                                       `compute-contract.ts`'s, drift-tested by
 *                                       `test/compute-user-contract-drift.test.ts`)
 *   shared/contract/compute-access.ts   the decision error words, page and reason bounds
 *   shared/contract/compute-admin.ts    pool holder kinds, platform keys, page bounds
 *
 * Words this build does not know are a normal state of affairs (the API and the site deploy
 * independently), so every lookup that reads these has a defined answer for an unknown word
 * and the page prints it as text.
 *
 * A leaf module: no Astro, no network, nothing imported.
 */

/** The states an administrator can list. `none` is every account that never asked. */
export const COMPUTE_ACCESS_LISTED_STATES = [
  "requested",
  "active",
  "suspended",
  "denied",
  "revoked",
] as const;
export type ComputeAccessListedState = (typeof COMPUTE_ACCESS_LISTED_STATES)[number];

/** The four decisions an administrator takes, in the order the backend lists them. */
export const COMPUTE_ACCESS_DECISIONS = ["grant", "deny", "suspend", "revoke"] as const;
export type ComputeAccessDecision = (typeof COMPUTE_ACCESS_DECISIONS)[number];

/** The edges a decision may take, from each state (the backend's table; it still decides). */
export const COMPUTE_ACCESS_TRANSITIONS = {
  none: ["requested"],
  requested: ["active", "denied"],
  active: ["suspended", "revoked"],
  suspended: ["active", "revoked"],
  denied: ["active"],
  revoked: ["active"],
} as const satisfies Record<string, readonly string[]>;

/** The state each decision ends in. */
export const COMPUTE_DECISION_TARGET = {
  grant: "active",
  deny: "denied",
  suspend: "suspended",
  revoke: "revoked",
} as const satisfies Record<ComputeAccessDecision, string>;

/** The words a decision or the access listing refuses with, in `{ error: <sentence>, code: <word> }`. */
export const COMPUTE_ACCESS_ADMIN_ERROR_CODES = [
  "invalid_body",
  "invalid_query",
  "account_not_found",
  "not_requested",
  "not_active",
  "already_active",
  "self_decision",
  "account_not_in_good_standing",
  "stale_state",
  "policy_unreadable",
  "internal",
] as const;
export type ComputeAccessAdminErrorCode = (typeof COMPUTE_ACCESS_ADMIN_ERROR_CODES)[number];

/** The most characters (UTF-16 code units) an administrator's reason may have. */
export const COMPUTE_ACCESS_REASON_MAX_CHARS = 500;
/** The most accounts one listing answers with. */
export const COMPUTE_ACCESS_PAGE_MAX = 200;
/** The most pools one listing answers with. */
export const COMPUTE_POOLS_PAGE_MAX = 200;
/** The most rows one jobs or reporting read answers with. */
export const COMPUTE_REPORT_PAGE_MAX = 200;

/** Whose pool it is. */
export const COMPUTE_POOL_HOLDER_KINDS = ["account", "platform", "partner"] as const;
export type ComputePoolHolderKind = (typeof COMPUTE_POOL_HOLDER_KINDS)[number];

/** What an administrator is told about a job, besides its state. The API takes ONE per call. */
export const COMPUTE_JOB_FLAGS = ["unreserved", "unattributed", "mismatch", "overrun"] as const;
export type ComputeJobFlag = (typeof COMPUTE_JOB_FLAGS)[number];
