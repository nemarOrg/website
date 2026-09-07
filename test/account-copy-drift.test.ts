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
 * **CI enforces this by checking out the contract file itself.**
 * `.github/workflows/ci.yml`'s `test` job sparse-checks out nemar-cli's
 * `shared/contract/account-copy.ts` alongside this repo and points
 * `NEMAR_CLI_ACCOUNT_COPY` at it. When that env var is set, its path IS the
 * contract for this run: a missing file there means the checkout step
 * failed, so the comparison below FAILS loudly instead of skipping — a hard
 * failure used to make the suite red on every machine but a maintainer's
 * (nothing but that checkout ever set the var), which is exactly the bug
 * this enforces against.
 *
 * Without the env var — a maintainer's machine, most likely — this falls
 * back to searching `CONTRACT_CANDIDATES` for a sibling checkout exactly as
 * before, and an absent one is a VISIBLE skip (`describe.skipIf`), not a
 * silent pass: the run summary shows a skipped test rather than nothing at
 * all.
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

/**
 * `node:process`, reached the same way and for the same reason as `nodeFs`:
 * with no `@types/node` in this project the bare `process` global is not
 * declared either, so `astro check` rejects `process.cwd()` and
 * `process.env` in CI while vitest resolves them fine locally.
 */
async function nodeProcess(): Promise<{
  cwd(): string;
  env: Record<string, string | undefined>;
}> {
  const specifier = "node:process";
  return await import(/* @vite-ignore */ specifier);
}

function pathFromUrl(url: URL): string {
  return decodeURIComponent(url.pathname);
}

/**
 * Resolve a possibly-relative path against the process's working directory.
 *
 * `NEMAR_CLI_ACCOUNT_COPY` names a path relative to the CI workspace root
 * (`nemar-cli-contract/shared/contract/account-copy.ts`), not to this test
 * file the way `CONTRACT_CANDIDATES` is. The `cwd` passed in is
 * `process.cwd()`, which under `bun run test` — and under vitest generally,
 * confirmed directly rather than assumed — is the repository root, the same
 * directory `actions/checkout` puts both this repo and the sparse
 * `nemar-cli-contract/` checkout under.
 * An already-absolute value (the manual verification runs below use one) is
 * returned unchanged.
 */
function resolveFromCwd(maybeRelative: string, cwd: string): string {
  return maybeRelative.startsWith("/") ? maybeRelative : `${cwd}/${maybeRelative}`;
}

/**
 * Where a nemar-cli checkout is expected to sit relative to this one, used
 * only when `NEMAR_CLI_ACCOUNT_COPY` is unset.
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

// Resolved once, at module load, so `describe.skipIf` below has a plain
// boolean to work with rather than something computed inside a test.
const fs = await nodeFs();
const proc = await nodeProcess();

const NEMAR_CLI_ACCOUNT_COPY = proc.env.NEMAR_CLI_ACCOUNT_COPY;
const STRICT_CONTRACT_PATH = NEMAR_CLI_ACCOUNT_COPY
  ? resolveFromCwd(NEMAR_CLI_ACCOUNT_COPY, proc.cwd())
  : undefined;
const FOUND_CANDIDATE = STRICT_CONTRACT_PATH
  ? undefined
  : CONTRACT_CANDIDATES.map((rel) => pathFromUrl(new URL(rel, import.meta.url))).find((path) =>
      fs.existsSync(path),
    );
const CONTRACT_PATH = STRICT_CONTRACT_PATH ?? FOUND_CANDIDATE;
const CONTRACT_EXISTS = CONTRACT_PATH !== undefined && fs.existsSync(CONTRACT_PATH);

// Skip only in soft mode (no env var) with nothing found. Strict mode never
// skips: a missing file there is a failure, produced inside the test below
// so it shows up as a failed assertion rather than a thrown-before-collection
// error.
const SHOULD_SKIP = !STRICT_CONTRACT_PATH && !CONTRACT_EXISTS;

if (!STRICT_CONTRACT_PATH && !FOUND_CANDIDATE) {
  console.info(
    `[account-copy drift] skipped: no nemar-cli contract found at any of ${CONTRACT_CANDIDATES.join(", ")} (relative to test/), and NEMAR_CLI_ACCOUNT_COPY is unset. Phase 8 creates shared/contract/account-copy.ts; this test compares against it as soon as it exists, or set NEMAR_CLI_ACCOUNT_COPY to point at a checkout directly.`,
  );
}

describe("the extractor", () => {
  it("reads this repo's own copy module back exactly", () => {
    // The reader is the load-bearing half of the comparison below, and the
    // file it will be pointed at is one nobody in this repo can see. So it is
    // proved against a file of exactly that shape that everyone can: ours.
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

// `describe.skipIf` (not a per-`it` check) so every test declared inside —
// today there is one, but the guard is on the block, not on being first —
// is marked skipped in the run summary rather than silently absent.
describe.skipIf(SHOULD_SKIP)("website copy vs the nemar-cli contract", () => {
  it("matches string for string on every shared key", () => {
    if (STRICT_CONTRACT_PATH && !CONTRACT_EXISTS) {
      throw new Error(
        `[account-copy drift] NEMAR_CLI_ACCOUNT_COPY=${NEMAR_CLI_ACCOUNT_COPY} resolved to ${STRICT_CONTRACT_PATH}, which does not exist. This test enforces the contract when the env var is set; it does not skip on a missing file. Check the sparse-checkout step in .github/workflows/ci.yml.`,
      );
    }

    // SHOULD_SKIP is false here (the describe block would not have run
    // otherwise), and the strict-missing case threw above, so a path is
    // guaranteed at this point.
    const found = CONTRACT_PATH as string;
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
