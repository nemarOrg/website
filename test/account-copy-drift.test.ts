/**
 * Drift check between `src/lib/account-copy.ts` and nemar-cli's
 * `shared/contract/account-copy.ts` (website#309 / nemar-cli#1268 phase 8).
 *
 * The two repos share no package, so the website's copy module is a
 * transcription of the CLI's contract rather than an import of it. A
 * transcription with nothing watching it is a fork with a delay, which is
 * what this test exists to prevent: whenever a nemar-cli checkout sits beside
 * this one, every key present on both sides must carry the same string.
 *
 * **It reads the contract file as TEXT, and does not import it.** A dynamic
 * import would drag in that repo's module graph (zod, `./user.js` specifiers
 * resolved by node rather than vite) for two dozen string constants, and
 * would fail for reasons that have nothing to do with drift. Text extraction
 * has one requirement in exchange, documented in `account-copy.ts` and
 * enforced by `account-copy.test.ts`: every value is a plain string literal.
 *
 * **The comparison is tested on fixtures; the filesystem is the integration
 * path.** `extractCopy` and `compareCopy` are pure and live in
 * `./copy-drift.ts`, so all four outcomes are exercised on every run whether
 * or not a nemar-cli checkout exists. Without that split, the only thing this
 * file could prove on a machine without one was that it skipped.
 *
 * **Absent checkout skips, it does not fail.** CI clones only this repo, so
 * a hard failure would make the suite red on every machine but a
 * maintainer's.
 */

import { describe, expect, it } from "vitest";
import { ACCOUNT_COPY } from "../src/lib/account-copy";
import { compareCopy, extractCopy, formatDifference } from "./copy-drift";

/**
 * `node:fs`, reached without a static import.
 *
 * `astro check` type-checks every file in the repo and this project has no
 * `@types/node`, so `import fs from "node:fs"` would fail typecheck in CI
 * while passing locally under vitest — the same reason the other `test/*`
 * files read sources through Vite's `?raw` instead. A dynamic import with a
 * non-literal specifier is typed `any`, which is exactly the escape hatch
 * needed here: this is the one test that must read a file OUTSIDE the repo,
 * where `?raw` cannot reach.
 */
async function nodeFs(): Promise<{
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
}> {
  const specifier = "node:fs";
  return await import(/* @vite-ignore */ specifier);
}

function pathFromUrl(url: URL): string {
  return decodeURIComponent(url.pathname);
}

/**
 * Where a nemar-cli checkout is expected to sit relative to this one.
 *
 * Both repos live under one parent directory (`~/Documents/git/nemar/` on a
 * maintainer's machine, but nothing here depends on that name). The epic
 * worktree is checked first because that is where phase 8's contract lands
 * before it reaches `dev`.
 */
const CONTRACT_CANDIDATES = [
  "../../epic-account-tiers/shared/contract/account-copy.ts",
  "../../nemar-cli/shared/contract/account-copy.ts",
];

const OURS = new Map(Object.entries(ACCOUNT_COPY));

describe("the extractor", () => {
  it("reads this repo's own copy module back exactly", async () => {
    // The reader is the load-bearing half of the comparison below, and the
    // file it will be pointed at is one nobody in this repo can see. So it is
    // proved against a file of exactly that shape that everyone can: ours.
    const fs = await nodeFs();
    const self = pathFromUrl(new URL("../src/lib/account-copy.ts", import.meta.url));
    expect(fs.existsSync(self)).toBe(true);
    const extracted = extractCopy(fs.readFileSync(self, "utf8"));
    expect(Object.fromEntries(extracted)).toEqual({ ...ACCOUNT_COPY });
  });

  it("ignores a key quoted inside a comment", () => {
    const source = [
      '/* the key "tier.base.label": "Not this one" appears in prose */',
      'const X = { "tier.base.label": "Base access" };',
    ].join("\n");
    expect(extractCopy(source).get("tier.base.label")).toBe("Base access");
    expect(extractCopy(source).size).toBe(1);
  });

  it("does not invent an entry for a computed value", () => {
    // The failure mode the literal-strings-only rule exists to prevent: this
    // key is simply absent, and the comparison reports it as unmirrored
    // rather than as matching.
    const source = 'const X = { "a.b": `${MIN}-${MAX} chars`, "c.d": "plain" };';
    const extracted = extractCopy(source);
    expect(extracted.has("a.b")).toBe(false);
    expect(extracted.get("c.d")).toBe("plain");
  });
});

describe("compareCopy", () => {
  const ours = new Map([
    ["tier.base.label", "Base access"],
    ["gaps.title", "What is still missing"],
  ]);

  it("reports a changed value as drift, and nothing else", () => {
    const result = compareCopy(
      ours,
      new Map([
        ["tier.base.label", "Basic access"],
        ["gaps.title", "What is still missing"],
      ]),
    );
    expect(result.changed).toEqual([
      { key: "tier.base.label", ours: "Base access", contract: "Basic access" },
    ]);
    expect(result.unmirrored).toEqual([]);
    expect(result.contractOnly).toEqual([]);
  });

  it("reports a contract-only key without calling it drift", () => {
    // The CLI carries copy this repo has no surface for. Failing on it would
    // make every CLI-side addition break the website's suite.
    const result = compareCopy(ours, new Map([...ours, ["sandbox.intro", "Run nemar sandbox"]]));
    expect(result.contractOnly).toEqual(["sandbox.intro"]);
    expect(result.changed).toEqual([]);
    expect(result.unmirrored).toEqual([]);
  });

  it("reports a website-only key as unmirrored", () => {
    const result = compareCopy(ours, new Map([["tier.base.label", "Base access"]]));
    expect(result.unmirrored).toEqual(["gaps.title"]);
    expect(result.changed).toEqual([]);
  });

  it("calls every key unmirrored against an empty contract", () => {
    // The shape of a contract file that exists but could not be parsed —
    // every value a template literal, say. It must not read as "all clear".
    const result = compareCopy(ours, new Map());
    expect(result.unmirrored).toEqual(["tier.base.label", "gaps.title"]);
    expect(result.changed).toEqual([]);
    expect(result.contractOnly).toEqual([]);
  });

  it("says nothing when the two sides agree", () => {
    const result = compareCopy(ours, new Map(ours));
    expect(result).toEqual({ changed: [], unmirrored: [], contractOnly: [] });
  });

  it("formats a difference with both sides on their own line", () => {
    expect(formatDifference({ key: "a.b", ours: "one", contract: "two" })).toContain(
      "website:   one",
    );
    expect(formatDifference({ key: "a.b", ours: "one", contract: "two" })).toContain(
      "nemar-cli: two",
    );
  });
});

describe("website copy vs the nemar-cli contract", () => {
  it("matches string for string on every shared key", async () => {
    const fs = await nodeFs();
    const found = CONTRACT_CANDIDATES.map((rel) => pathFromUrl(new URL(rel, import.meta.url))).find(
      (path) => fs.existsSync(path),
    );

    if (!found) {
      // Not a failure: CI has no nemar-cli checkout, and phase 8 has not
      // created the contract file yet even where one exists. The comparison
      // itself is covered by the fixture tests above.
      console.info(
        `[account-copy drift] skipped: no nemar-cli contract found at any of ${CONTRACT_CANDIDATES.join(", ")} (relative to test/). Phase 8 creates shared/contract/account-copy.ts; this test compares against it as soon as it exists.`,
      );
      return;
    }

    const result = compareCopy(OURS, extractCopy(fs.readFileSync(found, "utf8")));

    if (result.contractOnly.length > 0) {
      console.info(
        `[account-copy drift] ${result.contractOnly.length} contract key(s) with no website counterpart: ${result.contractOnly.join(", ")}`,
      );
    }

    expect(
      result.changed.map(formatDifference),
      `Copy drifted from ${found}. Update whichever side is wrong — the contract is the source of truth.`,
    ).toEqual([]);
    expect(
      result.unmirrored,
      `Keys missing from ${found}. Every website copy key is meant to be mirrored in the contract; add them there (or remove them here).`,
    ).toEqual([]);
  });
});
