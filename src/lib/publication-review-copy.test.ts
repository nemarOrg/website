import { describe, expect, it } from "vitest";
import { stripComments } from "../../test/copy-drift";
import { terminalFlaws } from "../../test/publication-review-web-words";
import { PUBLICATION_REVIEW_COPY, type PublicationReviewCopyKey } from "./publication-review-copy";

const ENTRIES = Object.entries(PUBLICATION_REVIEW_COPY) as Array<
  [PublicationReviewCopyKey, string]
>;

/**
 * The declared key set, written out so that adding or removing a key is a deliberate edit here as
 * well as in the table and in nemar-cli's `shared/contract/publication-review-copy.ts`.
 */
const DECLARED_KEYS = [
  "approve.blocked",
  "approve.override_control",
  "approve.resume",
  "approve.unavailable",
  "gate.hard_reason",
  "gate.needs_override",
  "gate.no_review_row",
  "gate.override_not_covering",
  "gate.review_changed",
  "gate.unverified",
  "review.model_findings_label",
  "review.model_summary_label",
  "review.not_assessed",
  "screen_gate.acknowledge",
  "screen_gate.blocks",
  "screen_gate.rerun",
  "screen_gate.stale",
  "screen_gate.unverified",
  "screen_gate.wait",
  "start.dispatch_claimed",
  "start.dispatched",
  "start.redispatched",
];

describe("the copy table", () => {
  it("has a non-empty string for every key", () => {
    for (const [key, value] of ENTRIES) {
      expect(typeof value, key).toBe("string");
      expect(value.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("carries exactly the declared keys", () => {
    expect(Object.keys(PUBLICATION_REVIEW_COPY).sort()).toEqual(DECLARED_KEYS);
  });

  it("keeps every key dotted, lowercase and stable", () => {
    for (const [key] of ENTRIES) {
      expect(key).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });

  it("carries no HTML entities", () => {
    // Every value is rendered as TEXT, so an `&rsquo;` would show as five literal characters.
    for (const [key, value] of ENTRIES) {
      expect(value, key).not.toMatch(/&[a-z]+;|&#\d+;/i);
    }
  });

  it("carries no double quotes", () => {
    // The drift test reads the nemar-cli contract as TEXT and matches `"key": "value"` pairs.
    for (const [key, value] of ENTRIES) {
      expect(value, key).not.toContain('"');
    }
  });

  it("carries no braces, so there is nothing to fill", () => {
    for (const [key, value] of ENTRIES) {
      expect(value, key).not.toMatch(/[{}]/);
    }
  });

  it("is plain ASCII and has no em-dash", () => {
    // Stricter than account copy, which allows curly quotes: this table follows nemar-cli's rule.
    for (const [key, value] of ENTRIES) {
      expect(value, key).toMatch(/^[\x20-\x7e]+$/);
      expect(value, key).not.toContain(String.fromCharCode(0x2014));
    }
  });
});

describe("the sentences that embed a number", () => {
  it("states the acknowledgment bounds as 10 to 500 characters", () => {
    expect(PUBLICATION_REVIEW_COPY["screen_gate.acknowledge"]).toContain("10 to 500 characters");
  });

  // The sentence is tied to the page's own constants in `publication-review.ts`, the tie
  // `account-copy.test.ts` makes for the why-hint. The file is read as text; the test fails, and
  // never skips, if the file is renamed or moved.
  const LOGIC = import.meta.glob("./publication-review.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const logicSource = Object.values(LOGIC)[0];

  it("keeps the bounds in step with ACK_MIN and ACK_MAX", () => {
    expect(logicSource, "src/lib/publication-review.ts was found by the glob").toBeDefined();
    const min = /export const ACK_MIN\s*=\s*(\d+)/.exec(logicSource ?? "")?.[1];
    const max = /export const ACK_MAX\s*=\s*(\d+)/.exec(logicSource ?? "")?.[1];
    expect(min, "ACK_MIN is exported by publication-review.ts").toBeDefined();
    expect(max, "ACK_MAX is exported by publication-review.ts").toBeDefined();
    expect(PUBLICATION_REVIEW_COPY["screen_gate.acknowledge"]).toContain(
      `${min} to ${max} characters`,
    );
  });
});

describe("what the copy must never say", () => {
  // The page prints these words, so none may name a terminal (nemar-cli ADR 0102, section 8). The
  // list is the website's copy of nemar-cli's own: `test/publication-review-web-words.ts`.
  it("breaks no terminal-words rule, tier 1 or tier 2", () => {
    for (const [key, value] of ENTRIES) {
      expect(terminalFlaws(value, 2), key).toEqual([]);
    }
  });
});

/**
 * Every `.astro` and `.ts` source under `src/`, as text, minus the copy table itself and the unit
 * tests beside it (the construction of `test/profile-gaps-ui.test.ts`).
 */
const SRC_FILES: Record<string, string> = {
  ...(import.meta.glob("../pages/**/*.astro", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>),
  ...(import.meta.glob("../components/**/*.astro", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>),
  ...(import.meta.glob("../layouts/**/*.astro", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>),
  ...(import.meta.glob("./*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>),
};

/** The sources joined with comments removed, so a key quoted in prose is not a consumer. */
const consumerText = (sources: readonly string[]): string =>
  sources.map((source) => stripComments(source)).join("\n");

/** The keys no source names as a quoted literal outside a comment. */
const orphanKeys = (keys: readonly string[], sources: readonly string[]): string[] => {
  const text = consumerText(sources);
  return keys.filter((key) => !text.includes(`"${key}"`));
};

const CONSUMER_SOURCES = consumerText(
  Object.entries(SRC_FILES)
    .filter(([path]) => !path.endsWith("/publication-review-copy.ts") && !path.endsWith(".test.ts"))
    .map(([, source]) => source),
);

describe("every copy key has a consumer", () => {
  // The pure logic (`publication-review.ts`) names each key as a quoted literal in its mapper and
  // state-machine tables. This proves a key is NAMED outside a comment, not that the line which
  // reads it is reached: `publication-review.test.ts` drives every refusal and control through the
  // real functions for that. An unconsumed key is copy nobody can see, kept in step with another
  // repository for nothing.
  it("finds each key named as a quoted literal by a page, component or lib", () => {
    const orphans = Object.keys(PUBLICATION_REVIEW_COPY).filter(
      (key) => !CONSUMER_SOURCES.includes(`"${key}"`),
    );
    expect(orphans, "unused copy keys: consume them or delete them").toEqual([]);
  });

  it("does not count a key that is only quoted in a comment", () => {
    // Synthetic sources: a key in a line comment, a trailing comment and a block comment is an
    // orphan; a key in code is not.
    const source = [
      '// "gate.hard_reason"',
      'const a = 1; // "gate.needs_override"',
      '/* "gate.unverified" */',
      'const b = say("gate.review_changed");',
    ].join("\n");
    expect(
      orphanKeys(
        ["gate.hard_reason", "gate.needs_override", "gate.unverified", "gate.review_changed"],
        [source],
      ),
    ).toEqual(["gate.hard_reason", "gate.needs_override", "gate.unverified"]);
  });

  it("is actually reading sources, not an empty haystack", () => {
    // A glob that resolved to nothing would make the check above pass for every key at once.
    expect(Object.keys(SRC_FILES).length).toBeGreaterThan(20);
    expect(CONSUMER_SOURCES).toContain('ACCOUNT_COPY["gaps.title"]');
    // The table itself is excluded: its own header names the rules, its keys are quoted in it.
    expect(CONSUMER_SOURCES).not.toContain("export const PUBLICATION_REVIEW_COPY");
  });
});
