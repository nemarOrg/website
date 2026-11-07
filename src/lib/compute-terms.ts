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
 * A stale value is not a silent failure: the backend answers 400
 * `terms_not_accepted` and the card prints that refusal.
 */
export const COMPUTE_TERMS_VERSION = "2026-11-draft";
