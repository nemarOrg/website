import { describe, expect, it } from "vitest";
import requestResponses from "../../test/fixtures/compute/request-responses.json";
import { describeGap, gapsForFields } from "./profile-gaps";
import { refusalLines } from "./refusal-list";

const CAPTURED = requestResponses as unknown as Record<string, { body: { missing: string[] } }>;

describe("refusalLines", () => {
  it("is the label linked at its field plus describeGap's tail, word for word", () => {
    const lines = refusalLines(["city", "country"]);
    const gaps = gapsForFields(["city", "country"]);
    expect(lines.map((l) => l.text)).toEqual(gaps.map(describeGap));
    for (const [i, line] of lines.entries()) {
      expect(line.href).toBe(gaps[i].href);
      expect(`${line.label}${line.tail}`).toBe(line.text);
    }
    expect(lines[0].href).toBe("/settings#profile-city");
  });

  it("renders the upload refusal exactly as the old inline loop did", () => {
    const [github] = refusalLines(["github_username"]);
    expect(github.text).toBe(
      "GitHub handle is missing: needed to request upload access. Set it in Settings or run `nemar auth profile set-github`.",
    );
  });

  it("keeps the refusal's own order", () => {
    const missing = CAPTURED.profile_incomplete.body.missing;
    expect(refusalLines(missing, { block: "compute_access" }).map((l) => l.label)).toEqual([
      "Given name",
      "Family name",
      "City",
      "Country",
      "Affiliation",
    ]);
  });

  it("words a compute refusal for compute access, with the affiliation link", () => {
    const lines = refusalLines(CAPTURED.profile_incomplete.body.missing, {
      block: "compute_access",
    });
    for (const line of lines) expect(line.text).toContain("needed to request compute access");
    const affiliation = lines[lines.length - 1];
    expect(affiliation.href).toBe("/settings#profile-affiliation");
    expect(affiliation.text).toBe(
      "Affiliation is missing: needed to request compute access. Set it in Settings or run `nemar auth profile set-affiliation`.",
    );
  });

  it("words the unproven ORCID iD for compute, linking the ORCID card", () => {
    const [orcid] = refusalLines(CAPTURED.orcid_not_proven.body.missing, {
      block: "compute_access",
    });
    expect(orcid.href).toBe("/settings#orcid-card");
    expect(orcid.text).toContain("needed to request compute access");
    expect(orcid.text).not.toContain("upload access");
  });

  it("links the unverified inbox at the dashboard's verify step", () => {
    const [email] = refusalLines(CAPTURED.email_not_verified.body.missing, {
      block: "compute_access",
    });
    expect(email.href).toBe("/dashboard");
    expect(email.text).toContain("the verify step on your dashboard");
  });

  it("sends the name to the ORCID record under a verified iD", () => {
    const [given] = refusalLines(["given_name"], { orcidVerified: true, block: "compute_access" });
    expect(given.href).toBe("https://orcid.org/my-orcid");
  });

  it("renders a field with no control of its own as plain text, and an unknown one by name", () => {
    const [why] = refusalLines(["why"]);
    expect(why.href).toBeNull();
    const [unknown] = refusalLines(["something_new"]);
    expect(unknown.label).toBe("something_new");
    expect(unknown.href).toBe("/settings");
  });

  it("answers an empty list for an empty refusal", () => {
    expect(refusalLines([])).toEqual([]);
  });
});
