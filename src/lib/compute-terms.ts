/**
 * The compute terms version a request must name (`accept_terms_version`).
 *
 * INTERIM (website ADR 0030). The backend's current version is
 * `COMPUTE_TERMS_VERSION` in nemar-cli `shared/contract/compute-terms.ts`, and
 * the intended route for the website to learn it is `GET /compute/me`
 * (`current_terms_version`), which phase D2 serves. Until a page reads that,
 * the version is transcribed here and checked by
 * `test/compute-terms-contract-drift.test.ts`. When D2 lands, this file is
 * deleted and the card takes the version from the server-side read.
 *
 * `COMPUTE_TERMS_PUBLISHED` mirrors nemar-cli's constant of the same name, and is drift-tested the same
 * way. While it is false the site raises no compute nudge from its own gap table (`profileGaps`: the
 * Affiliation gap, and `compute_access` among any other gap's blocks), exactly as nemar-cli's
 * `computeProfileGaps` does for `profile_gaps` on the wire: the owner's ruling is that nothing may
 * point an account at a compute request that cannot succeed yet. It changes in the same reviewed
 * change as nemar-cli's constant and `COMPUTE_REQUESTS_ENABLED` (`flags.ts`).
 *
 * A stale value is not a silent failure: the backend answers 400
 * `terms_not_accepted` and the card prints that refusal.
 */
export const COMPUTE_TERMS_VERSION = "2026-11-draft";

/** Whether the compute terms are published: false while they are a held draft (see above). */
export const COMPUTE_TERMS_PUBLISHED = false;
