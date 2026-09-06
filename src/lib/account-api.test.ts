/**
 * The account-tier client's parsing and fail-soft behaviour.
 *
 * The fetches are driven by handing each function a `fetch` that returns a
 * real `Response` built from the exact JSON the backend sends — the pattern
 * `imports-admin-api.test.ts` uses. Nothing here stands in for logic under
 * test: the code being exercised is the parsing and the branching, and the
 * bodies are transcribed from nemar-cli's route handlers.
 */

import { describe, expect, it } from "vitest";
import {
  AccountApiError,
  fetchAccountIdentity,
  fetchUsernameSuggestion,
  parseAccountErrorBody,
  requestUploadAccess,
} from "./account-api";

/** A JSON response, matching what the Worker actually puts on the wire. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function respondWith(res: Response | (() => Response)): typeof fetch {
  return (async () => (typeof res === "function" ? res() : res)) as unknown as typeof fetch;
}

describe("parseAccountErrorBody", () => {
  it("reads the { error, message, missing } refusal shape", () => {
    expect(
      parseAccountErrorBody({
        error: "profile_incomplete",
        message: "Complete your profile before requesting upload access: city, country",
        missing: ["city", "country"],
      }),
    ).toEqual({
      code: "profile_incomplete",
      message: "Complete your profile before requesting upload access: city, country",
      missing: ["city", "country"],
      attemptsRemaining: undefined,
    });
  });

  it("keeps attempts_remaining of 0, which is meaningful", () => {
    // Zero means the code is now invalidated. A truthiness check here would
    // drop exactly the value that changes what the UI does next.
    const parsed = parseAccountErrorBody({
      error: "code_incorrect",
      message: "That code did not match and has now been invalidated.",
      attempts_remaining: 0,
    });
    expect(parsed.attemptsRemaining).toBe(0);
  });

  it("normalises a body with no missing array to an empty one", () => {
    // Every refusal on the request endpoint ships `missing`; normalising the
    // other paths keeps one shape for the renderer.
    expect(parseAccountErrorBody({ error: "already_approved" }).missing).toEqual([]);
    expect(parseAccountErrorBody(null).missing).toEqual([]);
    expect(parseAccountErrorBody("not json at all").missing).toEqual([]);
  });

  it("drops non-string entries from missing rather than rendering them", () => {
    expect(parseAccountErrorBody({ missing: ["city", 7, null] }).missing).toEqual(["city"]);
  });

  it("ignores an empty error or message string", () => {
    expect(parseAccountErrorBody({ error: "", message: "" })).toEqual({
      code: undefined,
      message: undefined,
      missing: [],
      attemptsRemaining: undefined,
    });
  });
});

describe("requestUploadAccess", () => {
  it("reports the 201 that actually opened a request", async () => {
    const result = await requestUploadAccess("Resting-state EEG from our lab", {
      fetch: respondWith(jsonResponse({ ok: true, already_requested: false }, 201)),
    });
    expect(result.already_requested).toBe(false);
  });

  it("reports the 200 that found one already open", async () => {
    // The backend does NOT re-mail the admins here, so the UI must say
    // "already sent" rather than "sent".
    const result = await requestUploadAccess("x", {
      fetch: respondWith(
        jsonResponse(
          { ok: true, already_requested: true, requested_at: "2026-09-01 10:00:00" },
          200,
        ),
      ),
    });
    expect(result.already_requested).toBe(true);
    expect(result.requested_at).toBe("2026-09-01 10:00:00");
  });

  it("throws a refusal that still carries its missing array", async () => {
    const body = {
      error: "profile_incomplete",
      message: "Complete your profile before requesting upload access: city, country",
      missing: ["city", "country"],
    };
    await expect(
      requestUploadAccess("x", { fetch: respondWith(jsonResponse(body, 400)) }),
    ).rejects.toBeInstanceOf(AccountApiError);

    const err: AccountApiError = await requestUploadAccess("x", {
      fetch: respondWith(jsonResponse(body, 400)),
    }).then(
      () => {
        throw new Error("expected a refusal");
      },
      (e: unknown) => e as AccountApiError,
    );
    expect(err.status).toBe(400);
    expect(err.code).toBe("profile_incomplete");
    expect(err.missing).toEqual(["city", "country"]);
    expect(err.message).toContain("city, country");
  });

  it("carries the 409 for an account that already holds the grant", async () => {
    const err: AccountApiError = await requestUploadAccess("x", {
      fetch: respondWith(
        jsonResponse(
          {
            error: "already_approved",
            message: "This account already has upload access; there is nothing to request",
            missing: [],
          },
          409,
        ),
      ),
    }).then(
      () => {
        throw new Error("expected a refusal");
      },
      (e: unknown) => e as AccountApiError,
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe("already_approved");
    expect(err.missing).toEqual([]);
  });

  it("survives a proxy failure with no JSON body", async () => {
    const err: AccountApiError = await requestUploadAccess("x", {
      fetch: respondWith(new Response("Bad Gateway", { status: 502 })),
    }).then(
      () => {
        throw new Error("expected a refusal");
      },
      (e: unknown) => e as AccountApiError,
    );
    expect(err.status).toBe(502);
    expect(err.missing).toEqual([]);
  });
});

describe("fetchUsernameSuggestion", () => {
  it("passes a real suggestion through", async () => {
    expect(
      await fetchUsernameSuggestion({
        fetch: respondWith(jsonResponse({ suggestion: "alovelace", based_on: "name" })),
      }),
    ).toEqual({ suggestion: "alovelace", based_on: "name" });
  });

  it("reports unavailable when the account has no name to fold", async () => {
    expect(
      await fetchUsernameSuggestion({
        fetch: respondWith(jsonResponse({ suggestion: null, based_on: "unavailable" })),
      }),
    ).toEqual({ suggestion: null, based_on: "unavailable" });
  });

  it("never claims a source it does not have", async () => {
    // A body saying `based_on: "name"` with no suggestion would otherwise
    // render "suggested from your name" beside an empty field.
    expect(
      await fetchUsernameSuggestion({
        fetch: respondWith(jsonResponse({ suggestion: null, based_on: "name" })),
      }),
    ).toEqual({ suggestion: null, based_on: "unavailable" });
  });

  it("fails soft: a suggestion is a convenience, not a precondition", async () => {
    expect(await fetchUsernameSuggestion({ fetch: respondWith(jsonResponse({}, 500)) })).toEqual({
      suggestion: null,
      based_on: "unavailable",
    });
    expect(
      await fetchUsernameSuggestion({
        fetch: (() => Promise.reject(new Error("network"))) as unknown as typeof fetch,
      }),
    ).toEqual({ suggestion: null, based_on: "unavailable" });
  });
});

describe("fetchAccountIdentity", () => {
  it("short-circuits when the session already carries a username", async () => {
    // No fetch is supplied at all: if the function called one, the global
    // `fetch` would attempt a real request and this test would not pass
    // synchronously against a bare relative URL.
    expect(await fetchAccountIdentity("alovelace")).toEqual({ username: "alovelace" });
  });

  it("reads the username out of the /users/me envelope", async () => {
    expect(
      await fetchAccountIdentity(undefined, {
        fetch: respondWith(
          jsonResponse({ user: { id: 1, username: "alovelace", email: "a@b.org" }, token: null }),
        ),
      }),
    ).toEqual({ username: "alovelace" });
  });

  it("reports an explicit null username as a real absence", async () => {
    // This is the ORCID/web default (migration 0026) and the thing onboarding
    // exists to fix, so it must be distinguishable from a failed lookup.
    expect(
      await fetchAccountIdentity(undefined, {
        fetch: respondWith(jsonResponse({ user: { id: 1, username: null, email: "a@b.org" } })),
      }),
    ).toEqual({ username: null });
  });

  it("reports a blank username as an absence too", async () => {
    expect(
      await fetchAccountIdentity(undefined, {
        fetch: respondWith(jsonResponse({ user: { id: 1, username: "   ", email: "a@b.org" } })),
      }),
    ).toEqual({ username: null });
  });

  it("answers undefined — not null — when it could not ask", async () => {
    // An unverified session gets a 403 from authMiddleware; reading that as
    // "no username" would prompt for one on an account whose only available
    // action is verifying an email.
    expect(
      await fetchAccountIdentity(undefined, {
        fetch: respondWith(jsonResponse({ error: "Account not active" }, 403)),
      }),
    ).toEqual({ username: undefined });
    expect(
      await fetchAccountIdentity(undefined, {
        fetch: (() => Promise.reject(new Error("network"))) as unknown as typeof fetch,
      }),
    ).toEqual({ username: undefined });
    // A body with no `user` object at all is a shape we cannot read either.
    expect(await fetchAccountIdentity(undefined, { fetch: respondWith(jsonResponse({})) })).toEqual(
      { username: undefined },
    );
  });
});
