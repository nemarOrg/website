/**
 * Pure extractors for the compute contract drift tests (website ADR 0030, phase E2). They read
 * nemar-cli's contract files as TEXT, apart from the tests that use them for the reason
 * `mail-contract-drift.ts` is: exercised on inline sources on every run, whether or not a nemar-cli
 * checkout sits beside this one. `extractStringArray` and `compareLists` come from
 * `./mail-contract-drift`. A computed value is reported as `undefined`, never guessed.
 *
 * Shared by `compute-user-contract-drift.test.ts` and the admin compute tab's drift test.
 */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** `export const NAME = [ ... ] as const satisfies ...;` -> the strings (the form the terminal list has). */
export function extractSatisfiedArray(source: string, name: string): string[] | undefined {
  const re = new RegExp(
    `export\\s+const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]\\s*as\\s+const\\s+satisfies[^;]*;`,
  );
  const m = stripComments(source).match(re);
  return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : undefined;
}

/** `export const NAME = 25;` -> 25. A computed value is `undefined`, never a guess. */
export function extractNumber(source: string, name: string): number | undefined {
  const m = stripComments(source).match(
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(\\d+)\\s*;`),
  );
  return m ? Number(m[1]) : undefined;
}

/** `export const NAME = { a: 403, b: 401 } as const;` -> { a: 403, b: 401 }. */
export function extractNumberMap(source: string, name: string): Record<string, number> | undefined {
  const m = stripComments(source).match(
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\{([^}]*)\\}\\s*as\\s+const\\s*;`),
  );
  if (!m) return undefined;
  const out: Record<string, number> = {};
  for (const entry of m[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) out[entry[1]] = Number(entry[2]);
  return out;
}

/** `export const NAME = /^...$/;` -> the pattern source. */
export function extractRegexSource(source: string, name: string): string | undefined {
  return stripComments(source).match(
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*/(.+)/[a-z]*\\s*;`),
  )?.[1];
}

/** `{ none: ["requested"], active: ["suspended", "revoked"] }` out of a record literal. */
export function extractTransitions(
  source: string,
  name: string,
): Record<string, string[]> | undefined {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const block = stripped.match(new RegExp(`${name}[^=]*=\\s*\\{([^}]*)\\}`))?.[1];
  if (block === undefined) return undefined;
  const out: Record<string, string[]> = {};
  for (const m of block.matchAll(/(\w+)\s*:\s*\[([^\]]*)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `{ grant: "active" }` out of a record literal of string values. */
export function extractTargets(source: string, name: string): Record<string, string> | undefined {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const block = stripped.match(new RegExp(`${name}[^=]*=\\s*\\{([^}]*)\\}`))?.[1];
  if (block === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(\w+)\s*:\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return Object.keys(out).length > 0 ? out : undefined;
}
