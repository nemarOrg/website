import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_COPY } from "./account-copy";
import { safeRedirectPath } from "./auth";
import { getCrossHostRedirect, getRetiredRedirect, isAppRoute } from "./host";
import { isOsaWidgetExcludedPath } from "./osa-widget";
import {
  PRIVATE_AUTHORIZE_COPY,
  PRIVATE_AUTHORIZE_HEADERS,
  PRIVATE_AUTHORIZE_PAGE_PATH,
  PRIVATE_AUTHORIZE_STATE_PARAM,
  PRIVATE_AUTHORIZE_STATUS,
  PRIVATE_CALLBACK_PATH,
  PRIVATE_RETURN_LABEL,
  privateAuthorizeReturnPath,
  privateCallbackUrl,
  privateGrantOutcome,
  privateHandoffTarget,
  privateLoginRedirect,
  privateMethodRefusal,
  privateReturnHref,
  privateState,
} from "./private-authorize";
import { pageViewForPathname } from "./umami-analytics";

/** A valid state: 43 base64url characters, the length 256 random bits make. */
const STATE = "PrivateSiteState_0123456789-abcdefghijklmn";
const PRIVATE = "https://private.nemar.org";

describe("where the authorize page lives", () => {
  it("is an app-host route, the only host the session cookie reaches", () => {
    expect(isAppRoute(PRIVATE_AUTHORIZE_PAGE_PATH)).toBe(true);
  });

  it("is not swallowed by any retired-path redirect", () => {
    expect(
      getRetiredRedirect(
        new URL(`https://app.nemar.org${PRIVATE_AUTHORIZE_PAGE_PATH}?state=${STATE}`),
      ),
    ).toBeNull();
  });

  it("stays on the app host, and is pulled back to it from marketing with its query intact", () => {
    const query = `?state=${STATE}`;
    expect(
      getCrossHostRedirect(new URL(`https://app.nemar.org${PRIVATE_AUTHORIZE_PAGE_PATH}${query}`)),
    ).toBeNull();
    expect(
      getCrossHostRedirect(new URL(`https://nemar.org${PRIVATE_AUTHORIZE_PAGE_PATH}${query}`)),
    ).toBe(`https://app.nemar.org${PRIVATE_AUTHORIZE_PAGE_PATH}${query}`);
  });

  it("carries no third-party script and no page-view record, since its URL holds the state", () => {
    expect(isOsaWidgetExcludedPath(PRIVATE_AUTHORIZE_PAGE_PATH)).toBe(true);
    expect(pageViewForPathname(PRIVATE_AUTHORIZE_PAGE_PATH)).toBeNull();
  });
});

describe("privateState", () => {
  it("accepts 32 to 256 characters of the base64url alphabet", () => {
    for (const length of [32, 43, 256]) {
      const value = "Az09-_".repeat(50).slice(0, length);
      expect(privateState(value)).toBe(value);
    }
  });

  it("refuses 31 and 257 characters", () => {
    expect(privateState("a".repeat(31))).toBeNull();
    expect(privateState("a".repeat(257))).toBeNull();
  });

  it("refuses anything outside the alphabet, padding and standard base64 included", () => {
    for (const bad of [
      `${"a".repeat(42)}=`,
      `${"a".repeat(42)}+`,
      `${"a".repeat(42)}/`,
      `${"a".repeat(42)} `,
      `${"a".repeat(42)}.`,
      `${"a".repeat(42)}%`,
      `${"a".repeat(42)}\n`,
      `${"a".repeat(42)}é`,
    ]) {
      expect(privateState(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("refuses a missing value", () => {
    expect(privateState(null)).toBeNull();
    expect(privateState(undefined)).toBeNull();
    expect(privateState("")).toBeNull();
  });

  it("uses the contract's parameter name", () => {
    expect(PRIVATE_AUTHORIZE_STATE_PARAM).toBe("state");
  });
});

describe("privateHandoffTarget", () => {
  it("uses the production private site when the API is production and nothing is set", () => {
    expect(privateHandoffTarget("https://api.nemar.org", null)).toEqual({
      kind: "ready",
      base: PRIVATE,
    });
    expect(privateHandoffTarget("https://api.nemar.org/", undefined)).toEqual({
      kind: "ready",
      base: PRIVATE,
    });
  });

  it("honors a configured base, as staging sets it", () => {
    expect(
      privateHandoffTarget("https://api-test.nemar.org", "https://private-test.nemar.org"),
    ).toEqual({ kind: "ready", base: "https://private-test.nemar.org" });
    expect(
      privateHandoffTarget("https://api-test.nemar.org", "https://private-test.nemar.org/"),
    ).toEqual({ kind: "ready", base: "https://private-test.nemar.org" });
  });

  it("resolves a configured base to its normalized origin, never the raw string", () => {
    for (const [configured, base] of [
      ["https://private-test.nemar.org:443", "https://private-test.nemar.org"],
      ["https://private-test.nemar.org/?", "https://private-test.nemar.org"],
      ["https://private-test.nemar.org?", "https://private-test.nemar.org"],
      ["https://private-test.nemar.org/#", "https://private-test.nemar.org"],
      ["HTTPS://Private-Test.NEMAR.org", "https://private-test.nemar.org"],
      ["  https://private-test.nemar.org/  ", "https://private-test.nemar.org"],
    ] as const) {
      expect(privateHandoffTarget("https://api-test.nemar.org", configured), configured).toEqual({
        kind: "ready",
        base,
      });
    }
  });

  it("refuses a configured base carrying credentials, and never echoes it", () => {
    for (const bad of [
      "https://user:secret@private-test.nemar.org",
      "https://user@private-test.nemar.org",
      "https://:secret@private-test.nemar.org",
    ]) {
      const target = privateHandoffTarget("https://api-test.nemar.org", bad);
      expect(target.kind, bad).toBe("misconfigured");
      expect(target.kind === "misconfigured" ? target.reason : "", bad).not.toContain("secret");
      expect(target.kind === "misconfigured" ? target.reason : "", bad).not.toContain("user");
    }
  });

  it("refuses a non-production API with no configured base: the 501 case", () => {
    for (const api of ["https://api-test.nemar.org", "http://localhost:8787", ""]) {
      const target = privateHandoffTarget(api, null);
      expect(target.kind, api).toBe("misconfigured");
    }
  });

  it("refuses a configured base that is not an https origin on a nemar.org host", () => {
    for (const bad of [
      "private-test.nemar.org",
      "http://private-test.nemar.org",
      "https://private.evil.example",
      "https://nemar.org.evil.example",
      "https://private.nemar.org/app",
      "https://private.nemar.org/?x=1",
      "https://private.nemar.org/#x",
      "https://private.nemar.org:8443",
      "http://localhost:4322",
      "not a url",
    ]) {
      const target = privateHandoffTarget("https://api.nemar.org", bad);
      expect(target.kind, bad).toBe("misconfigured");
    }
  });
});

describe("privateAuthorizeReturnPath and privateLoginRedirect", () => {
  it("rebuilds this page's URL from the validated state alone", () => {
    expect(privateAuthorizeReturnPath(STATE)).toBe(`${PRIVATE_AUTHORIZE_PAGE_PATH}?state=${STATE}`);
  });

  it("always survives the sign-in page's own next check, so sign-in returns here", () => {
    for (const state of [STATE, "a".repeat(32), "Az09-_".repeat(50).slice(0, 256)]) {
      const path = privateAuthorizeReturnPath(state);
      expect(safeRedirectPath(path), state).toBe(path);
      const back = new URL(path, "https://app.nemar.org");
      expect([...back.searchParams.keys()]).toEqual([PRIVATE_AUTHORIZE_STATE_PARAM]);
      expect(back.searchParams.get(PRIVATE_AUTHORIZE_STATE_PARAM)).toBe(state);
    }
  });

  it("sends a signed-out visitor to sign in with that address, the reason only when asked", () => {
    const back = privateAuthorizeReturnPath(STATE);
    const login = new URL(privateLoginRedirect(back), "https://app.nemar.org");
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("next")).toBe(back);
    expect(login.searchParams.has("error")).toBe(false);
    const again = new URL(privateLoginRedirect(back, true), "https://app.nemar.org");
    expect(again.searchParams.get("error")).toBe("session_required");
    expect(again.searchParams.get("next")).toBe(back);
  });
});

describe("privateCallbackUrl", () => {
  it("carries exactly one query parameter, the code, to the private site's callback", () => {
    const url = new URL(privateCallbackUrl(PRIVATE, "the-code"));
    expect(url.origin).toBe(PRIVATE);
    expect(url.pathname).toBe(PRIVATE_CALLBACK_PATH);
    expect([...url.searchParams.entries()]).toEqual([["code", "the-code"]]);
    expect(url.hash).toBe("");
  });

  it("encodes the code rather than letting it add parameters", () => {
    const url = new URL(privateCallbackUrl(PRIVATE, "a&next=//evil.example"));
    expect([...url.searchParams.entries()]).toEqual([["code", "a&next=//evil.example"]]);
  });

  it("never contains the state, in any spelling", () => {
    const url = privateCallbackUrl(PRIVATE, "the-code");
    expect(url).not.toContain(STATE);
    expect(url).not.toContain(encodeURIComponent(STATE));
    expect(url).not.toContain(`${PRIVATE_AUTHORIZE_STATE_PARAM}=`);
  });

  it("uses the contract's callback path", () => {
    expect(PRIVATE_CALLBACK_PATH).toBe("/__auth/callback");
  });
});

describe("privateGrantOutcome", () => {
  it("hands off a 200 carrying a code", () => {
    expect(privateGrantOutcome({ status: 200, body: { code: "abc", expires_in: 60 } })).toEqual({
      kind: "handoff",
      code: "abc",
    });
  });

  it("treats a 200 without a usable code as unavailable, logging keys only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const body of [{}, { code: "" }, { code: 42 }, null, "x"]) {
        expect(privateGrantOutcome({ status: 200, body })).toEqual({ kind: "unavailable" });
      }
      expect(warn.mock.calls.map((c) => JSON.stringify(c)).join(" ")).not.toContain("42");
    } finally {
      warn.mockRestore();
    }
  });

  it("maps 401 to signed out", () => {
    expect(privateGrantOutcome({ status: 401, body: { error: "unauthenticated" } })).toEqual({
      kind: "signed_out",
    });
  });

  it("maps a 403 for an account whose email is not verified to unverified", () => {
    expect(
      privateGrantOutcome({
        status: 403,
        body: { error: "Account not approved", status: "pending", message: "Verify..." },
      }),
    ).toEqual({ kind: "unverified" });
  });

  it("maps a 403 for any other account status to inactive, never to unverified", () => {
    // A revoked account can still hold a web session; telling it to verify an email it already
    // verified would be wrong, so only `pending` gets the unverified panel.
    for (const status of ["revoked", "revoked_iam_pending", "something_new"]) {
      expect(
        privateGrantOutcome({
          status: 403,
          body: { error: "Account not approved", status, message: "Your account is not active" },
        }),
        status,
      ).toEqual({ kind: "inactive" });
    }
  });

  it("maps the backend's Origin refusal, a 403 without a status, to unavailable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(privateGrantOutcome({ status: 403, body: { error: "Origin not allowed" } })).toEqual({
        kind: "unavailable",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("maps any redirect to unavailable, since the grant call never follows one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const status of [301, 302, 303, 307, 308]) {
        expect(
          privateGrantOutcome({ status, body: { code: "would-be-code" } }),
          String(status),
        ).toEqual({ kind: "unavailable" });
      }
      expect(JSON.stringify(warn.mock.calls)).not.toContain("would-be-code");
    } finally {
      warn.mockRestore();
    }
  });

  it("maps 400 to an invalid request and 429 to rate limited", () => {
    expect(privateGrantOutcome({ status: 400, body: { error: "invalid_request" } })).toEqual({
      kind: "invalid_request",
    });
    expect(privateGrantOutcome({ status: 429, body: { error: "Rate limit exceeded" } })).toEqual({
      kind: "rate_limited",
    });
  });

  it("maps anything else, a network failure included, to unavailable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const status of [404, 500, 502, 503, 204]) {
        expect(privateGrantOutcome({ status, body: null }), String(status)).toEqual({
          kind: "unavailable",
        });
      }
      expect(privateGrantOutcome({ status: "network" })).toEqual({ kind: "unavailable" });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the rendered panels", () => {
  it("answer each outcome with its own status", () => {
    expect(PRIVATE_AUTHORIZE_STATUS).toEqual({
      invalid_request: 400,
      unverified: 403,
      inactive: 403,
      rate_limited: 429,
      unavailable: 503,
      misconfigured: 501,
    });
  });

  it("reuse the site's own wording for an account whose email is not verified", () => {
    expect(PRIVATE_AUTHORIZE_COPY.unverified).toEqual({
      title: ACCOUNT_COPY["tier.unverified.label"],
      body: ACCOUNT_COPY["tier.unverified.lede"],
    });
  });

  it("never tell an account whose access was withdrawn to verify its email", () => {
    expect(PRIVATE_AUTHORIZE_COPY.inactive.title).not.toBe(ACCOUNT_COPY["tier.unverified.label"]);
    expect(PRIVATE_AUTHORIZE_COPY.inactive.body.toLowerCase()).not.toContain("verify");
  });

  it("say what to do next on a rate limit", () => {
    expect(PRIVATE_AUTHORIZE_COPY.rate_limited.body).toContain("in a minute");
  });

  it("carry no-store, no-referrer and noindex on every response", () => {
    expect(PRIVATE_AUTHORIZE_HEADERS).toEqual({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    });
  });
});

describe("privateMethodRefusal", () => {
  it("lets GET through", () => {
    expect(privateMethodRefusal("GET")).toBeNull();
  });

  it("answers every other method, HEAD included, 405 with Allow: GET and the page's headers", async () => {
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = privateMethodRefusal(method);
      expect(res?.status, method).toBe(405);
      expect(res?.headers.get("Allow"), method).toBe("GET");
      for (const [name, value] of Object.entries(PRIVATE_AUTHORIZE_HEADERS)) {
        expect(res?.headers.get(name), `${method} ${name}`).toBe(value);
      }
      expect(await res?.text(), method).toBe("");
    }
  });
});

describe("privateReturnHref", () => {
  const ready = { kind: "ready", base: "https://private-test.nemar.org" } as const;

  it("links the two account panels back to the private site's root", () => {
    expect(privateReturnHref("unverified", ready)).toBe("https://private-test.nemar.org/");
    expect(privateReturnHref("inactive", ready)).toBe("https://private-test.nemar.org/");
    expect(PRIVATE_RETURN_LABEL).toBe("Return to the private site");
  });

  it("gives every other panel no link", () => {
    for (const panel of [
      "invalid_request",
      "rate_limited",
      "unavailable",
      "misconfigured",
    ] as const) {
      expect(privateReturnHref(panel, ready), panel).toBeNull();
    }
  });

  it("gives no link when the deployment has no usable private-site base", () => {
    expect(privateReturnHref("inactive", { kind: "misconfigured", reason: "unset" })).toBeNull();
  });
});
