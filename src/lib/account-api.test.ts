/**
 * The account-tier client's parsing and fail-soft behaviour.
 *
 * The fetches are driven by handing each function a `fetch` that returns a
 * real `Response` built from the exact JSON the backend sends — the pattern
 * `imports-admin-api.test.ts` uses. Nothing here stands in for logic under
 * test: the code being exercised is the parsing and the branching, and the
 * bodies are transcribed from nemar-cli's route handlers.
 */

import { describe, expect, it, vi } from "vitest";
import requestResponses from "../../test/fixtures/compute/request-responses.json";
import {
  AccountApiError,
  fetchAccountIdentity,
  fetchUsernameSuggestion,
  parseAccountErrorBody,
  requestComputeAccess,
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

// ---------------------------------------------------------------------------
// Compute access (website ADR 0030)
// ---------------------------------------------------------------------------

/**
 * Responses captured from the real backend routes by
 * `scripts/capture-compute-fixtures.mjs` (nemar-cli 3a869903), replayed as
 * real `Response` objects. Nothing stands in for the code under test.
 */
const CAPTURED = requestResponses as unknown as Record<
  string,
  { status: number; body: Record<string, unknown> }
>;

function captured(name: string): Response {
  const { status, body } = CAPTURED[name];
  return jsonResponse(body, status);
}

const REQUEST = {
  purpose: "Run ICA on public EEG datasets for a methods paper",
  acceptTermsVersion: "2026-11-draft",
};

describe("parseAccountErrorBody: a compute refusal", () => {
  it("keeps the `missing` array of a profile refusal", () => {
    const parsed = parseAccountErrorBody(CAPTURED.profile_incomplete.body);
    expect(parsed.code).toBe("profile_incomplete");
    expect(parsed.missing).toEqual(["given_name", "family_name", "city", "country", "affiliation"]);
    expect(parsed.message).toContain("affiliation");
  });

  it("keeps the one-field arrays of the other refusals", () => {
    expect(parseAccountErrorBody(CAPTURED.orcid_not_proven.body).missing).toEqual([
      "orcid_verified",
    ]);
    expect(parseAccountErrorBody(CAPTURED.purpose_required.body).missing).toEqual(["purpose"]);
    expect(parseAccountErrorBody(CAPTURED.access_closed_denied.body).missing).toEqual([]);
  });
});

describe("requestComputeAccess", () => {
  it("POSTs the purpose and the accepted version to the compute route, with the cookie on SSR", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return captured("created");
    }) as unknown as typeof fetch;
    await requestComputeAccess(REQUEST, { fetch: fetchImpl, cookieHeader: "nemar_session=abc" });
    expect(seen?.url).toBe("https://api.nemar.org/users/me/compute-access/request");
    expect(seen?.init.method).toBe("POST");
    expect(JSON.parse(String(seen?.init.body))).toEqual({
      purpose: REQUEST.purpose,
      accept_terms_version: "2026-11-draft",
    });
    expect((seen?.init.headers as Record<string, string>).Cookie).toBe("nemar_session=abc");
  });

  it("goes through the same-origin proxy from the browser", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = u;
      return captured("created");
    }) as unknown as typeof fetch;
    await requestComputeAccess(REQUEST, { fetch: fetchImpl });
    expect(url).toBe("/api/v1/users/me/compute-access/request");
  });

  it("gives the request a 15 second deadline: the admin mail is sent inside it", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      await requestComputeAccess(REQUEST, { fetch: respondWith(captured("created")) });
      expect(spy).toHaveBeenCalledWith(15_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("reports the 201 that opened a request (it carries no requested_at)", async () => {
    const result = await requestComputeAccess(REQUEST, { fetch: respondWith(captured("created")) });
    expect(result).toEqual({
      ok: true,
      already_requested: false,
      requested_at: null,
      email_sent: true,
    });
  });

  it("reports an admin mail that did not go out, so the success text can promise none", async () => {
    const result = await requestComputeAccess(REQUEST, {
      fetch: respondWith(captured("created_unnotified")),
    });
    expect(result.email_sent).toBe(false);
  });

  it("reports the 200 that found a request already open", async () => {
    const result = await requestComputeAccess(REQUEST, {
      fetch: respondWith(captured("already_requested")),
    });
    expect(result.already_requested).toBe(true);
    expect(result.requested_at).toBe("2026-11-05 12:00:00");
  });

  it("leaves email_sent absent when an older backend does not send it", async () => {
    const result = await requestComputeAccess(REQUEST, {
      fetch: respondWith(jsonResponse({ ok: true, already_requested: false }, 201)),
    });
    expect(result).not.toHaveProperty("email_sent");
  });

  it.each([
    "purpose_required",
    "terms_not_accepted",
    "email_not_verified",
    "orcid_not_proven",
    "profile_incomplete",
    "access_closed_denied",
    "access_closed_suspended",
    "already_active",
    "terms_unpublished",
  ])(
    "throws the captured %s refusal with its code, missing list and own sentence",
    async (name) => {
      const { status, body } = CAPTURED[name];
      const err: AccountApiError = await requestComputeAccess(REQUEST, {
        fetch: respondWith(captured(name)),
      }).then(
        () => {
          throw new Error("expected a refusal");
        },
        (e: unknown) => e as AccountApiError,
      );
      expect(err).toBeInstanceOf(AccountApiError);
      expect(err.status).toBe(status);
      expect(err.code).toBe(body.error);
      expect(err.missing).toEqual(body.missing);
      expect(err.backendMessage).toBe(body.message);
      expect(err.message).toBe(body.message);
    },
  );

  it("tells the backend's sentence from a generic one when the body has no message", async () => {
    const err: AccountApiError = await requestComputeAccess(REQUEST, {
      fetch: respondWith(jsonResponse({ error: "Failed to submit compute access request" }, 500)),
    }).then(
      () => {
        throw new Error("expected a refusal");
      },
      (e: unknown) => e as AccountApiError,
    );
    expect(err.status).toBe(500);
    expect(err.backendMessage).toBeUndefined();
  });

  it("throws on a non-JSON failure with an empty missing list", async () => {
    const err: AccountApiError = await requestComputeAccess(REQUEST, {
      fetch: respondWith(new Response("<html>bad gateway</html>", { status: 502 })),
    }).then(
      () => {
        throw new Error("expected a refusal");
      },
      (e: unknown) => e as AccountApiError,
    );
    expect(err.status).toBe(502);
    expect(err.code).toBeUndefined();
    expect(err.missing).toEqual([]);
    expect(err.backendMessage).toBeUndefined();
  });
});
