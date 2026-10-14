/**
 * Drift check between `src/lib/publication-review-copy.ts` and nemar-cli's
 * `shared/contract/publication-review-copy.ts` (website#459 / nemar-cli#1731, Phase 4 of epic
 * nemar-cli#1726). The structure is `account-copy-drift.test.ts`'s; read its header for the
 * reasoning (text extraction rather than import, the pure halves in `./copy-drift.ts`, the
 * strict and soft modes). What differs is stated here.
 *
 * **Stricter than account copy.** The nemar-cli table has no CLI-only keys: every one of its keys
 * is for the page. So a key in the contract that this repo lacks is a drift, not a note, and
 * `contractOnly` must be empty as well as `changed` and `unmirrored`.
 *
 * **Strict and soft mode.** `NEMAR_CLI_REVIEW_COPY` set means STRICT: its path (relative paths
 * resolve against `process.cwd()`) IS the contract, and a missing file there FAILS, naming the
 * variable and `.github/workflows/ci.yml`. Unset means soft: search `CONTRACT_CANDIDATES`, and an
 * absent contract is a VISIBLE skip (`describe.skipIf` and a `console.info` line), never an early
 * return.
 */

import { describe, expect, it } from "vitest";
import { PUBLICATION_REVIEW_COPY } from "../src/lib/publication-review-copy";
import { compareCopy, extractCopy, formatDifference } from "./copy-drift";

/**
 * `node:fs`, reached without a static import: `astro check` type-checks every file and this
 * project has no `@types/node`, so a dynamic import with a non-literal specifier (typed `any`) is
 * the escape hatch for the one test that must read a file OUTSIDE the repo.
 */
async function nodeFs(): Promise<{
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
}> {
  const specifier = "node:fs";
  return await import(/* @vite-ignore */ specifier);
}

/** `node:process`, reached the same way and for the same reason as `nodeFs`. */
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
 * Resolve a possibly-relative path against the process's working directory: the CI variable names
 * a path relative to the workspace root, not to this file. An absolute value is returned unchanged.
 */
function resolveFromCwd(maybeRelative: string, cwd: string): string {
  return maybeRelative.startsWith("/") ? maybeRelative : `${cwd}/${maybeRelative}`;
}

/**
 * Where a nemar-cli checkout is expected to sit relative to this file, used only when
 * `NEMAR_CLI_REVIEW_COPY` is unset. In order: the epic worktree and then the main checkout, each
 * from a website worktree (one directory deeper, under `website-worktrees/`) and from the main
 * website checkout. The three older drift tests carry candidates that are one directory too
 * shallow from a worktree; these cover both.
 */
const CONTRACT_CANDIDATES = [
  "../../../nemar-cli-worktrees/epic-publication-review/shared/contract/publication-review-copy.ts",
  "../../nemar-cli-worktrees/epic-publication-review/shared/contract/publication-review-copy.ts",
  "../../../nemar-cli/shared/contract/publication-review-copy.ts",
  "../../nemar-cli/shared/contract/publication-review-copy.ts",
];

const OURS = new Map(Object.entries(PUBLICATION_REVIEW_COPY));

// Resolved once, at module load, so `describe.skipIf` below has a plain boolean.
const fs = await nodeFs();
const proc = await nodeProcess();

const NEMAR_CLI_REVIEW_COPY = proc.env.NEMAR_CLI_REVIEW_COPY;
const STRICT_CONTRACT_PATH = NEMAR_CLI_REVIEW_COPY
  ? resolveFromCwd(NEMAR_CLI_REVIEW_COPY, proc.cwd())
  : undefined;
const FOUND_CANDIDATE = STRICT_CONTRACT_PATH
  ? undefined
  : CONTRACT_CANDIDATES.map((rel) => pathFromUrl(new URL(rel, import.meta.url))).find((path) =>
      fs.existsSync(path),
    );
const CONTRACT_PATH = STRICT_CONTRACT_PATH ?? FOUND_CANDIDATE;
const CONTRACT_EXISTS = CONTRACT_PATH !== undefined && fs.existsSync(CONTRACT_PATH);

// Skip only in soft mode (no env var) with nothing found. Strict mode never skips: a missing file
// there is a failure, produced inside the test below as a failed assertion.
const SHOULD_SKIP = !STRICT_CONTRACT_PATH && !CONTRACT_EXISTS;

if (!STRICT_CONTRACT_PATH && !FOUND_CANDIDATE) {
  console.info(
    `[publication-review-copy drift] skipped: no nemar-cli contract found at any of ${CONTRACT_CANDIDATES.join(", ")} (relative to test/), and NEMAR_CLI_REVIEW_COPY is unset. Set NEMAR_CLI_REVIEW_COPY to point at a checkout's shared/contract/publication-review-copy.ts to run the comparison.`,
  );
}

describe("the extractor", () => {
  it("reads this repo's own copy module back exactly", () => {
    // The reader is the load-bearing half of the comparison below, and the file it is pointed at
    // is one nobody in this repo can see, so it is proved against a file of exactly that shape.
    const self = pathFromUrl(new URL("../src/lib/publication-review-copy.ts", import.meta.url));
    expect(fs.existsSync(self)).toBe(true);
    const extracted = extractCopy(fs.readFileSync(self, "utf8"));
    expect(Object.fromEntries(extracted)).toEqual({ ...PUBLICATION_REVIEW_COPY });
  });

  it("ignores a key quoted inside a comment", () => {
    const source = [
      '/* the key "gate.hard_reason": "Not this one" appears in prose */',
      'const X = { "gate.hard_reason": "The real one." };',
    ].join("\n");
    expect(extractCopy(source).get("gate.hard_reason")).toBe("The real one.");
    expect(extractCopy(source).size).toBe(1);
  });

  it("does not invent an entry for a computed value", () => {
    // The failure the literal-strings-only rule prevents: the key is simply absent, and the
    // comparison reports it as unmirrored rather than as matching.
    const source = 'const X = { "a.b": `${MIN} to ${MAX} characters`, "c.d": "plain" };';
    const extracted = extractCopy(source);
    expect(extracted.has("a.b")).toBe(false);
    expect(extracted.get("c.d")).toBe("plain");
  });
});

describe("compareCopy", () => {
  const ours = new Map([
    ["gate.hard_reason", "A reason that no override clears."],
    ["start.dispatched", "The review was started."],
  ]);

  it("reports a changed value as drift, and nothing else", () => {
    const result = compareCopy(
      ours,
      new Map([
        ["gate.hard_reason", "A reason that nothing clears."],
        ["start.dispatched", "The review was started."],
      ]),
    );
    expect(result.changed).toEqual([
      {
        key: "gate.hard_reason",
        ours: "A reason that no override clears.",
        contract: "A reason that nothing clears.",
      },
    ]);
    expect(result.unmirrored).toEqual([]);
    expect(result.contractOnly).toEqual([]);
  });

  it("reports a contract-only key, which this test treats as drift", () => {
    const result = compareCopy(ours, new Map([...ours, ["start.extra", "An extra sentence."]]));
    expect(result.contractOnly).toEqual(["start.extra"]);
    expect(result.changed).toEqual([]);
    expect(result.unmirrored).toEqual([]);
  });

  it("reports a website-only key as unmirrored", () => {
    const result = compareCopy(
      ours,
      new Map([["gate.hard_reason", "A reason that no override clears."]]),
    );
    expect(result.unmirrored).toEqual(["start.dispatched"]);
    expect(result.changed).toEqual([]);
  });

  it("calls every key unmirrored against an empty contract", () => {
    // The shape of a contract file that exists but could not be parsed; it must not read as clear.
    const result = compareCopy(ours, new Map());
    expect(result.unmirrored).toEqual(["gate.hard_reason", "start.dispatched"]);
    expect(result.changed).toEqual([]);
    expect(result.contractOnly).toEqual([]);
  });

  it("says nothing when the two sides agree", () => {
    expect(compareCopy(ours, new Map(ours))).toEqual({
      changed: [],
      unmirrored: [],
      contractOnly: [],
    });
  });

  it("formats a difference with both sides on their own line", () => {
    const text = formatDifference({ key: "a.b", ours: "one", contract: "two" });
    expect(text).toContain("website:   one");
    expect(text).toContain("nemar-cli: two");
  });
});

// `describe.skipIf` (not a per-`it` check) so every test declared inside is marked skipped in the
// run summary rather than silently absent.
describe.skipIf(SHOULD_SKIP)("website copy vs the nemar-cli contract", () => {
  it("matches string for string, key for key, in both directions", () => {
    if (STRICT_CONTRACT_PATH && !CONTRACT_EXISTS) {
      throw new Error(
        `[publication-review-copy drift] NEMAR_CLI_REVIEW_COPY=${NEMAR_CLI_REVIEW_COPY} resolved to ${STRICT_CONTRACT_PATH}, which does not exist. This test enforces the contract when the env var is set; it does not skip on a missing file. Check the sparse-checkout step in .github/workflows/ci.yml.`,
      );
    }

    // SHOULD_SKIP is false here, and the strict-missing case threw above, so a path exists.
    const found = CONTRACT_PATH as string;
    const result = compareCopy(OURS, extractCopy(fs.readFileSync(found, "utf8")));

    expect(
      result.changed.map(formatDifference),
      `Copy drifted from ${found}. Update whichever side is wrong; the contract is the source of truth.`,
    ).toEqual([]);
    expect(
      result.unmirrored,
      `Keys missing from ${found}. Every website key is mirrored in the contract; add them there or remove them here.`,
    ).toEqual([]);
    expect(
      result.contractOnly,
      `Keys in ${found} that this repo lacks. Unlike account copy, the nemar-cli table has no CLI-only keys (every key is for the page), so a key missing here is a drift; add it to src/lib/publication-review-copy.ts and give it a consumer.`,
    ).toEqual([]);
  });
});
