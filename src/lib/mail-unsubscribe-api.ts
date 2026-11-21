/**
 * Server calls for the unsubscribe page and its endpoint (epic nemarOrg/nemar-cli#2260 phase 5):
 * `GET /mail/unsubscribe/:token/info` and `POST /mail/unsubscribe/:token`.
 *
 * Server only (it uses `apiFetch`). Every request is built here from nothing: the token, an
 * `Accept`, and for the press a form body. No cookie, no `Authorization` and no visitor header is
 * ever copied from the incoming request, because the link is the whole authority and the backend
 * reads no cookie on these routes; sending one would only widen what a leaked log line carries.
 * `apiFetch` adds the visitor's address over the service binding, which the rate limiter needs.
 *
 * Callers check the token's shape first (`isMailUnsubscribeToken`); these functions refuse an
 * unchecked one rather than splice it into a URL.
 */

import { apiBase } from "./api-base";
import { apiFetch } from "./api-fetch";
import {
  type InfoOutcome,
  type UnsubscribeScope,
  isMailUnsubscribeToken,
  parseUnsubscribeInfo,
} from "./mail-unsubscribe";

function routeFor(token: string): string {
  if (!isMailUnsubscribeToken(token)) throw new TypeError("not an unsubscribe token");
  return `${apiBase()}/mail/unsubscribe/${token}`;
}

/** Read what the link is for. Never changes anything (the backend's GET has no side effect). */
export async function fetchUnsubscribeInfo(token: string): Promise<InfoOutcome> {
  const url = `${routeFor(token)}/info`;
  let res: Response;
  try {
    res = await apiFetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    console.warn(
      `[unsubscribe] the info call failed: ${err instanceof Error ? err.name : "unknown error"}`,
    );
    return parseUnsubscribeInfo("network", null);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status !== 200 && res.status !== 410) {
    console.warn(`[unsubscribe] the info call answered ${res.status}`);
  }
  return parseUnsubscribeInfo(res.status, body);
}

/**
 * Press a button: the RFC 8058 field the backend requires, plus `from=page` for the category button
 * (so the audit says it came from the page, not a mailbox client) or `scope=all` for the other.
 * Answers the backend's status, or `"network"`.
 */
export async function postUnsubscribe(
  token: string,
  scope: UnsubscribeScope,
): Promise<number | "network"> {
  const url = routeFor(token);
  const form = new URLSearchParams({ "List-Unsubscribe": "One-Click" });
  if (scope === "all") form.set("scope", "all");
  else form.set("from", "page");
  try {
    const res = await apiFetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      redirect: "manual",
    });
    void res.body?.cancel().catch(() => {});
    if (res.status !== 200 && res.status !== 410) {
      console.warn(`[unsubscribe] the unsubscribe call answered ${res.status}`);
    }
    return res.status;
  } catch (err) {
    console.warn(
      `[unsubscribe] the unsubscribe call failed: ${err instanceof Error ? err.name : "unknown error"}`,
    );
    return "network";
  }
}
