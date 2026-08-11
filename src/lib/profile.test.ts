import { describe, expect, it } from "vitest";
import {
  NUDGED_FIELDS,
  UPLOAD_REQUIRED_FIELDS,
  canUpload,
  formatFieldList,
  missingProfileFields,
  uploadGate,
} from "./profile";

// Shaped like the /auth/me payload: the profile fields are optional there
// (nemar-cli#910), so "absent" and "empty string" both have to behave.
const complete = { github_username: "octocat", city: "San Diego", country: "USA" };

describe("missingProfileFields", () => {
  it("returns nothing for a complete profile", () => {
    expect(missingProfileFields(complete)).toEqual([]);
  });

  it("treats absent fields as missing", () => {
    expect(missingProfileFields({})).toEqual(["city", "country", "github_username"]);
  });

  it("treats empty and whitespace-only values as missing", () => {
    expect(missingProfileFields({ ...complete, city: "" })).toEqual(["city"]);
    expect(missingProfileFields({ ...complete, country: "   " })).toEqual(["country"]);
    expect(missingProfileFields({ ...complete, github_username: "\t" })).toEqual([
      "github_username",
    ]);
  });

  it("reports in prompt order, not object order", () => {
    expect(missingProfileFields({ github_username: "", city: "", country: "" })).toEqual([
      "city",
      "country",
      "github_username",
    ]);
  });

  it("treats a null session as missing everything", () => {
    expect(missingProfileFields(null)).toEqual([...NUDGED_FIELDS]);
    expect(missingProfileFields(undefined)).toEqual([...NUDGED_FIELDS]);
  });

  it("honours a narrowed field list", () => {
    expect(missingProfileFields({}, UPLOAD_REQUIRED_FIELDS)).toEqual(["city", "country"]);
    // The GitHub handle is never part of the upload gate.
    expect(
      missingProfileFields({ city: "San Diego", country: "USA" }, UPLOAD_REQUIRED_FIELDS),
    ).toEqual([]);
  });
});

describe("canUpload", () => {
  it("requires city and country", () => {
    expect(canUpload(complete)).toBe(true);
    expect(canUpload({ city: "San Diego", country: "USA" })).toBe(true);
    expect(canUpload({ city: "San Diego" })).toBe(false);
    expect(canUpload({ country: "USA" })).toBe(false);
    expect(canUpload({})).toBe(false);
    expect(canUpload(null)).toBe(false);
  });

  it("does NOT require a GitHub handle -- that is a publish-time requirement (#129)", () => {
    expect(canUpload({ city: "San Diego", country: "USA", github_username: "" })).toBe(true);
  });

  it("rejects whitespace-only values, not just empty ones", () => {
    // The page derives its gate from canUpload directly, so the trimming has
    // to hold here and not only in missingProfileFields.
    expect(canUpload({ city: "   ", country: "USA" })).toBe(false);
    expect(canUpload({ city: "San Diego", country: "\t\n" })).toBe(false);
  });
});

describe("uploadGate", () => {
  // Real /auth/me shapes: profile columns come back as empty strings for the
  // pre-migration accounts (#236 measured all 10 service-access users this
  // way), and service_access is a boolean since nemar-cli#1013 Phase 1.
  const grandfathered = {
    github_username: "octocat",
    city: "",
    country: "",
    service_access: true,
  };

  it("opens for a complete profile regardless of tier", () => {
    expect(uploadGate({ ...complete, service_access: true })).toBe("open");
    expect(uploadGate({ ...complete, service_access: false })).toBe("open");
    expect(uploadGate(complete)).toBe("open");
  });

  it("warns instead of blocking for service-access holders (#236)", () => {
    expect(uploadGate(grandfathered)).toBe("warn");
    expect(uploadGate({ city: "San Diego", country: "", service_access: true })).toBe("warn");
  });

  it("keeps the hard block for users without a service-access grant", () => {
    expect(uploadGate({ ...grandfathered, service_access: false })).toBe("block");
    expect(uploadGate({ city: "", country: "" })).toBe("block");
  });

  it("fails closed when the flag is absent or the session is null", () => {
    // A backend that predates the flag must not soften the gate.
    expect(uploadGate({ city: "", country: "", service_access: undefined })).toBe("block");
    expect(uploadGate(null)).toBe("block");
    expect(uploadGate(undefined)).toBe("block");
  });

  it("derives incompleteness from canUpload, whitespace included", () => {
    expect(uploadGate({ city: "   ", country: "USA", service_access: true })).toBe("warn");
  });
});

describe("formatFieldList", () => {
  it("renders one, two, and three fields", () => {
    expect(formatFieldList(["city"])).toBe("city");
    expect(formatFieldList(["city", "country"])).toBe("city and country");
    expect(formatFieldList(["city", "country", "github_username"])).toBe(
      "city, country, and GitHub handle",
    );
  });

  it("returns empty for no fields", () => {
    expect(formatFieldList([])).toBe("");
  });
});
