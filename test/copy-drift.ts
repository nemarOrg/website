/**
 * The two pure halves of the account-copy drift check, split out of
 * `account-copy-drift.test.ts` so they can be tested on fixtures rather than
 * only on whatever happens to be on disk (website#309 review).
 *
 * The readers here and nemar-cli's own (in its parity test) implement the same RULE, written
 * independently in each repository, so neither imports the other: a quote-aware comment strip, the
 * same `"key": "value"` pattern, and a throw on a key matched twice. They are not shared code. If
 * one side's rule changes, the other is changed by hand, and each repository proves its reader
 * against its own copy file.
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
 * The source with its comments removed, string literals left whole.
 *
 * A scan, not a regular expression: a `//` or a quote inside a string literal is text (a URL in a
 * copy value, an apostrophe), while the same characters in a comment are not, and a comment may
 * follow code on the same line. Handles line comments, block comments, and `"`, `'` and template
 * strings with backslash escapes. A regular-expression literal is NOT recognized as one, so a
 * quote or a `//` inside one would confuse it; a copy table has none (the self-tests read each
 * repository's own copy file back, which would notice).
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i += 1;
      while (i < n) {
        const d = source[i];
        out += d;
        i += 1;
        if (d === "\\") {
          if (i < n) {
            out += source[i];
            i += 1;
          }
          continue;
        }
        if (d === c) break;
        // A raw newline ends a plain string (invalid source); never swallow the rest of the file.
        if (d === "\n" && c !== "`") break;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Pull `"key": "value"` pairs out of a TypeScript source file.
 *
 * Comments are stripped first (`stripComments`, which also removes a comment that follows code on
 * the same line) so a key quoted in prose cannot become an entry. A key that is matched TWICE
 * throws: a literal with a duplicate key is a TypeScript error anyway, and a second match is
 * exactly what a commented-out or pasted-over copy of a line looks like, so a duplicate must never
 * be settled by letting the last one win. A value that is not a plain string literal (a template
 * literal, a concatenation, a reference to a constant) is invisible to this, which is why
 * `account-copy.ts` forbids them and `account-copy.test.ts` enforces the ban; a silently unread key
 * would be a silently unchecked key.
 */
export function extractCopy(source: string): Map<string, string> {
  const withoutComments = stripComments(source);
  const entries = new Map<string, string>();
  const duplicates = new Set<string>();
  const pattern = /"([A-Za-z0-9_.]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const match of withoutComments.matchAll(pattern)) {
    if (entries.has(match[1])) duplicates.add(match[1]);
    entries.set(match[1], match[2].replace(/\\(.)/g, "$1"));
  }
  if (duplicates.size > 0) {
    throw new Error(
      `copy key matched more than once (a duplicate or a leftover line): ${[...duplicates].join(", ")}`,
    );
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
