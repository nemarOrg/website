/**
 * The six states of a person's compute access, as `/auth/me` reports them
 * (nemar-cli ADR 0118, the compute-access addendum, epic #2021 phase D1;
 * `shared/compute-access-state.ts` there).
 *
 * A leaf module on purpose: `auth.ts` types the session user with it and
 * `middleware.ts` validates the wire value against it, and neither may pull
 * in the page helpers. It carries the vocabulary only. The edges between the
 * states (who may move an account from one to another) are the backend's, and
 * the website decides none of them (ADR 0030).
 *
 *   none       never asked
 *   requested  asked once; an administrator has not answered
 *   active     granted; the only state that may use compute
 *   suspended  an administrator paused it
 *   denied     an administrator declined the request
 *   revoked    an administrator ended it, or the account itself ended
 */

export const COMPUTE_ACCESS_STATES = [
  "none",
  "requested",
  "active",
  "suspended",
  "denied",
  "revoked",
] as const;

export type ComputeAccessState = (typeof COMPUTE_ACCESS_STATES)[number];

export function isComputeAccessState(value: unknown): value is ComputeAccessState {
  return typeof value === "string" && (COMPUTE_ACCESS_STATES as readonly string[]).includes(value);
}
