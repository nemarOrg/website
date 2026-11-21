/**
 * Route-level tests for the unsubscribe page's endpoint (`api/mail/unsubscribe.ts`) and the info
 * read the page makes (`fetchUnsubscribeInfo`), epic nemarOrg/nemar-cli#2260 phase 5.
 *
 * Only the network boundary is stubbed (`globalThis.fetch`, which `apiFetch` uses when the request
 * has no service binding), capturing each request whole so a test can assert on the method, the
 * headers and the body. The answers are the bodies nemar-cli's `backend/src/routes/mail.ts` sends.
 */

import { afterEach, describe, expect, it } from "vitest";
import { fetchUnsubscribeInfo } from "../../src/lib/mail-unsubscribe-api";
import { POST } from "../../src/pages/api/mail/unsubscribe";
import { callRoute, jsonResponse } from "./harness";

const SIG = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6";
const TOKEN = `v1.42.rfcs.7.${SIG}`;
const ENDPOINT = "https://app.nemar.org/api/mail/unsubscribe";

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace the network with `answer`, recording every request. */
function network(answer: (seen: Seen) => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const entry: Seen = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    seen.push(entry);
    return answer(entry);
  }) as typeof fetch;
  return seen;
}

function press(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return callRoute(
    POST,
    ENDPOINT,
    {},
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://app.nemar.org",
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    },
  );
}

const UNSUBSCRIBED = (scope: string) =>
  jsonResponse({ status: "unsubscribed", scope, category: "rfcs" });
const LINK_INVALID = () =>
  jsonResponse({ error: "link_invalid", message: "This unsubscribe link is not valid." }, 410);

describe("POST /api/mail/unsubscribe: the token is checked before anything is sent", () => {
  it.each([
    ["a malformed token", { token: "v1.42.rfcs.7.short", scope: "category" }],
    ["a token with a path in it", { token: `v1.42.rfcs.7.${SIG}/../../admin`, scope: "all" }],
    ["no token", { scope: "all" }],
  ])("answers 400 for %s and makes no upstream call", async (_name, fields) => {
    const seen = network(() => UNSUBSCRIBED("all"));
    const res = await press(fields as Record<string, string>);
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(seen).toEqual([]);
  });

  it("answers 400 for an unknown scope and makes no upstream call", async () => {
    const seen = network(() => UNSUBSCRIBED("all"));
    const res = await press({ token: TOKEN, scope: "everything" });
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("refuses a body that is not a form, and one declared too large", async () => {
    const seen = network(() => UNSUBSCRIBED("all"));
    const json = await callRoute(
      POST,
      ENDPOINT,
      {},
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: TOKEN, scope: "all" }),
      },
    );
    expect(json.status).toBe(415);
    const big = await press({ token: TOKEN, scope: "all" }, { "Content-Length": "999999" });
    expect(big.status).toBe(413);
    expect(seen).toEqual([]);
  });
});

describe("POST /api/mail/unsubscribe: forwarding", () => {
  it("forwards the category button as a one-click POST from the page", async () => {
    const seen = network(() => UNSUBSCRIBED("category"));
    const res = await press({ token: TOKEN, scope: "category" });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe(`https://api.nemar.org/mail/unsubscribe/${TOKEN}`);
    expect(seen[0].headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(seen[0].body ?? "");
    expect(body.get("List-Unsubscribe")).toBe("One-Click");
    expect(body.get("from")).toBe("page");
    expect(body.get("scope")).toBeNull();
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/unsubscribe/${TOKEN}?result=category`);
  });

  it("forwards the second button with scope=all", async () => {
    const seen = network(() => UNSUBSCRIBED("all"));
    const res = await press({ token: TOKEN, scope: "all" });
    const body = new URLSearchParams(seen[0].body ?? "");
    expect(body.get("List-Unsubscribe")).toBe("One-Click");
    expect(body.get("scope")).toBe("all");
    expect(res.headers.get("Location")).toBe(`/unsubscribe/${TOKEN}?result=all`);
  });

  it("never forwards the visitor's cookie or Authorization header", async () => {
    const seen = network(() => UNSUBSCRIBED("all"));
    await press(
      { token: TOKEN, scope: "all" },
      {
        Cookie: "__Host-nemar_session=secret-session; nemar_session=legacy",
        Authorization: "Bearer nemar_live_not_a_real_key",
        "X-Forwarded-For": "203.0.113.9",
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get("cookie")).toBeNull();
    expect(seen[0].headers.get("authorization")).toBeNull();
    expect(seen[0].headers.get("x-forwarded-for")).toBeNull();
    expect(seen[0].headers.get("origin")).toBeNull();
  });

  it("redirects with invalid on the backend's 410, and with error on anything else", async () => {
    network(LINK_INVALID);
    expect((await press({ token: TOKEN, scope: "category" })).headers.get("Location")).toBe(
      `/unsubscribe/${TOKEN}?result=invalid`,
    );
    network(() => jsonResponse({ error: "rate_limited" }, 429));
    expect((await press({ token: TOKEN, scope: "category" })).headers.get("Location")).toBe(
      `/unsubscribe/${TOKEN}?result=error`,
    );
    network(() => {
      throw new TypeError("network down");
    });
    expect((await press({ token: TOKEN, scope: "all" })).headers.get("Location")).toBe(
      `/unsubscribe/${TOKEN}?result=error`,
    );
  });

  it("puts the privacy headers on the redirect", async () => {
    network(() => UNSUBSCRIBED("all"));
    const res = await press({ token: TOKEN, scope: "all" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
});

describe("fetchUnsubscribeInfo: what the page reads on load", () => {
  it("reads the info route with a GET only, so loading the page changes nothing", async () => {
    const seen = network(() =>
      jsonResponse({
        category: "rfcs",
        label: "Requests for comments",
        masked_email: "a***@example.org",
        on: true,
      }),
    );
    const outcome = await fetchUnsubscribeInfo(TOKEN);
    expect(outcome).toMatchObject({ kind: "valid", info: { on: true } });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe(`https://api.nemar.org/mail/unsubscribe/${TOKEN}/info`);
    expect(seen[0].body).toBeNull();
    expect(seen[0].headers.get("cookie")).toBeNull();
    expect(seen[0].headers.get("authorization")).toBeNull();
  });

  it("reads a dead link as invalid and a failure as unavailable", async () => {
    network(LINK_INVALID);
    expect(await fetchUnsubscribeInfo(TOKEN)).toEqual({ kind: "invalid" });
    network(() => {
      throw new TypeError("network down");
    });
    expect(await fetchUnsubscribeInfo(TOKEN)).toEqual({ kind: "unavailable" });
  });

  it("refuses to put an unchecked token in a URL", async () => {
    const seen = network(() => LINK_INVALID());
    await expect(fetchUnsubscribeInfo("../admin")).rejects.toThrow(TypeError);
    expect(seen).toEqual([]);
  });
});
