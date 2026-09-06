import { describe, expect, it } from "vitest";
import { ACCOUNT_COPY } from "./account-copy";
import {
  GAP_FIELDS,
  type GapField,
  type ProfileGapAccount,
  type WireProfileGap,
  describeGap,
  describeGapBlocks,
  gapTail,
  gapsBlocking,
  gapsForFields,
  hasWireProfileGaps,
  profileGaps,
} from "./profile-gaps";

/** Every field the derivation can raise, in table order. `why` is in the
 *  table but is never account state, so it is not part of the sweep. */
const DERIVABLE: readonly GapField[] = [
  "email_verified",
  "username",
  "given_name",
  "family_name",
  "github_username",
  "city",
  "country",
];

/**
 * An account missing exactly `missing` and nothing else.
 *
 * The "filled" values are ordinary; the "blank" ones deliberately vary
 * between `null`, `""` and whitespace, because all three arrive in practice
 * (D1 NULLs, an empty form field, and a row holding a space) and all three
 * have to count as absent.
 */
function accountMissing(missing: ReadonlySet<GapField>): ProfileGapAccount {
  return {
    status: missing.has("email_verified") ? "pending" : "active",
    email_verified: !missing.has("email_verified"),
    username: missing.has("username") ? null : "alovelace",
    given_name: missing.has("given_name") ? "" : "Ada",
    family_name: missing.has("family_name") ? "  " : "Lovelace",
    github_username: missing.has("github_username") ? null : "alovelace",
    city: missing.has("city") ? "   " : "London",
    country: missing.has("country") ? "" : "United Kingdom",
  };
}

/** The same account as the backend would report it once `/auth/me` carries
 *  `profile_gaps`. `blocks` is omitted here on purpose — the table supplies
 *  it, which is the fallback path; the honoured-blocks case is its own test
 *  below. */
function wireFor(missing: ReadonlySet<GapField>): readonly WireProfileGap[] {
  return [...missing].map((field) => ({ field, set_on: [] }));
}

/** All 2^7 subsets of the derivable fields. */
function everySubset(): Array<Set<GapField>> {
  const out: Array<Set<GapField>> = [];
  for (let mask = 0; mask < 1 << DERIVABLE.length; mask += 1) {
    const set = new Set<GapField>();
    DERIVABLE.forEach((field, i) => {
      if (mask & (1 << i)) set.add(field);
    });
    out.push(set);
  }
  return out;
}

const SUBSETS = everySubset();

describe("profileGaps: the derivation", () => {
  it("raises exactly the missing fields, in table order, for all 128 combinations", () => {
    for (const missing of SUBSETS) {
      const expected = DERIVABLE.filter((f) => missing.has(f));
      expect(
        profileGaps(accountMissing(missing)).map((g) => g.field),
        `missing = [${[...missing].join(", ")}]`,
      ).toEqual(expected);
    }
  });

  it("never raises `why`: nothing is stored until the form is submitted", () => {
    for (const missing of SUBSETS) {
      expect(profileGaps(accountMissing(missing)).map((g) => g.field)).not.toContain("why");
    }
  });

  it("treats an unreadable username as 'cannot ask', not as missing", () => {
    // `/auth/me` does not carry `username`; callers resolve it through
    // `fetchAccountIdentity`, which answers `undefined` when the lookup
    // failed. Prompting someone to choose a handle they may already have —
    // and then 409ing them against their own row — is worse than omitting a
    // line they can still reach from Settings.
    const fields = profileGaps({ status: "active", email_verified: true }).map((g) => g.field);
    expect(fields).not.toContain("username");
    expect(profileGaps({ username: null }).map((g) => g.field)).toContain("username");
    expect(profileGaps({ username: "  " }).map((g) => g.field)).toContain("username");
  });

  it("does not read an absent email_verified as an unproved inbox", () => {
    // A backend that predates the flag reports `undefined`, and an active
    // account there has nothing to verify. `deriveAccountTier` makes the same
    // call for the same reason.
    expect(profileGaps({ status: "active" }).map((g) => g.field)).not.toContain("email_verified");
    expect(profileGaps({ status: "pending" }).map((g) => g.field)).toContain("email_verified");
    expect(profileGaps({ email_verified: false }).map((g) => g.field)).toContain("email_verified");
  });

  it("still raises the name under a verified ORCID iD", () => {
    // Unlike `onboardingSteps`, which skips the name STEP there because the
    // PATCH would be refused. The gap is real either way: the upload-access
    // request refuses with `missing: ["given_name", "family_name"]` whoever
    // owns the name. What the iD changes is where it is set.
    const gaps = profileGaps({ orcid_verified: true, given_name: "", family_name: "" });
    expect(gaps.map((g) => g.field)).toContain("given_name");
    const given = gaps.find((g) => g.field === "given_name");
    expect(given?.href).toBe("https://orcid.org/my-orcid");
    expect(given?.setOnCli).toBeNull();
  });

  it("answers an empty list for no session at all", () => {
    expect(profileGaps(null)).toEqual([]);
    expect(profileGaps(undefined)).toEqual([]);
  });
});

describe("profileGaps: the wire form", () => {
  it("produces byte-identical output to the derivation, for all 128 combinations", () => {
    // The switchover to a backend-computed `profile_gaps` must be a deploy
    // and not a website change, so the two paths cannot be distinguishable
    // in the output. This is the assertion that keeps that true.
    for (const missing of SUBSETS) {
      const account = accountMissing(missing);
      const derived = profileGaps(account);
      const fromWire = profileGaps({ ...account, profile_gaps: wireFor(missing) });
      expect(fromWire, `missing = [${[...missing].join(", ")}]`).toEqual(derived);
      expect(fromWire.map(describeGap)).toEqual(derived.map(describeGap));
    }
  });

  it("re-sorts the backend's order into table order", () => {
    const account = accountMissing(new Set(["city", "username", "github_username"]));
    const shuffled = profileGaps({
      ...account,
      profile_gaps: [{ field: "city" }, { field: "github_username" }, { field: "username" }],
    });
    expect(shuffled.map((g) => g.field)).toEqual(["username", "github_username", "city"]);
  });

  it("honours an empty array as 'nothing is missing'", () => {
    // The account below is missing everything; the backend says it is not.
    // Falling back to the derivation here would contradict the server on a
    // question the server owns.
    const account = accountMissing(new Set(DERIVABLE));
    expect(profileGaps({ ...account, profile_gaps: [] })).toEqual([]);
    expect(profileGaps(account).length).toBe(DERIVABLE.length);
  });

  it("takes blocks from the wire when it sends usable ones", () => {
    // The backend is the authority on what a field blocks today.
    const [gap] = profileGaps({
      profile_gaps: [{ field: "github_username", blocks: ["publication"] }],
    });
    expect(gap.blocks).toEqual(["publication"]);
    expect(describeGap(gap)).toContain("needed to publish a dataset");
  });

  it("drops block values it does not know, falling back to the table", () => {
    // A vocabulary this build predates must not render raw into a sentence,
    // and must not leave the sentence with nothing to say either.
    const [gap] = profileGaps({
      profile_gaps: [{ field: "city", blocks: ["compute", "upload_access"] }],
    });
    expect(gap.blocks).toEqual(["upload_access"]);
    const [allUnknown] = profileGaps({
      profile_gaps: [{ field: "city", blocks: ["compute"] }],
    });
    expect(allUnknown.blocks).toEqual(["upload_access"]);
  });

  it("ignores entries with no field name rather than rendering a blank line", () => {
    const gaps = profileGaps({
      profile_gaps: [
        { field: "city" },
        // Shapes a malformed backend could send. Cast at the boundary
        // because that is exactly what this guards.
        ...([{ blocks: ["upload_access"] }, null, "city"] as unknown as WireProfileGap[]),
      ],
    });
    expect(gaps.map((g) => g.field)).toEqual(["city"]);
  });

  it("reports which path it is on", () => {
    expect(hasWireProfileGaps({ profile_gaps: [] })).toBe(true);
    expect(hasWireProfileGaps({})).toBe(false);
    expect(hasWireProfileGaps(null)).toBe(false);
  });
});

describe("describeGap", () => {
  it("produces the sentence both surfaces print", () => {
    const [github] = gapsForFields(["github_username"]);
    expect(describeGap(github)).toBe(
      "GitHub handle is missing: needed to request upload access. Set it in Settings or run `nemar auth profile set-github`.",
    );
  });

  it("names the nearest wall, not every wall behind it", () => {
    // A GitHub handle blocks publication too, and the full list is on the
    // gap for a caller that wants it — but the sentence is for someone
    // deciding what to do next.
    const [github] = gapsForFields(["github_username"]);
    expect(github.blocks).toEqual(["upload_access", "publication"]);
    expect(describeGap(github)).not.toContain("publish");
  });

  it("is the label plus the tail, exactly", () => {
    // The surfaces link the LABEL at the field and print the tail after it;
    // the plain-text rendering has to be the same words in the same order.
    for (const gap of gapsForFields([...GAP_FIELDS])) {
      expect(describeGap(gap)).toBe(`${gap.label} ${gapTail(gap)}`);
    }
  });

  it("covers every known field with a real sentence", () => {
    for (const gap of gapsForFields([...GAP_FIELDS])) {
      expect(gap.known).toBe(true);
      expect(describeGap(gap)).toMatch(/ is missing: needed .+\. (Set it in|Run) .+\.$/);
      expect(describeGap(gap)).not.toContain("{");
    }
  });

  it("drops the command half when nothing on the CLI sets it", () => {
    const [given] = gapsForFields(["given_name"], { orcidVerified: true });
    expect(describeGap(given)).toBe(
      "Given name is missing: needed to request upload access. Set it in your ORCID record at orcid.org, then sign in again.",
    );
  });

  it("says what an unverified inbox blocks first", () => {
    const [email] = gapsForFields(["email_verified"]);
    expect(email.blocks).toEqual(["verified", "upload_access"]);
    expect(describeGap(email)).toBe(
      "A verified email address is missing: needed to activate your account. Set it in the verify step on your dashboard or run `nemar auth resend-verification`.",
    );
    // A deliberate change from `uploadAccessMissingFields`, which gave this
    // entry no link at all. The verify step is a real destination now — it
    // renders on /dashboard for the unverified tier (website#301) — so the
    // line points there rather than naming a place and linking nowhere.
    expect(email.href).toBe("/dashboard");
  });

  it("names the request, not publication, for the family name", () => {
    // The nearest-wall rule again, asserted on the OTHER two-block field:
    // `github_username` could pass by naming its first block for any reason,
    // and a family name blocks a DOI just as surely.
    const [family] = gapsForFields(["family_name"]);
    expect(family.blocks).toEqual(["upload_access", "publication"]);
    expect(describeGap(family)).toBe(
      "Family name is missing: needed to request upload access. Set it in Settings or run `nemar auth profile set-name`.",
    );
    expect(describeGapBlocks(family)).toBe("upload access and publication");
  });

  it("falls back to a generic need for a gap that names no block", () => {
    const [unknown] = profileGaps({ profile_gaps: [{ field: "sandbox_training" }] });
    expect(unknown.blocks).toEqual([]);
    expect(describeGap(unknown)).toBe(
      "sandbox_training is missing: needed to finish setting up your account. Set it in Settings.",
    );
  });
});

describe("gapsForFields: the refusal's `missing` array", () => {
  it("keeps the backend's order, because the backend ordered it deliberately", () => {
    expect(gapsForFields(["country", "city"]).map((g) => g.field)).toEqual(["country", "city"]);
  });

  it("links each account field at the Settings control that owns it", () => {
    expect(
      gapsForFields(["username", "github_username", "city", "country"]).map((g) => [
        g.field,
        g.href,
      ]),
    ).toEqual([
      ["username", "/settings#account-username"],
      ["github_username", "/settings#profile-github"],
      ["city", "/settings#profile-city"],
      ["country", "/settings#profile-country"],
    ]);
  });

  it("points both name halves at the row, never at the inputs", () => {
    // The inputs render only for an account with NO verified ORCID iD, and
    // the account the backend names these fields to can be exactly the other
    // kind. The row always renders.
    for (const gap of gapsForFields(["given_name", "family_name"])) {
      expect(gap.href).toBe("/settings#account-name");
    }
  });

  it("gives `why` no link: it is the textarea already on screen", () => {
    const [why] = gapsForFields(["why"]);
    expect(why.href).toBeNull();
    expect(describeGap(why)).toBe(
      "A description of what you intend to upload is missing: needed to request upload access. Set it in the request form in Settings or run `nemar auth request-upload-access`.",
    );
  });

  it("keeps an unrecognised field rather than dropping it", () => {
    // The vocabulary is closed on the backend today; swallowing a value it
    // grows tomorrow would report a refusal with no reason attached.
    const [orcid] = gapsForFields(["orcid"]);
    expect(orcid.known).toBe(false);
    expect(orcid.label).toBe("orcid");
    expect(orcid.setOnCli).toBeNull();
  });
});

describe("gapsBlocking", () => {
  it("keeps only the gaps that stop the named thing", () => {
    const gaps = gapsForFields(["email_verified", "github_username", "city"]);
    expect(gapsBlocking(gaps, "publication").map((g) => g.field)).toEqual(["github_username"]);
    expect(gapsBlocking(gaps, "upload_access").map((g) => g.field)).toEqual([
      "email_verified",
      "github_username",
      "city",
    ]);
    expect(gapsBlocking(gaps, "verified").map((g) => g.field)).toEqual(["email_verified"]);
  });
});

describe("describeGapBlocks", () => {
  it("reads as a noun list, for a surface that reports rather than instructs", () => {
    const [github] = gapsForFields(["github_username"]);
    expect(describeGapBlocks(github)).toBe("upload access and publication");
    const [city] = gapsForFields(["city"]);
    expect(describeGapBlocks(city)).toBe("upload access");
    const [email] = gapsForFields(["email_verified"]);
    expect(describeGapBlocks(email)).toBe("account activation and upload access");
  });

  it("is empty when nothing is known to be blocked", () => {
    const [unknown] = profileGaps({ profile_gaps: [{ field: "whatever" }] });
    expect(describeGapBlocks(unknown)).toBe("");
  });
});

describe("the table and the copy module agree", () => {
  it("has a label and a set-on location for every known field", () => {
    for (const gap of gapsForFields([...GAP_FIELDS])) {
      expect(gap.label.length, gap.field).toBeGreaterThan(0);
      expect(gap.setOnWeb.length, gap.field).toBeGreaterThan(0);
    }
  });

  it("spells the unknown-field destination with the copy module's word", () => {
    const [unknown] = gapsForFields(["mystery"]);
    expect(unknown.setOnWeb).toBe(ACCOUNT_COPY["gap.set_on.default_web"]);
  });
});
