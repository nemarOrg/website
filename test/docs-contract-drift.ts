/**
 * Pure half of the docs-auth contract drift check (nemar-cli#1338).
 *
 * Kept apart from the test that uses it for the reason `copy-drift.ts` is: the comparison is
 * exercised on fixtures on every run, whether or not a nemar-cli checkout happens to sit beside
 * this one. Without the split, the only thing the drift test could prove on a machine without one
 * is that it skipped.
 *
 * READS THE CONTRACT AS TEXT, and does not import it. A dynamic import would drag nemar-cli's
 * module graph into this repo's test run for a handful of constants, and would fail for reasons
 * that have nothing to do with drift. The price is that every value compared here has to be a
 * plain literal on the nemar-cli side, which it is.
 */

/** A named constant lifted out of a contract module: strings and integers only. */
export type ContractValue = string | number;

/**
 * Extract `export const NAME = "value";` and `export const NAME = <integer>;` declarations.
 *
 * Comments are stripped first, so a constant quoted in prose cannot be mistaken for a
 * declaration. A value built from an expression is deliberately NOT extracted: it is reported as
 * absent, which the comparison then calls unmirrored rather than silently matching.
 */
export function extractConstants(source: string): Map<string, ContractValue> {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const out = new Map<string, ContractValue>();
  const stringDecl = /export\s+const\s+([A-Z0-9_]+)\s*(?::[^=]+)?=\s*"([^"]*)"\s*;/g;
  for (const m of withoutComments.matchAll(stringDecl)) out.set(m[1], m[2]);
  const numberDecl = /export\s+const\s+([A-Z0-9_]+)\s*(?::[^=]+)?=\s*(\d+)\s*;/g;
  for (const m of withoutComments.matchAll(numberDecl)) out.set(m[1], Number(m[2]));
  return out;
}

export interface Difference {
  readonly key: string;
  readonly ours: ContractValue;
  readonly contract: ContractValue | undefined;
}

/**
 * Compare the values this repo carries against the contract's.
 *
 * `changed` is drift and must fail. `missing` is a name this repo expects the contract to declare
 * and it does not, which is also drift: it means the contract was renamed out from under us, or
 * the extractor stopped seeing a value that stopped being a literal. Contract names this repo
 * does not mirror are not reported at all, because the CLI declares plenty this repo has no
 * surface for.
 */
export function compareConstants(
  ours: ReadonlyMap<string, ContractValue>,
  contract: ReadonlyMap<string, ContractValue>,
): { changed: Difference[]; missing: string[] } {
  const changed: Difference[] = [];
  const missing: string[] = [];
  for (const [key, value] of ours) {
    if (!contract.has(key)) {
      missing.push(key);
      continue;
    }
    const theirs = contract.get(key);
    if (theirs !== value) changed.push({ key, ours: value, contract: theirs });
  }
  return { changed, missing };
}

export function formatDifference(d: Difference): string {
  return `${d.key}: this repo has ${JSON.stringify(d.ours)}, nemar-cli's contract has ${JSON.stringify(d.contract)}`;
}
