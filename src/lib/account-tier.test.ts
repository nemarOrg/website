/**
 * The account-tier state machine (website#301).
 *
 * Every case here is shaped like a real `/auth/me` payload: the profile
 * columns come back as empty strings for accounts that predate migrations
 * 0051/0052, `service_access` and `email_verified` are booleans or absent
 * depending on how old the backend is, and `username` is absent entirely
 * because `publicUser` does not select it.
 */

import { describe, expect, it } from "vitest";
import requestResponses from "../../test/fixtures/compute/request-responses.json";
import { ACCOUNT_COPY } from "./account-copy";
import {
  COMPUTE_PURPOSE_MAX_CHARS,
  COMPUTE_PURPOSE_MIN_CHARS,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  WHY_MAX_CHARS,
  WHY_MIN_CHARS,
  computeAccessErrorMessage,
  deriveAccountTier,
  deriveComputeAccessState,
  deriveUploadAccessState,
  deriveUploadPageState,
  needsOnboarding,
  onboardingSteps,
  profileErrorMessage,
  requestStatusMessage,
  showsUploadForm,
  uploadAccessErrorMessage,
  validatePurpose,
  validateUsername,
  validateWhy,
  verifyEmailFailure,
} from "./account-tier";

const completeProfile = { city: "San Diego", country: "USA", github_username: "octocat" };

describe("deriveAccountTier", () => {
  it("reports pending as unverified whatever else the session says", () => {
    expect(deriveAccountTier({ status: "pending" })).toBe("unverified");
    // A grant cannot outrank an unproved inbox: the backend refuses the
    // cookie outright at that status.
    expect(deriveAccountTier({ status: "pending", service_access: true })).toBe("unverified");
  });

  it("reports an active account with the grant as the upload tier", () => {
    expect(deriveAccountTier({ status: "active", service_access: true })).toBe("upload");
  });

  it("reports an active account without the grant as the base tier", () => {
    expect(deriveAccountTier({ status: "active", service_access: false })).toBe("base");
  });

  it("treats an absent service_access as no grant, never as a grant", () => {
    // A backend that predates the flag must not unlock the upload surface.
    expect(deriveAccountTier({ status: "active" })).toBe("base");
  });

  it("does NOT downgrade an active account whose email_verified is absent", () => {
    // Both roads out of `pending` set the flag (nemar-cli ADR 0040 phase 2),
    // so an absent flag on an active row is an older backend — showing that
    // account a verify-your-email step would ask it to prove something it
    // already proved, with a code that would answer `already_verified`.
    expect(deriveAccountTier({ status: "active", service_access: true })).toBe("upload");
  });

  it("fails to the most restricted tier with no session", () => {
    expect(deriveAccountTier(null)).toBe("unverified");
    expect(deriveAccountTier(undefined)).toBe("unverified");
  });

  it("never gives a disabled account the upload tier, grant or no grant", () => {
    // The pairing is not reachable from today's backend —
    // `userStatusForDashboard` only answers active/pending, and revoke clears
    // the grant with the status (nemar-cli#1069) — but the two arrive as
    // separate fields, so a stale row can carry both. Answering "upload"
    // there ships the dropzone to an account the backend will refuse.
    expect(deriveAccountTier({ status: "disabled" })).toBe("base");
    expect(deriveAccountTier({ status: "disabled", service_access: true })).toBe("base");
    // "base" and not a fourth tier: nothing the website renders differs
    // between "disabled" and "signed in without a grant".
    expect(deriveUploadPageState({ status: "disabled", service_access: true })).toBe(
      "request_access",
    );
  });

  it("does not report a disabled account's stale grant as Granted", () => {
    // Settings would otherwise say "Upload access: Granted" on an account
    // `deriveAccountTier` is simultaneously calling base.
    expect(
      deriveUploadAccessState({
        status: "disabled",
        service_access: true,
        service_access_granted_at: "2026-08-01 09:00:00",
      }),
    ).toEqual({ kind: "not_requested" });
  });
});

describe("deriveUploadAccessState", () => {
  it("is granted when the flag is set, with the date when one is known", () => {
    expect(
      deriveUploadAccessState({
        status: "active",
        service_access: true,
        service_access_granted_at: "2026-08-01 09:00:00",
      }),
    ).toEqual({ kind: "granted", at: "2026-08-01 09:00:00" });
  });

  it("is granted WITHOUT a date when the backend does not send one", () => {
    // `/auth/me` carries no `service_access_granted_at` today, so the undated
    // branch is the one production actually renders.
    expect(deriveUploadAccessState({ status: "active", service_access: true })).toEqual({
      kind: "granted",
    });
  });

  it("is requested while a stamp exists and the grant does not", () => {
    expect(
      deriveUploadAccessState({
        status: "active",
        service_access: false,
        upload_access_requested_at: "2026-09-01 10:00:00",
      }),
    ).toEqual({ kind: "requested", at: "2026-09-01 10:00:00" });
  });

  it("prefers granted over requested once an admin has answered", () => {
    // The stamp stays as the record of when they asked; it must not keep
    // reading as an open request afterwards.
    expect(
      deriveUploadAccessState({
        status: "active",
        service_access: true,
        upload_access_requested_at: "2026-09-01 10:00:00",
      }),
    ).toEqual({ kind: "granted" });
  });

  it("treats a whitespace-only stamp as no request", () => {
    expect(
      deriveUploadAccessState({
        status: "active",
        service_access: false,
        upload_access_requested_at: "   ",
      }),
    ).toEqual({ kind: "not_requested" });
  });

  it("is not_requested by default", () => {
    expect(deriveUploadAccessState({ status: "active" })).toEqual({ kind: "not_requested" });
    expect(deriveUploadAccessState(null)).toEqual({ kind: "not_requested" });
  });
});

describe("deriveUploadPageState", () => {
  it("sends an unverified account to the verify step", () => {
    expect(deriveUploadPageState({ status: "pending" })).toBe("verify_email");
  });

  it("asks a base-tier account to request access", () => {
    expect(deriveUploadPageState({ status: "active", ...completeProfile })).toBe("request_access");
  });

  it("reports an open request rather than re-asking for one", () => {
    expect(
      deriveUploadPageState({
        status: "active",
        ...completeProfile,
        upload_access_requested_at: "2026-09-01 10:00:00",
      }),
    ).toBe("access_requested");
  });

  it("opens the form for a granted, complete account", () => {
    expect(
      deriveUploadPageState({ status: "active", service_access: true, ...completeProfile }),
    ).toBe("open");
  });

  it("warns but still opens the form for a granted account with a blank profile", () => {
    // Website ADR 0011: every account granted before the profile columns
    // existed has empty city/country, and blocking them would block 100% of
    // the accounts actually authorized to upload.
    expect(
      deriveUploadPageState({
        status: "active",
        service_access: true,
        city: "",
        country: "",
        github_username: "octocat",
      }),
    ).toBe("warn");
    expect(
      deriveUploadPageState({
        status: "active",
        service_access: true,
        city: "   ",
        country: "USA",
      }),
    ).toBe("warn");
  });

  it("gates the form on the grant alone", () => {
    // The two states that ship the dropzone are exactly the two with the
    // grant; an incomplete profile changes the copy, never the gate.
    expect(showsUploadForm("open")).toBe(true);
    expect(showsUploadForm("warn")).toBe(true);
    expect(showsUploadForm("request_access")).toBe(false);
    expect(showsUploadForm("access_requested")).toBe(false);
    expect(showsUploadForm("verify_email")).toBe(false);
  });

  it("never opens the form for an ungranted account, however complete", () => {
    // The pre-#301 behaviour was the reverse of this: a complete profile
    // opened the form regardless of the grant, and only an incomplete one
    // was blocked.
    expect(deriveUploadPageState({ status: "active", ...completeProfile })).not.toBe("open");
    expect(showsUploadForm(deriveUploadPageState({ status: "active", ...completeProfile }))).toBe(
      false,
    );
  });
});

describe("onboardingSteps", () => {
  it("raises every step for a brand-new ORCID-less account", () => {
    expect(
      onboardingSteps({ username: null, given_name: "", family_name: "", city: "", country: "" }),
    ).toEqual(["username", "name", "location"]);
  });

  it("skips the name step when a verified ORCID iD owns it", () => {
    // The backend answers 409 `name_is_orcid_canonical`, so asking would be
    // asking for something it will refuse.
    expect(
      onboardingSteps({
        username: null,
        given_name: "",
        family_name: "",
        city: "",
        country: "",
        orcid_verified: true,
      }),
    ).toEqual(["username", "location"]);
  });

  it("raises the name step when only one half is missing", () => {
    expect(
      onboardingSteps({
        username: "alovelace",
        given_name: "Ada",
        family_name: "",
        city: "London",
        country: "UK",
      }),
    ).toEqual(["name"]);
  });

  it("does not raise the username step when the username could not be read", () => {
    // `undefined` is "the lookup failed", not "the account has none".
    // Prompting here would 409 the user against their own row.
    expect(
      onboardingSteps({
        username: undefined,
        given_name: "Ada",
        family_name: "Lovelace",
        city: "London",
        country: "UK",
      }),
    ).toEqual([]);
  });

  it("raises the username step for an explicit null or a blank string", () => {
    const rest = {
      given_name: "Ada",
      family_name: "Lovelace",
      city: "London",
      country: "UK",
    };
    expect(onboardingSteps({ username: null, ...rest })).toEqual(["username"]);
    expect(onboardingSteps({ username: "  ", ...rest })).toEqual(["username"]);
  });

  it("is empty for a finished account", () => {
    const done = {
      username: "alovelace",
      given_name: "Ada",
      family_name: "Lovelace",
      city: "London",
      country: "UK",
    };
    expect(onboardingSteps(done)).toEqual([]);
    expect(needsOnboarding(done)).toBe(false);
    expect(needsOnboarding({ ...done, city: "" })).toBe(true);
  });
});

describe("validateUsername", () => {
  it("accepts the format the backend accepts", () => {
    expect(validateUsername("alovelace")).toBeNull();
    expect(validateUsername("a_b-c9")).toBeNull();
    expect(validateUsername("a".repeat(USERNAME_MAX_LENGTH))).toBeNull();
    expect(validateUsername("a".repeat(USERNAME_MIN_LENGTH))).toBeNull();
  });

  it("names which rule broke, matching the backend's error codes", () => {
    expect(validateUsername("ab")?.error).toBe("username_too_short");
    expect(validateUsername("a".repeat(USERNAME_MAX_LENGTH + 1))?.error).toBe("username_too_long");
    expect(validateUsername("ada lovelace")?.error).toBe("username_charset");
    expect(validateUsername("ada.lovelace")?.error).toBe("username_charset");
  });

  it("trims before measuring, as the backend does", () => {
    expect(validateUsername("  alovelace  ")).toBeNull();
    expect(validateUsername("   ")?.error).toBe("username_too_short");
  });
});

describe("validateWhy", () => {
  it("accepts text inside the backend's bounds", () => {
    expect(validateWhy("x".repeat(WHY_MIN_CHARS))).toBeNull();
    expect(validateWhy("x".repeat(WHY_MAX_CHARS))).toBeNull();
  });

  it("refuses text outside them, counting after the trim", () => {
    expect(validateWhy("x".repeat(WHY_MIN_CHARS - 1))).toContain(String(WHY_MIN_CHARS));
    expect(validateWhy("x".repeat(WHY_MAX_CHARS + 1))).toContain(String(WHY_MAX_CHARS));
    expect(validateWhy(`  ${"x".repeat(WHY_MIN_CHARS - 1)}  `)).not.toBeNull();
  });
});

describe("uploadAccessErrorMessage", () => {
  it("prefers the backend's own sentence", () => {
    // Only the backend knows WHICH fields are missing or which handle failed.
    expect(
      uploadAccessErrorMessage(400, "profile_incomplete", "Complete your profile: city, country"),
    ).toBe("Complete your profile: city, country");
  });

  it("falls back to a per-code sentence when the body carried none", () => {
    expect(uploadAccessErrorMessage(409, "already_approved")).toContain(
      "already has upload access",
    );
    expect(uploadAccessErrorMessage(400, "email_not_verified")).toContain("Verify your email");
    expect(uploadAccessErrorMessage(400, "github_username_unverified")).toContain("GitHub");
    expect(uploadAccessErrorMessage(400, "why_required")).toContain(String(WHY_MIN_CHARS));
  });

  it("ignores an empty message rather than rendering a blank error", () => {
    expect(uploadAccessErrorMessage(400, "why_required", "   ")).toContain(String(WHY_MIN_CHARS));
  });

  it("falls back to the status for a code it has never seen", () => {
    expect(uploadAccessErrorMessage(401, "something_new")).toContain("session expired");
    expect(uploadAccessErrorMessage(429, undefined)).toContain("Too many");
    expect(uploadAccessErrorMessage(503, undefined)).toContain("server had a problem");
    expect(uploadAccessErrorMessage(0, undefined)).toContain("Try again");
  });
});

describe("verifyEmailFailure", () => {
  it("sends the user for a new code when the one in hand is spent", () => {
    expect(verifyEmailFailure(401, "code_expired").needsNewCode).toBe(true);
    expect(verifyEmailFailure(401, "code_incorrect", undefined, 0).needsNewCode).toBe(true);
  });

  it("keeps the user on the same code when attempts remain", () => {
    const failure = verifyEmailFailure(401, "code_incorrect", undefined, 2);
    expect(failure.needsNewCode).toBe(false);
    expect(failure.message).toContain("did not match");
  });

  it("renders the backend's attempts-remaining sentence when it sends one", () => {
    expect(
      verifyEmailFailure(401, "code_incorrect", "That code did not match. 2 attempts left.", 2)
        .message,
    ).toBe("That code did not match. 2 attempts left.");
  });

  it("keeps the code usable after verification_incomplete", () => {
    // The backend put the code back, so the SAME one still works; sending
    // the user for another would throw away a working code.
    const failure = verifyEmailFailure(500, "verification_incomplete");
    expect(failure.needsNewCode).toBe(false);
    expect(failure.message).toContain("nothing changed");
  });

  it("does not ask for a new code on a rate limit", () => {
    const failure = verifyEmailFailure(429, undefined);
    expect(failure.needsNewCode).toBe(false);
    expect(failure.message).toContain("Too many requests");
  });

  it("distinguishes an undeliverable code from a server error", () => {
    expect(verifyEmailFailure(503, undefined).message).toContain("deliver");
    expect(verifyEmailFailure(500, undefined).message).toContain("server had a problem");
  });

  it("treats a bare 401 as an expired code", () => {
    // The pre-#301 backend collapsed wrong / expired / consumed into one
    // untyped 401; a new code is the only safe advice for it.
    expect(verifyEmailFailure(401, undefined).needsNewCode).toBe(true);
  });

  it("does not tell a signed-out user to retype a code", () => {
    expect(verifyEmailFailure(403, undefined).message).toContain("Sign in again");
    expect(verifyEmailFailure(403, undefined).needsNewCode).toBe(false);
  });
});

describe("profileErrorMessage", () => {
  it("prefers the backend's sentence", () => {
    expect(profileErrorMessage(409, "username_taken", "That username is already taken")).toBe(
      "That username is already taken",
    );
  });

  it("names the ADR 0042 codes without one", () => {
    expect(profileErrorMessage(409, "username_locked")).toContain("approved");
    expect(profileErrorMessage(409, "name_is_orcid_canonical")).toContain("ORCID");
    expect(profileErrorMessage(400, "username_charset")).toContain("letters, numbers");
    expect(profileErrorMessage(400, "given_name_required")).toContain("Given name");
  });

  it("still covers the pre-existing vocabulary", () => {
    expect(profileErrorMessage(400, "city_required")).toContain("City");
    expect(profileErrorMessage(400, "invalid_github_username")).toContain("GitHub");
    expect(profileErrorMessage(409, "github_in_use")).toContain("another NEMAR account");
  });

  it("falls back to the status for an unknown code", () => {
    expect(profileErrorMessage(404, "brand_new_code")).toContain("available yet");
    expect(profileErrorMessage(401, undefined)).toContain("session expired");
    expect(profileErrorMessage(418, undefined)).toContain("Something went wrong");
  });
});

// ---------------------------------------------------------------------------
// Compute access (website ADR 0030)
// ---------------------------------------------------------------------------

/** Refusals captured from the real backend; see test/fixtures/compute/ and
 *  scripts/capture-compute-fixtures.mjs (nemar-cli 3a869903). */
const CAPTURED = requestResponses as unknown as Record<
  string,
  { status: number; body: { error: string; message: string; missing: string[] } }
>;

describe("deriveComputeAccessState", () => {
  const REQUESTED = "2026-10-20 09:30:00";
  const GRANTED = "2026-10-24 14:05:00";

  it("answers null when the backend did not say, never `none`", () => {
    // An older backend sends no compute fields at all. Mapping that to "Not
    // requested" would invite a request the backend will refuse.
    // MUTATION: `return { state: user.compute_access ?? "none" }`.
    expect(deriveComputeAccessState({})).toBeNull();
    expect(deriveComputeAccessState(null)).toBeNull();
    expect(deriveComputeAccessState(undefined)).toBeNull();
    expect(
      deriveComputeAccessState({
        compute_access_requested_at: REQUESTED,
        compute_access_granted_at: GRANTED,
      }),
    ).toBeNull();
  });

  it("answers null for a state outside the closed six", () => {
    const unknown = { compute_access: "approved" } as unknown as Parameters<
      typeof deriveComputeAccessState
    >[0];
    expect(deriveComputeAccessState(unknown)).toBeNull();
  });

  it("answers none with no stamp", () => {
    expect(deriveComputeAccessState({ compute_access: "none" })).toEqual({ state: "none" });
    // Even a stray stamp is not shown beside a state that has none.
    expect(
      deriveComputeAccessState({ compute_access: "none", compute_access_requested_at: REQUESTED }),
    ).toEqual({ state: "none" });
  });

  it("carries the request time for requested only", () => {
    expect(
      deriveComputeAccessState({
        compute_access: "requested",
        compute_access_requested_at: REQUESTED,
      }),
    ).toEqual({ state: "requested", at: REQUESTED });
    expect(deriveComputeAccessState({ compute_access: "requested" })).toEqual({
      state: "requested",
    });
  });

  it("carries the grant time for active only", () => {
    expect(
      deriveComputeAccessState({
        compute_access: "active",
        compute_access_requested_at: REQUESTED,
        compute_access_granted_at: GRANTED,
      }),
    ).toEqual({ state: "active", at: GRANTED });
    expect(deriveComputeAccessState({ compute_access: "active" })).toEqual({ state: "active" });
  });

  it("carries no date for suspended, denied or revoked, whatever stamps the row keeps", () => {
    // The stamps are history on the backend: a suspended account still has the
    // time it was granted, and "since {date}" beside "Suspended" would claim
    // something the backend never said.
    for (const state of ["suspended", "denied", "revoked"] as const) {
      expect(
        deriveComputeAccessState({
          compute_access: state,
          compute_access_requested_at: REQUESTED,
          compute_access_granted_at: GRANTED,
        }),
        state,
      ).toEqual({ state });
    }
  });

  it("ignores a blank stamp", () => {
    expect(
      deriveComputeAccessState({ compute_access: "active", compute_access_granted_at: "  " }),
    ).toEqual({ state: "active" });
  });
});

describe("validatePurpose", () => {
  const hint = ACCOUNT_COPY["compute_access.request.purpose_hint"];

  it("pins the bounds to the backend's", () => {
    expect(COMPUTE_PURPOSE_MIN_CHARS).toBe(20);
    expect(COMPUTE_PURPOSE_MAX_CHARS).toBe(1000);
  });

  it("is inclusive at both ends, and counts the trimmed text", () => {
    expect(validatePurpose("x".repeat(19))).toBe(hint);
    expect(validatePurpose("x".repeat(20))).toBeNull();
    expect(validatePurpose("x".repeat(1000))).toBeNull();
    expect(validatePurpose("x".repeat(1001))).toBe(hint);
    expect(validatePurpose(`   ${"x".repeat(19)}   `)).toBe(hint);
    expect(validatePurpose(`   ${"x".repeat(20)}   `)).toBeNull();
    expect(validatePurpose("")).toBe(hint);
  });

  it("counts code points, not UTF-16 units", () => {
    // MUTATION: count `raw.trim().length`. Nineteen emoji are 38 units, so a
    // unit count lets them through to a database CHECK that refuses them.
    const brain = "\u{1F9E0}";
    expect(brain.length).toBe(2);
    expect(validatePurpose(brain.repeat(19))).toBe(hint);
    expect(validatePurpose(brain.repeat(20))).toBeNull();
    expect(validatePurpose(brain.repeat(1000))).toBeNull();
    expect(validatePurpose(brain.repeat(1001))).toBe(hint);
  });
});

describe("computeAccessErrorMessage", () => {
  const body = (name: string) => CAPTURED[name].body;
  const status = (name: string) => CAPTURED[name].status;

  it("prints the backend's sentence for a purpose refusal, and the shared hint without one", () => {
    expect(
      computeAccessErrorMessage(400, "purpose_required", body("purpose_required").message),
    ).toBe(body("purpose_required").message);
    expect(computeAccessErrorMessage(400, "purpose_required")).toBe(
      ACCOUNT_COPY["compute_access.request.purpose_hint"],
    );
  });

  it("prints the backend's sentence for a terms refusal, and the terms label without one", () => {
    expect(
      computeAccessErrorMessage(400, "terms_not_accepted", body("terms_not_accepted").message),
    ).toBe(body("terms_not_accepted").message);
    expect(computeAccessErrorMessage(400, "terms_not_accepted")).toBe(
      ACCOUNT_COPY["compute_access.request.terms_label"],
    );
  });

  it.each(["email_not_verified", "orcid_not_proven", "profile_incomplete"])(
    "prints the list heading, never the backend's raw field names, for %s",
    (code) => {
      // The backend sentence for profile_incomplete is
      // "...: given_name, family_name, city, country, affiliation". The page
      // renders `missing` as linked, worded lines instead.
      const captured = body(code);
      const out = computeAccessErrorMessage(status(code), code, captured.message);
      expect(out).toBe(ACCOUNT_COPY["gaps.request.title"]);
      expect(out).not.toContain("given_name");
      expect(out).not.toBe(captured.message);
    },
  );

  it("prints the backend's sentence for a closed request, falling back to the closed copy", () => {
    // Denied and revoked share a sentence; suspended has its own, and both
    // arrive under the one code `access_closed`.
    for (const name of [
      "access_closed_denied",
      "access_closed_revoked",
      "access_closed_suspended",
    ]) {
      expect(computeAccessErrorMessage(409, "access_closed", body(name).message), name).toBe(
        body(name).message,
      );
    }
    expect(computeAccessErrorMessage(409, "access_closed")).toBe(
      ACCOUNT_COPY["compute_access.closed.body"],
    );
  });

  it("prints the backend's sentence for an active account, falling back to the granted copy", () => {
    expect(computeAccessErrorMessage(409, "already_active", body("already_active").message)).toBe(
      body("already_active").message,
    );
    expect(computeAccessErrorMessage(409, "already_active")).toBe(
      ACCOUNT_COPY["compute_access.granted.body"],
    );
  });

  it("always prints the shared copy for unpublished terms", () => {
    expect(computeAccessErrorMessage(503, "terms_unpublished", "some other words")).toBe(
      ACCOUNT_COPY["compute_access.terms_unpublished.body"],
    );
    expect(
      computeAccessErrorMessage(503, "terms_unpublished", body("terms_unpublished").message),
    ).toBe(body("terms_unpublished").message);
  });

  it("never lets a known code fall through to the generic message", () => {
    // MUTATION: delete any `case` above; that code then answers the status
    // tail, which for the captured status is the generic "Couldn't send".
    const generic = requestStatusMessage(0);
    for (const name of [
      "purpose_required",
      "terms_not_accepted",
      "email_not_verified",
      "orcid_not_proven",
      "profile_incomplete",
      "access_closed_denied",
      "already_active",
      "terms_unpublished",
    ]) {
      const { error, message } = body(name);
      expect(computeAccessErrorMessage(status(name), error, message), name).not.toBe(generic);
      expect(computeAccessErrorMessage(status(name), error), `${name} without a message`).not.toBe(
        requestStatusMessage(status(name)),
      );
    }
  });

  it("ends an unknown code in the shared status tail and ignores the body's text", () => {
    expect(computeAccessErrorMessage(500, "something_new", "raw words")).toBe(
      requestStatusMessage(500),
    );
    expect(computeAccessErrorMessage(401, undefined, "Unauthorized")).toBe(
      "Your session expired. Sign in again.",
    );
    expect(computeAccessErrorMessage(429, undefined)).toBe(
      "Too many attempts. Wait a few minutes and try again.",
    );
    expect(computeAccessErrorMessage(404, undefined)).toBe(
      "This isn't available yet — check back soon.",
    );
    expect(computeAccessErrorMessage(0, undefined)).toBe("Couldn't send that request. Try again.");
  });
});

describe("requestStatusMessage", () => {
  it("is the tail the upload card ends in too, so the two cards word a status alike", () => {
    for (const status of [0, 400, 401, 404, 429, 500, 503]) {
      expect(uploadAccessErrorMessage(status, "no_such_code")).toBe(requestStatusMessage(status));
    }
  });
});
