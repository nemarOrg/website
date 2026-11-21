/**
 * Hand copy of nemar-cli's `shared/contract/mail-categories.ts` (epic nemarOrg/nemar-cli#2260,
 * nemar-cli ADR 0132): the community mail categories, which a person may turn off, and the value an
 * account that never chose has.
 *
 * Only the parts this site reads are copied: the category ids in the order every surface lists
 * them, `canBeTurnedOff` and `defaultOn` per category, and the refusal codes of
 * `PUT /users/me/email-preferences`. Audiences and senders are the backend's business and are left
 * out on purpose. `test/mail-categories-drift.test.ts` compares this file with nemar-cli's.
 *
 * The words (labels, descriptions, why a recall cannot be turned off) are not here: they are
 * transcribed account copy (`./account-copy.ts`, nemar-cli ADR 0045), read through the three
 * helpers at the bottom, so a category without its two sentences does not compile.
 *
 * Browser-safe: imports nothing but the account-copy table.
 */

import { ACCOUNT_COPY } from "./account-copy";

/** The three categories a person may turn off, in the order every surface lists them. */
export const COMMUNITY_MAIL_CATEGORIES = ["news", "rfcs", "maintenance"] as const;
export type CommunityMailCategory = (typeof COMMUNITY_MAIL_CATEGORIES)[number];

/** Every category, recalls last. */
export const MAIL_CATEGORIES = ["news", "rfcs", "maintenance", "recall"] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];

/** The category that cannot be turned off. */
export const RECALL_CATEGORY = "recall" as const;

export interface MailCategoryDefinition {
  readonly id: MailCategory;
  /** False only for a recall: nothing may store or honor an opt-out of it. */
  readonly canBeTurnedOff: boolean;
  /** The value an account that never chose has. Meaningful only when `canBeTurnedOff`. */
  readonly defaultOn: boolean;
}

export const MAIL_CATEGORY_TABLE: Readonly<Record<MailCategory, MailCategoryDefinition>> = {
  news: { id: "news", canBeTurnedOff: true, defaultOn: true },
  rfcs: { id: "rfcs", canBeTurnedOff: true, defaultOn: true },
  maintenance: { id: "maintenance", canBeTurnedOff: true, defaultOn: true },
  recall: { id: "recall", canBeTurnedOff: false, defaultOn: true },
};

/**
 * The refusal codes of `PUT /users/me/email-preferences`. Each arrives with the sentence to show in
 * `message`, which is why the settings card shows the backend's `message` for these and never its
 * own words.
 */
export const SELF_MAIL_PREFERENCE_ERROR_CODES: readonly string[] = [
  "recall_cannot_be_turned_off",
  "admin_alert_not_self_service",
  "unknown_mail_preference",
  "invalid_mail_preference",
];

/** The community preferences as `GET`/`PUT /users/me/email-preferences` answer them. */
export type CommunityMailPreferences = { [K in CommunityMailCategory]: boolean };

export function isMailCategory(value: unknown): value is MailCategory {
  return typeof value === "string" && (MAIL_CATEGORIES as readonly string[]).includes(value);
}

export function isCommunityMailCategory(value: unknown): value is CommunityMailCategory {
  return (
    typeof value === "string" && (COMMUNITY_MAIL_CATEGORIES as readonly string[]).includes(value)
  );
}

/** A category's label, from the account copy. */
export function mailCategoryLabel(id: MailCategory): string {
  return ACCOUNT_COPY[`mail.category.${id}.label`];
}

/** A category's one-line description, from the account copy. */
export function mailCategoryDescription(id: MailCategory): string {
  return ACCOUNT_COPY[`mail.category.${id}.description`];
}

/** The sentence that says why a recall cannot be turned off. */
export function mailRecallWhy(): string {
  return ACCOUNT_COPY["mail.recall.why"];
}
