import { describe, expect, it } from "vitest";
import { ACCOUNT_COPY, type AccountCopyKey, accountCopy, fillCopy } from "./account-copy";
import { WHY_MAX_CHARS, WHY_MIN_CHARS } from "./account-tier";

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
