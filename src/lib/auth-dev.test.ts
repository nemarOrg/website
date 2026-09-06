import { describe, expect, it } from "vitest";
import { buildDevUser, reissueDevSession, signDevSession, verifyDevSession } from "./auth-dev";

describe("buildDevUser", () => {
  it("returns role=user for a normal email", () => {
    const u = buildDevUser("alice@example.com");
    expect(u.role).toBe("user");
    expect(u.email).toBe("alice@example.com");
    expect(u.status).toBe("active");
  });

  it("promotes @nemar.admin emails to role=admin", () => {
    const u = buildDevUser("anyone@nemar.admin");
    expect(u.role).toBe("admin");
  });

  it("populates the profile fields by default", () => {
    const u = buildDevUser("alice@example.com");
    expect(u.city).toBe("London");
    expect(u.country).toBe("United Kingdom");
    expect(u.github_username).toBe("ada");
  });

  it("blanks the profile for @nemar.blank so the #226 nudge and gate are reachable", () => {
    const u = buildDevUser("someone@nemar.blank");
    expect(u.city).toBe("");
    expect(u.country).toBe("");
    expect(u.github_username).toBe("");
    expect(u.affiliation).toBe("");
    // ORCID identity is unaffected: it comes from the login, not self-service.
    expect(u.orcid_verified).toBe(true);
    expect(u.role).toBe("user");
    // Keeps service access, mirroring the grandfathered production
    // population, so /upload shows the softened warning banner (#236).
    expect(u.service_access).toBe(true);
  });

  it("withholds service access for @nemar.base so the hard gate is reachable", () => {
    const u = buildDevUser("someone@nemar.base");
    expect(u.service_access).toBe(false);
    // Blank profile too: the hard gate only renders when the profile is
    // incomplete AND there is no grant.
    expect(u.city).toBe("");
    expect(u.country).toBe("");
    expect(u.role).toBe("user");
  });

  // The account-tier personas (website#301). Each one exists because a state
  // is otherwise unreachable locally: the dev session never touches the
  // backend, so what `buildDevUser` returns is the whole world the page sees.
  it("puts @nemar.pending at the unverified tier so the verify step renders", () => {
    const u = buildDevUser("someone@nemar.pending");
    expect(u.status).toBe("pending");
    // Both roads out of `pending` set this flag on the backend, so the two
    // move together here too — a persona that was pending AND verified would
    // exercise a state the backend cannot produce.
    expect(u.email_verified).toBe(false);
    expect(u.service_access).toBe(false);
  });

  it("gives @nemar.asked an open upload-access request", () => {
    const u = buildDevUser("someone@nemar.asked");
    expect(u.status).toBe("active");
    expect(u.service_access).toBe(false);
    expect(u.upload_access_requested_at).toBeTruthy();
  });

  it("leaves every other base-tier persona with no open request", () => {
    // Otherwise "not requested" — the state that carries the request CTA —
    // would be unreachable.
    expect(buildDevUser("someone@nemar.base").upload_access_requested_at).toBeUndefined();
    expect(buildDevUser("someone@nemar.pending").upload_access_requested_at).toBeUndefined();
  });

  it("strips @nemar.new down to what /onboarding asks for", () => {
    const u = buildDevUser("someone@nemar.new");
    // Empty string, not absent: an absent username sends
    // `fetchAccountIdentity` to /users/me, which no dev session can reach,
    // and the step would then be skipped rather than rendered.
    expect(u.username).toBe("");
    expect(u.given_name).toBe("");
    expect(u.family_name).toBe("");
    expect(u.city).toBe("");
    expect(u.country).toBe("");
    // NOT ORCID-verified, deliberately: with a verified iD the name step is
    // skipped by design, so this persona could not exercise it.
    expect(u.orcid_verified).toBe(false);
  });

  it("gives @nemar.assigned a backend-chosen username and a complete profile", () => {
    // The one-time change offer on /onboarding (nemar-cli#1268) only renders
    // for an account whose username was ASSIGNED, and the page self-gates
    // away when anything else is outstanding — so this persona must have a
    // handle AND nothing else missing, or the offer is not what is on screen.
    const u = buildDevUser("someone@nemar.assigned");
    expect(u.username_auto_assigned).toBe(true);
    expect(u.username).toBe("alovelace");
    expect(u.city).toBe("London");
    expect(u.country).toBe("United Kingdom");
    expect(u.github_username).toBe("ada");
    expect(u.given_name).toBe("Ada");
    // Base tier, because the change is only available until an admin grants
    // upload access.
    expect(u.service_access).toBe(false);
    expect(u.status).toBe("active");
  });

  it("marks no other persona's username as auto-assigned", () => {
    // Absent means the user chose their own handle, which is every account on
    // today's backend; a persona that leaked the flag would put the offer in
    // front of them too.
    for (const domain of ["nemar.base", "nemar.blank", "nemar.new", "nemar.asked", "example.com"]) {
      expect(buildDevUser(`someone@${domain}`).username_auto_assigned, domain).toBeUndefined();
    }
  });

  it("gives @nemar.noname a verified iD and no name — the stuck state", () => {
    const u = buildDevUser("someone@nemar.noname");
    expect(u.orcid_verified).toBe(true);
    expect(u.orcid).toBeTruthy();
    expect(u.given_name).toBe("");
    expect(u.family_name).toBe("");
    // It keeps a username: the point of the persona is the NAME dead end, and
    // a missing username would send onboarding down a different branch first.
    expect(u.username).toBe("alovelace");
  });

  it("keeps every other persona named and verified", () => {
    for (const email of ["alice@example.com", "someone@nemar.blank", "someone@nemar.base"]) {
      const u = buildDevUser(email);
      expect(u.given_name, email).toBe("Ada");
      expect(u.family_name, email).toBe("Lovelace");
      expect(u.status, email).toBe("active");
      expect(u.email_verified, email).toBe(true);
    }
  });

  it("grants service access to the default persona", () => {
    expect(buildDevUser("alice@example.com").service_access).toBe(true);
  });

  it("derives a stable id from the lowercased email", () => {
    const a = buildDevUser("Alice@Example.com");
    const b = buildDevUser("alice@example.com");
    expect(a.id).toBe(b.id);
    expect(a.id).toBe("dev-alice_example_com");
  });

  it("lowercases the email regardless of input case", () => {
    expect(buildDevUser("Boss@NEMAR.ADMIN").email).toBe("boss@nemar.admin");
    expect(buildDevUser("Boss@NEMAR.ADMIN").role).toBe("admin");
  });
});

describe("signDevSession + verifyDevSession round-trip", () => {
  it("verifies a freshly-signed token back to the original user", async () => {
    const user = buildDevUser("alice@example.com");
    const token = await signDevSession(user);
    const out = await verifyDevSession(token);
    expect(out).not.toBeNull();
    expect(out?.user).toEqual(user);
  });

  it("returns null for a token with a tampered signature", async () => {
    const user = buildDevUser("alice@example.com");
    const token = await signDevSession(user);
    // Flip the first character of the signature so the HMAC fails.
    const [payload, sig] = token.split(".");
    const tamperChar = sig[0] === "A" ? "B" : "A";
    const tampered = `${payload}.${tamperChar}${sig.slice(1)}`;
    expect(await verifyDevSession(tampered)).toBeNull();
  });

  it("returns null for a token missing the dot separator", async () => {
    expect(await verifyDevSession("notatoken")).toBeNull();
    expect(await verifyDevSession("")).toBeNull();
  });

  it("returns null for a token with three segments (more than expected)", async () => {
    expect(await verifyDevSession("a.b.c")).toBeNull();
  });

  it("returns null for a token with garbage in the payload", async () => {
    // Sign a real token first, then replace the payload with invalid base64url.
    const token = await signDevSession(buildDevUser("alice@example.com"));
    const sig = token.split(".")[1];
    expect(await verifyDevSession(`!!!notbase64.${sig}`)).toBeNull();
  });
});

describe("reissueDevSession", () => {
  // Pull the signed token back out of the `nemar_session=<token>; Path=/; ...`
  // Set-Cookie string so we can verify what the cookie actually carries.
  const tokenFromCookie = (cookie: string): string =>
    cookie.split(";")[0].replace(/^nemar_session=/, "");

  it("merges the patch into the session and re-signs it verifiably", async () => {
    const user = buildDevUser("alice@example.com");
    const cookie = await reissueDevSession(user, {
      given_name: "Alice",
      family_name: "Ng",
      city: "San Diego",
    });
    const out = await verifyDevSession(tokenFromCookie(cookie));
    expect(out?.user).toEqual({
      ...user,
      given_name: "Alice",
      family_name: "Ng",
      city: "San Diego",
    });
  });

  it("drops keys the patch sets to undefined (the ORCID-unlink pattern)", async () => {
    const linked = { ...buildDevUser("alice@example.com"), orcid: "0000-0002-1825-0097" };
    const cookie = await reissueDevSession(linked, {
      orcid: undefined,
      orcid_verified: undefined,
    });
    const out = await verifyDevSession(tokenFromCookie(cookie));
    // JSON serialization strips undefined values, so the re-signed session has
    // no `orcid` key at all — the page then renders the "not linked" state.
    expect(out?.user).not.toHaveProperty("orcid");
    expect(out?.user).not.toHaveProperty("orcid_verified");
    expect(out?.user.email).toBe("alice@example.com");
  });
});
