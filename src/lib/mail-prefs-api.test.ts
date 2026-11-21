/**
 * The Settings "Email" card's client. Each function is handed a `fetch` that returns a real
 * `Response` built from the JSON nemar-cli's `userMailPreferenceRoutes`
 * (`backend/src/routes/users.ts`) puts on the wire, the pattern `account-api.test.ts` uses; the
 * request each call makes is recorded so a test can assert on it.
 */

import { describe, expect, it } from "vitest";
import {
  MAIL_PREFERENCES_PATH,
  getMailPreferences,
  mailPreferencesErrorText,
  parseMailPreferences,
  putMailPreference,
} from "./mail-prefs-api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** The view both routes answer with. */
const VIEW = {
  news: true,
  rfcs: false,
  maintenance: true,
  recall: { on: true, locked: true },
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function recording(res: () => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return res();
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

describe("parseMailPreferences", () => {
  it("reads the three switches of the backend's view", () => {
    expect(parseMailPreferences(VIEW)).toEqual({ news: true, rfcs: false, maintenance: true });
  });

  it("refuses a body it cannot read rather than render switches that look real", () => {
    expect(parseMailPreferences({ ...VIEW, rfcs: "false" })).toBeNull();
    expect(parseMailPreferences({ news: true, rfcs: true, maintenance: true })).toBeNull();
    expect(parseMailPreferences({ ...VIEW, recall: { on: true, locked: false } })).toBeNull();
    expect(parseMailPreferences(null)).toBeNull();
    expect(parseMailPreferences([VIEW])).toBeNull();
  });
});

describe("getMailPreferences", () => {
  it("reads through the same-origin proxy with the session cookie, never cached", async () => {
    const { fetch, calls } = recording(() => jsonResponse(VIEW));
    expect(await getMailPreferences(fetch)).toEqual({
      ok: true,
      prefs: { news: true, rfcs: false, maintenance: true },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(MAIL_PREFERENCES_PATH);
    expect(MAIL_PREFERENCES_PATH).toBe("/api/v1/users/me/email-preferences");
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.credentials).toBe("include");
    expect(calls[0].init?.cache).toBe("no-store");
  });

  it("reports a signed-out session and a network failure", async () => {
    const signedOut = await getMailPreferences(
      recording(() => jsonResponse({ error: "Authentication required" }, 401)).fetch,
    );
    expect(signedOut).toMatchObject({ ok: false, status: 401 });
    const down = await getMailPreferences((async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    expect(down).toEqual({ ok: false, status: "network" });
  });

  it("treats a 200 it cannot read as a failure, not as switches", async () => {
    const res = await getMailPreferences(recording(() => jsonResponse({ news: true })).fetch);
    expect(res).toEqual({ ok: false, status: 200 });
  });
});

describe("putMailPreference", () => {
  it("sends only the one category that changed, as JSON, with the cookie", async () => {
    const { fetch, calls } = recording(() => jsonResponse({ ...VIEW, news: false }));
    const res = await putMailPreference("news", false, fetch);
    expect(res).toEqual({ ok: true, prefs: { news: false, rfcs: false, maintenance: true } });
    expect(calls[0].url).toBe(MAIL_PREFERENCES_PATH);
    expect(calls[0].init?.method).toBe("PUT");
    expect(calls[0].init?.credentials).toBe("include");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ news: false });
    expect(new Headers(calls[0].init?.headers).get("content-type")).toBe("application/json");
  });

  it("carries the backend's refusal code and sentence", async () => {
    const refusal = {
      error: "recall_cannot_be_turned_off",
      field: "recall",
      message:
        "Recalls cannot be turned off: they tell you to stop using, delete or replace something NEMAR distributed or issued, because continuing to use it can cause harm.",
    };
    const res = await putMailPreference(
      "news",
      false,
      recording(() => jsonResponse(refusal, 400)).fetch,
    );
    expect(res).toEqual({
      ok: false,
      status: 400,
      code: "recall_cannot_be_turned_off",
      message: refusal.message,
    });
  });
});

describe("mailPreferencesErrorText", () => {
  it.each([
    ["recall_cannot_be_turned_off", "recall", "Recalls cannot be turned off."],
    [
      "admin_alert_not_self_service",
      "publish",
      "publish is an admin alert, not a mail category. Admins change their alerts with nemar admin email-preferences.",
    ],
    [
      "unknown_mail_preference",
      "newsletter",
      "newsletter is not a mail category. The categories you can set are news, rfcs, maintenance.",
    ],
    ["invalid_mail_preference", "news", "news must be true or false."],
  ])("shows the backend's own sentence for %s", (code, _field, message) => {
    expect(mailPreferencesErrorText({ ok: false, status: 400, code, message })).toBe(message);
  });

  it("does not show a message attached to a code it does not know", () => {
    const text = mailPreferencesErrorText({
      ok: false,
      status: 400,
      code: "something_else",
      message: "<b>raw</b>",
    });
    expect(text).not.toContain("raw");
  });

  it("words the statuses that carry no refusal sentence", () => {
    expect(mailPreferencesErrorText({ ok: false, status: 401 })).toMatch(/session expired/);
    expect(
      mailPreferencesErrorText({ ok: false, status: 403, code: "Origin not allowed" }),
    ).toMatch(/refused this change/);
    expect(mailPreferencesErrorText({ ok: false, status: 429 })).toMatch(/Too many/);
    expect(mailPreferencesErrorText({ ok: false, status: "network" })).toMatch(
      /could not be reached/,
    );
    expect(mailPreferencesErrorText({ ok: false, status: 502 })).toMatch(/Try again/);
  });
});
