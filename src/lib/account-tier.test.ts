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
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  WHY_MAX_CHARS,
  WHY_MIN_CHARS,
  deriveAccountTier,
  deriveUploadAccessState,
  deriveUploadPageState,
  needsOnboarding,
  onboardingSteps,
  profileErrorMessage,
  showsUploadForm,
  uploadAccessErrorMessage,
  uploadAccessMissingFields,
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

  it("treats a disabled account as base rather than upload", () => {
    // `disabled` is not a tier this module models; what matters is that it
    // never yields "upload" without the grant.
    expect(deriveAccountTier({ status: "disabled" })).toBe("base");
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

describe("uploadAccessMissingFields", () => {
  it("links each account field at the Settings control that owns it", () => {
    expect(uploadAccessMissingFields(["city", "country", "github_username"])).toEqual([
      { field: "city", label: "City", href: "/settings#profile-city" },
      { field: "country", label: "Country", href: "/settings#profile-country" },
      { field: "github_username", label: "GitHub handle", href: "/settings#profile-github" },
    ]);
  });

  it("links the account-card fields too", () => {
    expect(uploadAccessMissingFields(["username", "given_name", "family_name"])).toEqual([
      { field: "username", label: "Username", href: "/settings#account-username" },
      { field: "given_name", label: "Given name", href: "/settings#account-given-name" },
      { field: "family_name", label: "Family name", href: "/settings#account-family-name" },
    ]);
  });

  it("gives no link to the two entries that are not Settings fields", () => {
    // `why` is the textarea already on screen and `email_verified` has its
    // own surface; a link to a field that does not exist scrolls nowhere.
    const [why, email] = uploadAccessMissingFields(["why", "email_verified"]);
    expect(why.href).toBeNull();
    expect(email.href).toBeNull();
    expect(email.label).toContain("verified email");
  });

  it("keeps an unrecognised field rather than dropping it", () => {
    // The backend's vocabulary is closed today; swallowing a value it grows
    // tomorrow would report a refusal with no reason attached.
    expect(uploadAccessMissingFields(["orcid"])).toEqual([
      { field: "orcid", label: "orcid", href: null },
    ]);
  });

  it("preserves the backend's order", () => {
    expect(uploadAccessMissingFields(["country", "city"]).map((f) => f.field)).toEqual([
      "country",
      "city",
    ]);
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
