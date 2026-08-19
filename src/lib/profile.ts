/**
 * Profile completeness (#226).
 *
 * One definition of "complete", shared by the dashboard nudge, the upload
 * gate, and Settings, so the three surfaces can never disagree about what
 * they are asking for.
 *
 * The two tiers are deliberately different in strength:
 *
 * - **city + country are required to upload.** They are the export-control
 *   screening inputs for the service-access tier (ADR 0010). For users who
 *   do NOT yet hold a service-access grant this is a hard gate; for users
 *   an admin already granted service access it is a prominent warning
 *   instead (#236, ADR 0011) — every existing uploader predates the profile
 *   columns, so a hard block would lock out 100% of the people actually
 *   authorized to upload. See {@link uploadGate}.
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

/** Every field the nudge asks about, in prompt order. */
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
 * What /upload should render (#236, ADR 0011):
 *
 * - `"open"`  — profile complete; render the form, no gate copy.
 * - `"warn"`  — profile incomplete, but an admin already granted the user
 *   service access (ADR 0010). Render the form with a prominent,
 *   non-blocking prompt to finish the profile. These users were authorized
 *   before the city/country columns existed; blocking them on two empty
 *   fields punishes exactly the population the tier was built to admit.
 * - `"block"` — profile incomplete and no service-access grant (or the
 *   backend did not send the flag — fail closed). Withhold the form; this
 *   is where the export-control prompt must be answered before anything
 *   else, since these users have no prior admin review on record.
 *
 * Access control does not live here either way: the backend rejects real
 * uploads without `service_access` + `sandbox_completed`
 * (nemar-cli backend/src/services/upload-gate.ts), so "warn" never lets an
 * unauthorized upload through — it only stops blocking authorized ones.
 */
export type UploadGate = "open" | "warn" | "block";

export function uploadGate(
  user:
    | Pick<AuthUser, "github_username" | "city" | "country" | "service_access">
    | null
    | undefined,
): UploadGate {
  if (canUpload(user)) return "open";
  return user?.service_access === true ? "warn" : "block";
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
