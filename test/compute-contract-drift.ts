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

/** `export const NAME = { a: 403, // note\n b: 401 } as const satisfies Record<...>;` -> the numbers. */
export function extractSatisfiedNumberMap(
  source: string,
  name: string,
): Record<string, number> | undefined {
  const m = stripComments(source).match(
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\{([^}]*)\\}\\s*as\\s+const\\s+satisfies[^;]*;`),
  );
  if (!m) return undefined;
  const out: Record<string, number> = {};
  for (const entry of m[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) out[entry[1]] = Number(entry[2]);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `export const NAME = { a: "text", b:\n "more" } as const ...;` -> the strings (spread entries are skipped). */
export function extractStringMap(source: string, name: string): Record<string, string> | undefined {
  const stripped = stripComments(source);
  const start = stripped.search(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\{`));
  if (start < 0) return undefined;
  const end = stripped.indexOf("} as const", start);
  if (end < 0) return undefined;
  const out: Record<string, string> = {};
  for (const m of stripped.slice(start, end).matchAll(/(\w+)\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    out[m[1]] = m[2];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `export const NAME = "text";` -> the string. */
export function extractString(source: string, name: string): string | undefined {
  return stripComments(source).match(
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*;`),
  )?.[1];
}

/** `export const NAME = 1024 * 1024;` -> 1048576 (a product of whole numbers; anything else is `undefined`). */
export function extractProduct(source: string, name: string): number | undefined {
  const m = stripComments(source).match(
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(\\d+(?:\\s*\\*\\s*\\d+)*)\\s*;`),
  );
  if (!m) return undefined;
  return m[1].split("*").reduce((a, n) => a * Number(n.trim()), 1);
}

/** `export type NAME = | "a" | "b";` -> ["a", "b"] (a union of string literals only). */
export function extractStringUnion(source: string, name: string): string[] | undefined {
  const m = stripComments(source).match(new RegExp(`export\\s+type\\s+${name}\\s*=([^;]*);`));
  if (!m) return undefined;
  const parts = m[1]
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0 || !parts.every((p) => /^"[^"]*"$/.test(p))) return undefined;
  return parts.map((p) => p.slice(1, -1));
}

/**
 * The body of `function NAME(...) ... { body }`, comments removed and every run of whitespace
 * dropped, so two transcriptions compare equal exactly when their code is the same token for token.
 * The braces are matched by depth; a body holding a brace inside a string is not supported and
 * reads as whatever the depth count finds, which a comparison then reports as drift.
 */
export function extractFunctionBody(source: string, name: string): string | undefined {
  const stripped = stripComments(source);
  const start = stripped.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return undefined;
  // The body opens at the first `{` after the parameter list closes.
  let i = stripped.indexOf("(", start);
  let parens = 0;
  for (; i < stripped.length; i++) {
    if (stripped[i] === "(") parens++;
    else if (stripped[i] === ")" && --parens === 0) break;
  }
  const open = stripped.indexOf("{", i);
  if (open < 0) return undefined;
  let depth = 0;
  for (let j = open; j < stripped.length; j++) {
    if (stripped[j] === "{") depth++;
    else if (stripped[j] === "}" && --depth === 0) {
      return stripped.slice(open + 1, j).replace(/\s+/g, "");
    }
  }
  return undefined;
}
