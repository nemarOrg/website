/**
 * The unsubscribe page's rules (epic nemarOrg/nemar-cli#2260 phase 5, nemar-cli ADR 0132): the
 * token's shape, the result a form post comes back with, and the view the page renders. Pure, so
 * every state is tested without a renderer; the network half is `./mail-unsubscribe-api.ts`.
 *
 * THE LINK IS THE WHOLE AUTHORITY. A community mail carries
 * `/unsubscribe/v1.<user id>.<category>.<broadcast id>.<signature>`; the backend verifies it and can
 * do exactly one thing with it, turn mail off. The page never acts on load (mail scanners and link
 * previews fetch every link they find): it shows two buttons, and only a press changes anything.
 *
 * The token shape here is the backend's `TOKEN_RE` (`backend/src/services/mail-links.ts`), checked
 * before anything is sent upstream, so a path that cannot be a link costs no API call and can never
 * be spliced into a URL or a redirect.
 */

import { isCommunityMailCategory, mailCategoryLabel } from "./mail-categories";

/** nemar-cli's token pattern, character for character. */
export const MAIL_UNSUBSCRIBE_TOKEN_RE =
  /^v1\.(\d{1,12})\.([a-z]{1,16})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

export function isMailUnsubscribeToken(value: unknown): value is string {
  return typeof value === "string" && MAIL_UNSUBSCRIBE_TOKEN_RE.test(value);
}

/** The page every button returns to, with the result of the press when there was one. */
export const UNSUBSCRIBE_PAGE_PREFIX = "/unsubscribe/";

/** Which button was pressed: the link's own category, or all three community categories. */
export const UNSUBSCRIBE_SCOPES = ["category", "all"] as const;
export type UnsubscribeScope = (typeof UNSUBSCRIBE_SCOPES)[number];

export function isUnsubscribeScope(value: unknown): value is UnsubscribeScope {
  return typeof value === "string" && (UNSUBSCRIBE_SCOPES as readonly string[]).includes(value);
}

/**
 * What a press came back with, carried in `?result=`:
 *   `category` / `all`  the backend answered 200 for that scope;
 *   `invalid`           the backend answered 410 `link_invalid`;
 *   `error`             anything else (a 429, a 503, a network failure).
 * The page does not take `category` or `all` on trust: it shows "done" only when the backend's own
 * answer says the category is off now, so a hand-typed `?result=all` shows nothing false.
 */
export const UNSUBSCRIBE_RESULTS = ["category", "all", "invalid", "error"] as const;
export type UnsubscribeResult = (typeof UNSUBSCRIBE_RESULTS)[number];

export function parseUnsubscribeResult(value: string | null | undefined): UnsubscribeResult | null {
  return typeof value === "string" && (UNSUBSCRIBE_RESULTS as readonly string[]).includes(value)
    ? (value as UnsubscribeResult)
    : null;
}

/** The page path for a token (already shape-checked) and an optional result. */
export function unsubscribePagePath(token: string, result?: UnsubscribeResult): string {
  const path = `${UNSUBSCRIBE_PAGE_PREFIX}${token}`;
  return result ? `${path}?result=${result}` : path;
}

/** The result a forwarded press maps to, from the backend's status. */
export function resultForForwardStatus(
  status: number | "network",
  scope: UnsubscribeScope,
): UnsubscribeResult {
  if (status === 200) return scope;
  if (status === 410) return "invalid";
  return "error";
}

/** `GET /mail/unsubscribe/:token/info` on a 200. */
export interface UnsubscribeInfo {
  readonly category: string;
  readonly label: string;
  readonly maskedEmail: string;
  /** Whether the link's category is on now. */
  readonly on: boolean;
}

export type InfoOutcome =
  | { readonly kind: "valid"; readonly info: UnsubscribeInfo }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

/**
 * Read the info answer. 200 with the four fields is a valid link; 410 is the backend's single answer
 * for every dead link. Everything else (a 503 with no link secret, a 429, a malformed body, the
 * network) is "unavailable": the link may be fine, and saying it is invalid would be false.
 */
export function parseUnsubscribeInfo(status: number | "network", body: unknown): InfoOutcome {
  if (status === 410) return { kind: "invalid" };
  if (status !== 200 || !body || typeof body !== "object") return { kind: "unavailable" };
  const b = body as Record<string, unknown>;
  if (
    typeof b.category !== "string" ||
    typeof b.label !== "string" ||
    typeof b.masked_email !== "string" ||
    typeof b.on !== "boolean"
  ) {
    return { kind: "unavailable" };
  }
  return {
    kind: "valid",
    info: { category: b.category, label: b.label, maskedEmail: b.masked_email, on: b.on },
  };
}

/**
 * What the page renders:
 *   `ask`          the two buttons; `alreadyOff` when the category is off already, `retry` after a
 *                  press that did not go through;
 *   `done`         a press went through and the backend now says the category is off;
 *   `invalid`      one sentence and the settings link;
 *   `unavailable`  the backend could not be asked; the buttons are not offered.
 */
export type UnsubscribeView =
  | {
      readonly state: "ask";
      readonly info: UnsubscribeInfo;
      readonly alreadyOff: boolean;
      readonly retry: boolean;
    }
  | { readonly state: "done"; readonly info: UnsubscribeInfo; readonly scope: UnsubscribeScope }
  | { readonly state: "invalid" }
  | { readonly state: "unavailable" };

export function unsubscribeView(
  outcome: InfoOutcome,
  result: UnsubscribeResult | null,
): UnsubscribeView {
  // Only the backend's own answer makes a link invalid: a hand-typed `?result=invalid` on a live
  // link falls through to the buttons, as a press that did not go through.
  if (outcome.kind === "invalid") return { state: "invalid" };
  if (outcome.kind === "unavailable") return { state: "unavailable" };
  const { info } = outcome;
  if ((result === "category" || result === "all") && !info.on) {
    return { state: "done", info, scope: result };
  }
  // A claimed result the backend does not confirm is shown as a press that did not go through.
  const retry = result !== null && !(result === "category" && !info.on);
  return { state: "ask", info, alreadyOff: !info.on, retry };
}

/**
 * The label the page names the category by: this site's transcribed account copy for a category it
 * knows, else the backend's own label (a category added upstream before this copy caught up).
 */
export function categoryLabelFor(info: UnsubscribeInfo): string {
  return isCommunityMailCategory(info.category) ? mailCategoryLabel(info.category) : info.label;
}

/** The HTTP status the page answers with for a view. */
export function statusForView(view: UnsubscribeView): number {
  return view.state === "invalid" ? 410 : 200;
}

/**
 * Headers on every `/unsubscribe/*` answer and on the endpoint's redirect. The token in the URL must
 * not reach another site, a cache or a search index.
 *
 * `same-origin`, not `no-referrer`: under `no-referrer` a browser sends `Origin: null` with the
 * page's own form post, and the site's cross-site form check (`./origin-check.ts`, ADR 0031) refuses
 * that. `same-origin` sends no Referer to any other origin, which is what keeps the token in; the
 * only Referer it allows goes to this site, which already has the token in the request it serves.
 * The middleware honors a page's `same-origin` (`applySecurityHeaders`).
 */
export const UNSUBSCRIBE_PRIVACY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow",
};

/** The community mail policy page. */
export const COMMUNITY_MAIL_POLICY_URL = "https://docs.nemar.org/policies/community-mail";
