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
 * `extractCopy` is checked against THIS repo's own copy module on every run,
 * so the reader is never trusted on the strength of a file nobody can see.
 *
 * **Absent checkout skips, it does not fail.** CI clones only this repo, so
 * the comparison cannot run there; a hard failure would make the suite red on
 * every machine but a maintainer's.
 */

import { describe, expect, it } from "vitest";
import { ACCOUNT_COPY } from "../src/lib/account-copy";

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

/**
 * Pull `"key": "value"` pairs out of a TypeScript source file.
 *
 * Comments are stripped first so a key quoted in prose cannot become an
 * entry. A value that is not a plain string literal — a template literal, a
 * concatenation, a reference to a constant — is invisible to this, which is
 * why `account-copy.ts` forbids them and `account-copy.test.ts` enforces the
 * ban; a silently unread key would be a silently unchecked key.
 */
function extractCopy(source: string): Map<string, string> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
  const entries = new Map<string, string>();
  const pattern = /"([A-Za-z0-9_.]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const match of withoutComments.matchAll(pattern)) {
    entries.set(match[1], match[2].replace(/\\(.)/g, "$1"));
  }
  return entries;
}

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

describe("website copy vs the nemar-cli contract", () => {
  it("matches string for string on every shared key", async () => {
    const fs = await nodeFs();
    const found = CONTRACT_CANDIDATES.map((rel) => pathFromUrl(new URL(rel, import.meta.url))).find(
      (path) => fs.existsSync(path),
    );

    if (!found) {
      // Not a failure: CI has no nemar-cli checkout, and phase 8 has not
      // created the contract file yet even where one exists.
      console.info(
        `[account-copy drift] skipped: no nemar-cli contract found at any of ${CONTRACT_CANDIDATES.join(", ")} (relative to test/). Phase 8 creates shared/contract/account-copy.ts; this test compares against it as soon as it exists.`,
      );
      return;
    }

    const contract = extractCopy(fs.readFileSync(found, "utf8"));
    const ours = new Map(Object.entries(ACCOUNT_COPY));

    const changed: string[] = [];
    const unmirrored: string[] = [];
    for (const [key, value] of ours) {
      if (!contract.has(key)) {
        unmirrored.push(key);
      } else if (contract.get(key) !== value) {
        changed.push(`${key}\n    website:  ${value}\n    nemar-cli: ${contract.get(key)}`);
      }
    }

    // Keys the CLI has and the website does not are NOT a failure: the
    // contract also carries copy for surfaces this repo has no counterpart
    // for (sandbox training, `nemar auth status` block headers). Reported so
    // a genuinely web-relevant addition is visible rather than silent.
    const cliOnly = [...contract.keys()].filter((key) => !ours.has(key));
    if (cliOnly.length > 0) {
      console.info(
        `[account-copy drift] ${cliOnly.length} contract key(s) with no website counterpart: ${cliOnly.join(", ")}`,
      );
    }

    expect(
      changed,
      `Copy drifted from ${found}. Update whichever side is wrong — the contract is the source of truth.`,
    ).toEqual([]);
    expect(
      unmirrored,
      `Keys missing from ${found}. Every website copy key is meant to be mirrored in the contract; add them there (or remove them here).`,
    ).toEqual([]);
  });
});
