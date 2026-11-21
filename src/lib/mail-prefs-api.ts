/**
 * The Settings "Email" card's client (epic nemarOrg/nemar-cli#2260 phase 5): read and change the
 * three community mail categories through `GET`/`PUT /users/me/email-preferences`.
 *
 * Browser-safe, like `mail-admin-api.ts`: plain `fetch`, never `api-fetch.ts`. The calls go through
 * the same-origin `/api/v1` proxy, which forwards the session cookie and the browser's `Origin`
 * (a browser sends `Origin` on every same-origin PUT); the backend refuses a cookie-authenticated
 * PUT without a NEMAR `Origin`. Both answers are `no-store` at the backend and at the proxy.
 *
 * REFUSALS. A 400 from the PUT carries `{ error, field, message }`, where `message` is the sentence
 * to show (`SELF_MAIL_PREFERENCE_ERROR_CODES`). The card shows that sentence; this client never
 * words a refusal the backend already worded.
 */

import {
  COMMUNITY_MAIL_CATEGORIES,
  type CommunityMailCategory,
  type CommunityMailPreferences,
  SELF_MAIL_PREFERENCE_ERROR_CODES,
} from "./mail-categories";

/** The proxy path of the self-service preference route. */
export const MAIL_PREFERENCES_PATH = "/api/v1/users/me/email-preferences";

export type MailPreferencesResult =
  | { readonly ok: true; readonly prefs: CommunityMailPreferences }
  | {
      readonly ok: false;
      readonly status: number | "network";
      readonly code?: string;
      readonly message?: string;
    };

/**
 * The three switches out of the backend's view (`{news, rfcs, maintenance, recall: {on, locked}}`),
 * or null when any is not a boolean or the recall entry is not the locked constant: a body this card
 * cannot read must not render as a set of switches that look real.
 */
export function parseMailPreferences(raw: unknown): CommunityMailPreferences | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const recall = body.recall as Record<string, unknown> | undefined;
  if (!recall || recall.on !== true || recall.locked !== true) return null;
  const prefs: Partial<CommunityMailPreferences> = {};
  for (const category of COMMUNITY_MAIL_CATEGORIES) {
    const value = body[category];
    if (typeof value !== "boolean") return null;
    prefs[category] = value;
  }
  return prefs as CommunityMailPreferences;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function toResult(res: Response): Promise<MailPreferencesResult> {
  const body = await readJson(res);
  if (res.ok) {
    const prefs = parseMailPreferences(body);
    return prefs ? { ok: true, prefs } : { ok: false, status: res.status };
  }
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    ok: false,
    status: res.status,
    code: typeof b.error === "string" ? b.error : undefined,
    message: typeof b.message === "string" && b.message.length > 0 ? b.message : undefined,
  };
}

/** Read the account's three categories. */
export async function getMailPreferences(
  fetchImpl: typeof fetch = fetch,
): Promise<MailPreferencesResult> {
  try {
    const res = await fetchImpl(MAIL_PREFERENCES_PATH, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
    });
    return await toResult(res);
  } catch {
    return { ok: false, status: "network" };
  }
}

/** Turn one category on or off. Answers the three categories as they are now. */
export async function putMailPreference(
  category: CommunityMailCategory,
  on: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<MailPreferencesResult> {
  try {
    const res = await fetchImpl(MAIL_PREFERENCES_PATH, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      body: JSON.stringify({ [category]: on }),
    });
    return await toResult(res);
  } catch {
    return { ok: false, status: "network" };
  }
}

/** The sentence a failed load or save shows: the backend's own for its refusal codes. */
export function mailPreferencesErrorText(
  result: Extract<MailPreferencesResult, { ok: false }>,
): string {
  if (result.code && SELF_MAIL_PREFERENCE_ERROR_CODES.includes(result.code) && result.message) {
    return result.message;
  }
  if (result.status === 401) return "Your session expired. Sign in again.";
  if (result.status === 403) {
    return "NEMAR refused this change from this page. Reload and try again.";
  }
  if (result.status === 404) return "Email preferences aren't available yet. Check back soon.";
  if (result.status === 429) return "Too many changes. Wait a minute and try again.";
  if (result.status === "network") {
    return "NEMAR could not be reached. Check your connection and try again.";
  }
  return "NEMAR could not load or save your email preferences. Try again in a moment.";
}
