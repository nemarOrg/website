import { describe, expect, it } from "vitest";
import { ACCOUNT_COPY, type AccountCopyKey, accountCopy, fillCopy } from "./account-copy";
import {
  COMPUTE_PURPOSE_MAX_CHARS,
  COMPUTE_PURPOSE_MIN_CHARS,
  WHY_MAX_CHARS,
  WHY_MIN_CHARS,
} from "./account-tier";

const ENTRIES = Object.entries(ACCOUNT_COPY) as Array<[AccountCopyKey, string]>;

describe("the copy table", () => {
  it("has a non-empty string for every key", () => {
    for (const [key, value] of ENTRIES) {
      expect(typeof value, key).toBe("string");
      expect(value.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("reads back through the typed accessor", () => {
    for (const [key, value] of ENTRIES) {
      expect(accountCopy(key)).toBe(value);
    }
  });

  it("carries no HTML entities", () => {
    // Every value is rendered as TEXT — through `{ACCOUNT_COPY[...]}` in an
    // Astro expression, or through `textContent` in a browser script — so an
    // `&rsquo;` here would show up on the page as five literal characters.
    // The pages this copy came from used entities because they were markup.
    for (const [key, value] of ENTRIES) {
      expect(value, key).not.toMatch(/&[a-z]+;|&#\d+;/i);
    }
  });

  it("carries no double quotes", () => {
    // `test/account-copy-drift.test.ts` reads the nemar-cli contract file as
    // TEXT (it cannot import a module from outside this repo's dependency
    // graph), matching `"key": "value"` pairs. A value containing an escaped
    // double quote would still parse, but only because the regex handles it —
    // keeping them out means the comparison never has to.
    for (const [key, value] of ENTRIES) {
      expect(value, key).not.toContain('"');
    }
  });

  it("uses `{name}` placeholders and nothing else", () => {
    for (const [key, value] of ENTRIES) {
      for (const match of value.matchAll(/\{([^}]*)\}/g)) {
        expect(match[1], `${key} has a non-identifier placeholder`).toMatch(/^\w+$/);
      }
    }
  });
});

describe("the sentences that embed a number", () => {
  it("keeps the why-text bounds in step with the constants", () => {
    // The value is a literal, because the drift test reads the nemar-cli
    // file as text and a computed one would be invisible to it. This is what
    // stops the literal drifting away from the rule it describes — and from
    // `UPLOAD_ACCESS_WHY_MIN_CHARS` / `_MAX_CHARS` in nemar-cli
    // shared/contract, which are the same two numbers.
    expect(ACCOUNT_COPY["upload_access.request.why_hint"]).toBe(
      `Describe what you intend to upload in ${WHY_MIN_CHARS}-${WHY_MAX_CHARS} characters`,
    );
  });
});

describe("compute access copy (nemar-cli 3a869903)", () => {
  /** The 27 non-`cli.` keys the compute epic added to nemar-cli's contract:
   *  22 `compute_access.*`, the two `gap.blocks` keys and the three
   *  `gap.field.affiliation.*` keys. */
  const COMPUTE_KEYS: readonly AccountCopyKey[] = [
    "compute_access.section.title",
    "compute_access.section.lede",
    "compute_access.state.none",
    "compute_access.state.requested",
    "compute_access.state.active",
    "compute_access.state.suspended",
    "compute_access.state.denied",
    "compute_access.state.revoked",
    "compute_access.request.cta",
    "compute_access.request.form_body",
    "compute_access.request.purpose_label",
    "compute_access.request.purpose_hint",
    "compute_access.request.terms_label",
    "compute_access.requested.title",
    "compute_access.requested.lede",
    "compute_access.requested.lede_dated",
    "compute_access.requested.body",
    "compute_access.granted.body",
    "compute_access.closed.body",
    "compute_access.suspended.body",
    "compute_access.terms_unpublished.body",
    "compute_access.docs_link",
    "gap.blocks.compute_access",
    "gap.blocks.noun.compute_access",
    "gap.field.affiliation.label",
    "gap.field.affiliation.set_on.web",
    "gap.field.affiliation.set_on.cli",
  ];

  it("has all 27 keys, each a non-empty string", () => {
    expect(COMPUTE_KEYS).toHaveLength(27);
    for (const key of COMPUTE_KEYS) {
      expect(Object.hasOwn(ACCOUNT_COPY, key), key).toBe(true);
      expect(ACCOUNT_COPY[key].trim().length, key).toBeGreaterThan(0);
    }
  });

  it("does not carry the CLI's own compute key", () => {
    // `cli.`-prefixed keys are the CLI's own and the website ignores them.
    expect(Object.keys(ACCOUNT_COPY).filter((k) => k.startsWith("cli."))).toEqual([]);
  });

  it("keeps the purpose bounds in step with the constants", () => {
    // The value is a literal (the drift test reads the nemar-cli file as text);
    // this is what stops it drifting from the rule it describes.
    expect(ACCOUNT_COPY["compute_access.request.purpose_hint"]).toBe(
      `Describe what you intend to compute in ${COMPUTE_PURPOSE_MIN_CHARS}-${COMPUTE_PURPOSE_MAX_CHARS} characters`,
    );
  });

  it("keeps the dated lede a template with one `{date}` placeholder", () => {
    expect(ACCOUNT_COPY["compute_access.requested.lede_dated"]).toBe(
      "An admin is reviewing your request from {date}.",
    );
    expect(fillCopy(ACCOUNT_COPY["compute_access.requested.lede_dated"], { date: "20 Oct" })).toBe(
      "An admin is reviewing your request from 20 Oct.",
    );
  });

  it("keeps the curly apostrophes of the source", () => {
    // Transcribed exactly: "We’ll" and "there’s" with U+2019, not a straight quote.
    expect(ACCOUNT_COPY["compute_access.requested.body"]).toContain("We\u2019ll");
    expect(ACCOUNT_COPY["compute_access.requested.body"]).toContain("there\u2019s");
  });
});

describe("what the copy must never say", () => {
  // The sentences these pages used to carry are the reason website#301
  // existed: `pending` stopped meaning "an admin is looking at you", and
  // sandbox training is CLI-only (nemar-cli ADR 0040), so naming it on a web
  // surface sends a browser user to a terminal for a step the web upload gate
  // does not check. Those assertions live in `test/account-tiers-ui.test.ts`
  // against the PAGES; now that the sentences live here, the module needs the
  // same guard or the pages pass by having moved the text rather than removed
  // it.
  it.each([
    [/under admin review/i, "under admin review"],
    [/awaiting admin approval/i, "awaiting admin approval"],
    [/will review your account/i, "will review your account"],
    [/sandbox/i, "sandbox"],
  ])("never says %s", (pattern) => {
    for (const [key, value] of ENTRIES) {
      expect(value, key).not.toMatch(pattern);
    }
  });
});

describe("fillCopy", () => {
  it("fills every named placeholder", () => {
    expect(
      fillCopy("Set it in {web} or run `{cli}`.", { web: "Settings", cli: "nemar auth" }),
    ).toBe("Set it in Settings or run `nemar auth`.");
  });

  it("leaves an unknown placeholder visible rather than blanking it", () => {
    // "Set it in {web}." is visibly wrong and gets fixed; "Set it in ." reads
    // like a rendering glitch nobody can attribute.
    expect(fillCopy("Set it in {web}.", {})).toBe("Set it in {web}.");
  });

  it("fills a placeholder that appears twice", () => {
    expect(fillCopy("{a} and {a}", { a: "x" })).toBe("x and x");
  });

  it("does not treat a value's own braces as a placeholder", () => {
    expect(fillCopy("{a}", { a: "{b}" })).toBe("{b}");
  });
});
