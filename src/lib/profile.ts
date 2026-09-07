/**
 * Profile completeness (#226).
 *
 * One definition of "complete" for the two things that still ask a yes/no
 * question about it: `canUpload` (ADR 0011's warn branch on `/upload`) and
 * the field list that branch names.
 *
 * **It is no longer what tells a user WHAT is missing.** That is
 * `./profile-gaps.ts` since website#309 — one line per field, saying what it
 * blocks and where it is set, in the sentence the CLI and the upload-access
 * refusal also print. The dashboard nudge used `missingProfileFields` plus
 * `formatFieldList` and had to guess a single consequence for the whole set;
 * the gap list states one per field instead. Anything that needs to
 * ENUMERATE gaps belongs there, not here.
 *
 * The two tiers are deliberately different in strength:
 *
 * - **city + country are required to upload.** They are the export-control
 *   screening inputs for the service-access tier (ADR 0010), collected at
 *   `/onboarding` and enforced by the upload-access request endpoint
 *   (nemar-cli `services/upload-access.ts`, which refuses a request missing
 *   either). On `/upload` itself they are now only a warning, and only for
 *   accounts that already hold the grant (#236, ADR 0011) — every such
 *   account predates the profile columns, so a block would lock out 100% of
 *   the people actually authorized to upload. See `deriveUploadPageState` in
 *   `./account-tier.ts`, which owns that decision now: an account without the
 *   grant no longer reaches the form at all, so there is nothing left for a
 *   profile check to withhold from it.
 * - **the GitHub handle is a nudge only.** It is required at *publish*, not
 *   before, matching the locked decision in #129. Gating upload on it would
 *   block people who have nothing to publish yet.
 *
 * Nothing here gates browsing or downloading. Base access stays open.
 */

import type { AuthUser } from "./auth";

/** A profile field the user can be prompted to fill in. */
export type ProfileField = "github_username" | "city" | "country";

export const PROFILE_FIELD_LABELS: Record<ProfileField, string> = {
  github_username: "GitHub handle",
  city: "city",
  country: "country",
};

/** Fields that must be present before a real (non-sandbox) upload. */
export const UPLOAD_REQUIRED_FIELDS: readonly ProfileField[] = ["city", "country"];

/** The default set for {@link missingProfileFields} — the three self-service
 *  columns, in prompt order. It was the dashboard nudge's list until
 *  website#309 moved that surface to `./profile-gaps.ts`; it stays as the
 *  default because `missingProfileFields` is still the "which of these are
 *  blank" primitive, and a default of "all of them" is the only one that is
 *  not a surprise. */
export const NUDGED_FIELDS: readonly ProfileField[] = ["city", "country", "github_username"];

function isBlank(value: string | undefined): boolean {
  return (value ?? "").trim().length === 0;
}

/**
 * Which of `fields` the user has not filled in, in the order given.
 * Treats whitespace-only as missing: the backend trims on write
 * (`normalizeProfilePatch`, nemar-cli#912), so a value that is only spaces
 * never round-trips as one.
 */
export function missingProfileFields(
  user: Pick<AuthUser, "github_username" | "city" | "country"> | null | undefined,
  fields: readonly ProfileField[] = NUDGED_FIELDS,
): ProfileField[] {
  if (!user) return [...fields];
  return fields.filter((field) => isBlank(user[field]));
}

/**
 * True when the user may start a real upload. Admins are not exempt: the
 * screening is about the person, not their privileges.
 */
export function canUpload(
  user: Pick<AuthUser, "github_username" | "city" | "country"> | null | undefined,
): boolean {
  return missingProfileFields(user, UPLOAD_REQUIRED_FIELDS).length === 0;
}

/**
 * "city and country", "city", "GitHub handle and country" — an English list
 * of field labels for prompt copy. Oxford comma at three or more, which is
 * only reachable from the nudge (the upload gate names at most two).
 */
export function formatFieldList(fields: readonly ProfileField[]): string {
  const labels = fields.map((f) => PROFILE_FIELD_LABELS[f]);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}
