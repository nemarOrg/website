/**
 * Why a publication request is blocked, and what the owner should be told
 * (website#304).
 *
 * **The vocabulary is copied, not imported.** Its source of truth is
 * `publicationBlockReasonSchema` in nemar-cli's
 * `shared/contract/publication.ts`; the two repos share no package, so the
 * values are transcribed here with this comment naming where they came from —
 * the same arrangement `dashboard-api.ts` already has with
 * `PublicationRequestStatus`. Adding a reason upstream means adding it here.
 *
 * **Readers must degrade, not narrow.** `publication_requests.block_reason` is
 * free TEXT (nemar-cli migration 0015) and holds legacy values, so this is the
 * vocabulary a CURRENT backend writes rather than a database constraint. That
 * is why {@link blockBadgeState} takes a `string | null` and answers
 * `"blocked"` for anything it does not recognise, instead of typing the input
 * as the union and dropping the row — which is what the backend's own
 * `blockMessage` does (falling back to a generic sentence) and what the admin
 * queue does (rendering the raw code).
 */

/**
 * The reasons a current nemar-cli backend writes.
 *
 * Copied from `publicationBlockReasonSchema` in nemar-cli
 * `shared/contract/publication.ts`. Exported so a test can assert the badge
 * table covers every one of them.
 */
export const PUBLICATION_BLOCK_REASONS = [
  "bids_validation_failed",
  "bids_validation_pending",
  "bids_validation_in_progress",
  /** Legacy: the pre-screen stopped blocking in nemar-cli#756. */
  "prescreen_failed",
  "min_requirements_failed",
  /** nemar-cli#1255: the owner has no researcher name, so a DOI cannot cite
   *  them. An ACCOUNT property, not anything about the dataset — which is
   *  what makes "Validation failed" the wrong label for it. */
  "owner_name_missing",
] as const;

export type PublicationBlockReason = (typeof PUBLICATION_BLOCK_REASONS)[number];

/**
 * The two badge states a block can produce.
 *
 * `"validation_failed"` is the pre-existing one and keeps its meaning: the
 * dataset itself did not pass a gate, and the fix is in the repository.
 * `"name_required"` is new, because `owner_name_missing` is not about the
 * dataset at all — the owner fixes it in their account, and telling them
 * validation failed sends them to look at CI logs that are green.
 *
 * `"blocked"` is the honest answer for a value this build has never heard of:
 * the request IS blocked, and the backend's own `message` (rendered beside
 * the badge) is the thing that explains it. Guessing "Validation failed"
 * there would be asserting a cause nothing established.
 */
export type BlockBadgeState = "validation_failed" | "name_required" | "blocked";

const BLOCK_BADGE_STATES: Record<PublicationBlockReason, BlockBadgeState> = {
  bids_validation_failed: "validation_failed",
  bids_validation_pending: "validation_failed",
  bids_validation_in_progress: "validation_failed",
  prescreen_failed: "validation_failed",
  min_requirements_failed: "validation_failed",
  owner_name_missing: "name_required",
};

/**
 * Which badge a stored `block_reason` earns.
 *
 * `null` / `undefined` (a blocked row whose reason predates the column, or a
 * status payload that omitted it) answers `"blocked"` for the same reason an
 * unrecognised string does: the row is blocked and nothing here can say why.
 */
export function blockBadgeState(reason: string | null | undefined): BlockBadgeState {
  const key = reason ?? "";
  // `Object.hasOwn`, not a bare lookup: `block_reason` is free TEXT, so the
  // key is arbitrary backend-stored text, and a plain-object read would
  // resolve `constructor` / `toString` off the prototype and hand back a
  // FUNCTION as the badge state. The Settings page guards its ORCID error map
  // the same way for the same reason.
  if (!Object.hasOwn(BLOCK_BADGE_STATES, key)) return "blocked";
  return (BLOCK_BADGE_STATES as Record<string, BlockBadgeState>)[key];
}

/**
 * True when the fix is in the owner's ACCOUNT rather than in the dataset.
 *
 * Used to decide whether the card offers a Settings link alongside the
 * backend's message. Deliberately keyed on the badge state rather than on the
 * reason string, so a second account-shaped reason added upstream picks the
 * link up by being mapped, not by being listed twice.
 */
export function blockIsAccountFixable(reason: string | null | undefined): boolean {
  return blockBadgeState(reason) === "name_required";
}
