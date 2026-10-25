/**
 * Pure half of the mail-admin contract drift check, apart from the test that uses it for the
 * reason `docs-contract-drift.ts` is: the extractors are exercised on inline sources on every
 * run, whether or not a nemar-cli checkout sits beside this one.
 *
 * `docs-contract-drift.ts` lifts string and number constants only. The mail contract declares
 * its closed lists as `as const` arrays and the error codes as a string-literal union, so these
 * two extractors read those. Comments are stripped first, so a list quoted in prose cannot be
 * mistaken for a declaration. A list that is built from an expression is reported as absent
 * (`undefined`), never as empty.
 */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function quoted(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/** `export const NAME = ["a", "b"] as const;` -> the strings, in order. */
export function extractStringArray(source: string, name: string): string[] | undefined {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]\\s*as\\s+const\\s*;`);
  const m = stripComments(source).match(re);
  return m ? quoted(m[1]) : undefined;
}

/** `export type NAME = | "a" | "b";` -> the strings, in order. Only a pure string-literal union. */
export function extractStringUnion(source: string, name: string): string[] | undefined {
  const re = new RegExp(`export\\s+type\\s+${name}\\s*=\\s*([^;]*);`);
  const m = stripComments(source).match(re);
  if (!m) return undefined;
  const body = m[1].trim();
  // Anything that is not `| "x" | "y"` (an indexed access, a reference) is not a literal union.
  if (!/^(\|\s*)?"[^"]*"(\s*\|\s*"[^"]*")*$/.test(body)) return undefined;
  return quoted(body);
}

export interface ListDifference {
  readonly name: string;
  readonly onlyHere: string[];
  readonly onlyContract: string[];
  readonly sameSet: boolean;
}

/** Order matters for the four lists (the contract's order is the UI's), so a reorder is drift. */
export function compareLists(
  name: string,
  ours: readonly string[],
  contract: readonly string[] | undefined,
): string | null {
  if (contract === undefined) return `${name}: not found in the contract as a literal list`;
  if (ours.length === contract.length && ours.every((v, i) => v === contract[i])) return null;
  const onlyHere = ours.filter((v) => !contract.includes(v));
  const onlyContract = contract.filter((v) => !ours.includes(v));
  return `${name}: this repo has ${JSON.stringify(ours)}, the contract has ${JSON.stringify(contract)} (only here: ${JSON.stringify(onlyHere)}; only in the contract: ${JSON.stringify(onlyContract)})`;
}
