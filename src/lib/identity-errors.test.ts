import { describe, expect, it } from "vitest";
import { IDENTITY_CONFLICT_MESSAGES, identityConflictMessage } from "./identity-errors";

describe("identityConflictMessage", () => {
  it("resolves the deprecated alias to the exact same text as orcid_in_use", () => {
    expect(identityConflictMessage("orcid_already_linked")).toBe(
      identityConflictMessage("orcid_in_use"),
    );
    expect(IDENTITY_CONFLICT_MESSAGES.orcid_already_linked).toBe(
      IDENTITY_CONFLICT_MESSAGES.orcid_in_use,
    );
  });

  it("keeps orcid_linked_other a distinct message from orcid_in_use", () => {
    expect(IDENTITY_CONFLICT_MESSAGES.orcid_linked_other).not.toBe(
      IDENTITY_CONFLICT_MESSAGES.orcid_in_use,
    );
  });

  it("covers email_in_use and github_in_use with their own sentences", () => {
    expect(identityConflictMessage("email_in_use")).toMatch(/email address/i);
    expect(identityConflictMessage("github_in_use")).toMatch(/GitHub/);
    expect(IDENTITY_CONFLICT_MESSAGES.email_in_use).not.toBe(
      IDENTITY_CONFLICT_MESSAGES.github_in_use,
    );
  });

  it("every message names the self-service fix in Settings", () => {
    for (const message of Object.values(IDENTITY_CONFLICT_MESSAGES)) {
      expect(message).toMatch(/settings|sign in/i);
    }
  });

  it("degrades to undefined for an unknown code", () => {
    expect(identityConflictMessage("something_else")).toBeUndefined();
    expect(identityConflictMessage(null)).toBeUndefined();
    expect(identityConflictMessage(undefined)).toBeUndefined();
    expect(identityConflictMessage("")).toBeUndefined();
  });

  it("is prototype-safe: a prototype-polluting key never resolves", () => {
    expect(identityConflictMessage("constructor")).toBeUndefined();
    expect(identityConflictMessage("toString")).toBeUndefined();
    expect(identityConflictMessage("__proto__")).toBeUndefined();
    expect(identityConflictMessage("hasOwnProperty")).toBeUndefined();
  });
});
