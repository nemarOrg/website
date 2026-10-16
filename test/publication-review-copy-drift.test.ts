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
import { ACK_MAX, ACK_MIN, DENIAL_MAX, FRIENDLY_WORDS } from "../src/lib/publication-review";
import { PUBLICATION_REVIEW_COPY } from "../src/lib/publication-review-copy";
import { compareCopy, extractCopy, formatDifference, stripComments } from "./copy-drift";

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

  it("ignores a comment that follows code on the same line", () => {
    // The hole a start-of-line strip leaves: the commented pair would be matched last and win.
    const source =
      'const X = { "gate.hard_reason": "The real one.", // "gate.hard_reason": "Not this one"\n};';
    expect(extractCopy(source).get("gate.hard_reason")).toBe("The real one.");
    expect(extractCopy(source).size).toBe(1);
  });

  it("keeps a // or a quote that sits inside a string value", () => {
    const source = [
      'const X = { "a.b": "See https://example.org/x and don\'t stop", // trailing',
      '  "c.d": "plain" };',
    ].join("\n");
    const extracted = extractCopy(source);
    expect(extracted.get("a.b")).toBe("See https://example.org/x and don't stop");
    expect(extracted.get("c.d")).toBe("plain");
  });

  it("strips a block comment between entries and one that ends the file unterminated", () => {
    const source = 'const X = { "a.b": "one", /* "a.b": "two" */ "c.d": "three" }; /* "e.f": "x"';
    const extracted = extractCopy(source);
    expect([...extracted.keys()]).toEqual(["a.b", "c.d"]);
  });

  it("refuses a key matched twice, instead of letting the last one win", () => {
    const source = 'const X = { "a.b": "first", "c.d": "x", "a.b": "second" };';
    expect(() => extractCopy(source)).toThrow(/more than once.*a\.b/);
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

describe("the numbers the page copies from nemar-cli's shared/publication-limits.ts", () => {
  it("says 1 to 2,000 for a denial reason, from DENIAL_MAX", () => {
    expect(FRIENDLY_WORDS.deny_rejected).toContain(`1 to ${DENIAL_MAX.toLocaleString("en-US")}`);
  });

  it("says 10 to 500 for an acknowledgment, from ACK_MIN and ACK_MAX", () => {
    expect(PUBLICATION_REVIEW_COPY["screen_gate.acknowledge"]).toContain(
      `${ACK_MIN} to ${ACK_MAX} characters`,
    );
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

/**
 * The limits file sits beside the contract directory: `<checkout>/shared/publication-limits.ts`.
 * Derived from the contract path, so the same variable (strict) or the same candidate (soft)
 * decides which checkout is read. The CI sparse checkout carries only the contract files, so a
 * missing limits file is a VISIBLE skip (a `console.info` line and a skipped test), never a pass;
 * adding `shared/publication-limits.ts` to the sparse checkout of `.github/workflows/ci.yml` makes
 * CI compare the numbers. A present file that does not hold the three exports is a failure.
 */
const LIMITS_PATH = CONTRACT_PATH?.replace(
  /\/shared\/contract\/publication-review-copy\.ts$/,
  "/shared/publication-limits.ts",
);
const LIMITS_EXIST = LIMITS_PATH !== undefined && fs.existsSync(LIMITS_PATH);
if (CONTRACT_EXISTS && !LIMITS_EXIST && !STRICT_CONTRACT_PATH) {
  console.info(
    `[publication-review limits drift] skipped: ${LIMITS_PATH ?? "(no path)"} is not checked out. Add shared/publication-limits.ts to the sparse checkout in .github/workflows/ci.yml to enforce it.`,
  );
}

// Strict mode (the variable is set) never skips: a missing limits file fails the first test below,
// as a missing contract file fails the copy test. Only the soft search may skip, and visibly.
describe.skipIf(SHOULD_SKIP || (!STRICT_CONTRACT_PATH && !LIMITS_EXIST))(
  "page limits vs nemar-cli publication-limits",
  () => {
    const read = (): string => {
      return fs.readFileSync(LIMITS_PATH as string, "utf8");
    };
    it("finds the limits file beside the contract when the variable is set", () => {
      if (!STRICT_CONTRACT_PATH) return;
      expect(
        LIMITS_EXIST,
        `NEMAR_CLI_REVIEW_COPY=${NEMAR_CLI_REVIEW_COPY} is set, so ${LIMITS_PATH} must exist; it does not skip. Check the sparse-checkout step in .github/workflows/ci.yml for shared/publication-limits.ts.`,
      ).toBe(true);
    });
    const constant = (source: string, name: string): number => {
      const match = new RegExp(`export const ${name}\\s*=\\s*(\\d+)`).exec(stripComments(source));
      if (!match) throw new Error(`${name} is not a plain numeric export of ${LIMITS_PATH}`);
      return Number(match[1]);
    };

    it("keeps ACK_MIN, ACK_MAX and DENIAL_MAX equal to the Worker's bounds", () => {
      const source = read();
      expect(ACK_MIN, "ACKNOWLEDGMENT_MIN_LENGTH").toBe(
        constant(source, "ACKNOWLEDGMENT_MIN_LENGTH"),
      );
      expect(ACK_MAX, "ACKNOWLEDGMENT_MAX_LENGTH").toBe(
        constant(source, "ACKNOWLEDGMENT_MAX_LENGTH"),
      );
      expect(DENIAL_MAX, "DENIAL_REASON_MAX_LENGTH").toBe(
        constant(source, "DENIAL_REASON_MAX_LENGTH"),
      );
    });
  },
);
