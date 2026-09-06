/**
 * The two pure halves of the account-copy drift check, split out of
 * `account-copy-drift.test.ts` so they can be tested on fixtures rather than
 * only on whatever happens to be on disk (website#309 review).
 *
 * Not a `.test.ts` file on purpose: vitest collects only `*.test.ts`, and
 * Biome's `noExportsInTest` forbids exporting from one — the same arrangement
 * `test/routes/harness.ts` already uses.
 */

/** One key whose string differs between the two files. */
export interface CopyDifference {
  readonly key: string;
  readonly ours: string;
  readonly contract: string;
}

export interface CopyComparison {
  /** Present on both sides, different strings. A drift, and a failure. */
  readonly changed: readonly CopyDifference[];
  /** Ours, absent from the contract. Every website key is meant to be
   *  mirrored, so this is a failure too. */
  readonly unmirrored: readonly string[];
  /** The contract's, absent from ours. NOT a failure: the CLI legitimately
   *  carries copy this repo has no surface for (sandbox training,
   *  `nemar auth status` headings). Reported so a genuinely web-relevant
   *  addition is visible rather than silent. */
  readonly contractOnly: readonly string[];
}

/**
 * Pull `"key": "value"` pairs out of a TypeScript source file.
 *
 * Comments are stripped first so a key quoted in prose cannot become an
 * entry. A value that is not a plain string literal — a template literal, a
 * concatenation, a reference to a constant — is invisible to this, which is
 * why `account-copy.ts` forbids them and `account-copy.test.ts` enforces the
 * ban; a silently unread key would be a silently unchecked key.
 */
export function extractCopy(source: string): Map<string, string> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
  const entries = new Map<string, string>();
  const pattern = /"([A-Za-z0-9_.]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const match of withoutComments.matchAll(pattern)) {
    entries.set(match[1], match[2].replace(/\\(.)/g, "$1"));
  }
  return entries;
}

/**
 * Compare the website's copy table against the nemar-cli contract's.
 *
 * Deliberately asymmetric — see {@link CopyComparison} — and deliberately
 * total: it reports all three categories in one pass rather than throwing on
 * the first, so a caller can say everything that is wrong at once instead of
 * sending someone round the loop twice.
 */
export function compareCopy(
  ours: ReadonlyMap<string, string>,
  contract: ReadonlyMap<string, string>,
): CopyComparison {
  const changed: CopyDifference[] = [];
  const unmirrored: string[] = [];
  for (const [key, value] of ours) {
    const theirs = contract.get(key);
    if (theirs === undefined) {
      unmirrored.push(key);
    } else if (theirs !== value) {
      changed.push({ key, ours: value, contract: theirs });
    }
  }
  const contractOnly = [...contract.keys()].filter((key) => !ours.has(key));
  return { changed, unmirrored, contractOnly };
}

/** One `changed` entry as a readable block, for an assertion message. */
export function formatDifference(diff: CopyDifference): string {
  return `${diff.key}\n    website:   ${diff.ours}\n    nemar-cli: ${diff.contract}`;
}
