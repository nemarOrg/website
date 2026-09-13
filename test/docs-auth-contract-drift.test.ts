/**
 * Drift check between this repo's half of the docs admin handoff and nemar-cli's
 * `shared/contract/docs-auth.ts` (nemar-cli#1336 phase 0, issue #1338).
 *
 * WHY THIS EXISTS. The handoff has three parties in three repositories that share no package:
 * this site's authorize page, a Cloudflare Pages Function in `nemarOrg/docs`, and the backend in
 * `nemarOrg/nemar-cli`. Each spells the shared literals itself. The contract file said so in its
 * own header and called itself "the reference declaration, not yet an enforced contract" -- and
 * it had already been wrong once, naming the cookie `nemar_docs_session` while the deployed
 * Function set `__Host-nemar_docs_session`, with nothing anywhere to notice. This is the website
 * half of making it enforced; `nemarOrg/docs` carries the matching one.
 *
 * Shaped exactly like `account-copy-drift.test.ts`, including the strict/soft split and the CI
 * sparse checkout, because that pattern already survived a coordinated-release deadlock and the
 * ref pairing it settled (nemar-cli ADR 0046) applies here unchanged: compare against nemar-cli
 * `dev`, never `main`.
 *
 * WHAT IS COMPARED. Only the literals this repo genuinely mirrors. The authorize path is checked
 * differently from the rest, as a FILE on disk: this repo does not declare it as a constant, it
 * implements it as a route, so the honest assertion is that the page the contract names is the
 * page that exists.
 */

import { describe, expect, it } from "vitest";
import { DOCS_CALLBACK_PATH, DOCS_DEFAULT_NEXT } from "../src/lib/docs-authorize";
import { compareConstants, extractConstants, formatDifference } from "./docs-contract-drift";

/** `node:fs` reached without a static import: this project has no `@types/node`, so `astro check`
 *  rejects a bare one in CI while vitest resolves it locally. Same escape hatch, same reason, as
 *  `account-copy-drift.test.ts`. */
async function nodeFs(): Promise<{
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
}> {
  const specifier = "node:fs";
  return await import(/* @vite-ignore */ specifier);
}

async function nodeProcess(): Promise<{ cwd(): string; env: Record<string, string | undefined> }> {
  const specifier = "node:process";
  return await import(/* @vite-ignore */ specifier);
}

function pathFromUrl(url: URL): string {
  return decodeURIComponent(url.pathname);
}

function resolveFromCwd(maybeRelative: string, cwd: string): string {
  return maybeRelative.startsWith("/") ? maybeRelative : `${cwd}/${maybeRelative}`;
}

/** Where a nemar-cli checkout is expected to sit relative to this one, used only when
 *  `NEMAR_CLI_DOCS_CONTRACT` is unset. */
const CONTRACT_CANDIDATES = [
  "../../nemar-cli/shared/contract/docs-auth.ts",
  "../../orcid-docs-gate/shared/contract/docs-auth.ts",
];

/**
 * This repo's mirrored values, keyed by the contract's own names.
 *
 * `DOCS_DEFAULT_NEXT` is deliberately mapped onto `DOCS_GATED_PATH_PREFIX`: they are the same
 * value for the same reason (the only prefix the gate protects is the only place a refused `next`
 * may land), and pinning them together is what stops one moving without the other.
 */
const OURS = new Map<string, string | number>([
  ["DOCS_CALLBACK_PATH", DOCS_CALLBACK_PATH],
  ["DOCS_GATED_PATH_PREFIX", DOCS_DEFAULT_NEXT],
]);

const fs = await nodeFs();
const proc = await nodeProcess();

const ENV_PATH = proc.env.NEMAR_CLI_DOCS_CONTRACT;
const STRICT_CONTRACT_PATH = ENV_PATH ? resolveFromCwd(ENV_PATH, proc.cwd()) : undefined;
const FOUND_CANDIDATE = STRICT_CONTRACT_PATH
  ? undefined
  : CONTRACT_CANDIDATES.map((rel) => pathFromUrl(new URL(rel, import.meta.url))).find((path) =>
      fs.existsSync(path),
    );
const CONTRACT_PATH = STRICT_CONTRACT_PATH ?? FOUND_CANDIDATE;
const CONTRACT_EXISTS = CONTRACT_PATH !== undefined && fs.existsSync(CONTRACT_PATH);

// Strict mode never skips: a missing file when the env var is set means the CI checkout step
// failed, and that has to be loud rather than quietly vacuous.
const SHOULD_SKIP = !STRICT_CONTRACT_PATH && !CONTRACT_EXISTS;

if (SHOULD_SKIP) {
  console.info(
    `[docs-auth drift] skipped: no nemar-cli contract found at any of ${CONTRACT_CANDIDATES.join(", ")} (relative to test/), and NEMAR_CLI_DOCS_CONTRACT is unset.`,
  );
}

describe("the extractor", () => {
  it("reads plain string and integer constants", () => {
    const source = [
      'export const A_PATH = "/admin/";',
      "export const A_TTL = 60;",
      'export const TYPED: string = "x";',
    ].join("\n");
    const got = extractConstants(source);
    expect(got.get("A_PATH")).toBe("/admin/");
    expect(got.get("A_TTL")).toBe(60);
    expect(got.get("TYPED")).toBe("x");
  });

  it("ignores a constant named inside a comment", () => {
    // The failure this guards: the contract file is mostly prose, and it quotes its own constant
    // names and values throughout.
    const source = [
      '/* an earlier version named the cookie `nemar_docs_session` */',
      '// export const DOCS_SESSION_COOKIE_NAME = "wrong";',
      'export const DOCS_SESSION_COOKIE_NAME = "__Host-nemar_docs_session";',
    ].join("\n");
    const got = extractConstants(source);
    expect(got.get("DOCS_SESSION_COOKIE_NAME")).toBe("__Host-nemar_docs_session");
    expect(got.size).toBe(1);
  });

  it("does not invent an entry for a computed value", () => {
    // `DOCS_SESSION_TTL_SECONDS = 8 * 60 * 60` is exactly this shape. Reporting it as absent, so
    // the comparison calls it unmirrored, beats guessing at it.
    const source = "export const T = 8 * 60 * 60;";
    expect(extractConstants(source).has("T")).toBe(false);
  });
});

describe("compareConstants", () => {
  it("reports a changed value", () => {
    const result = compareConstants(new Map([["A", "1"]]), new Map([["A", "2"]]));
    expect(result.changed).toEqual([{ key: "A", ours: "1", contract: "2" }]);
  });

  it("reports a name the contract no longer declares", () => {
    const result = compareConstants(new Map([["A", "1"]]), new Map());
    expect(result.missing).toEqual(["A"]);
  });

  it("says nothing about contract names this repo does not mirror", () => {
    const result = compareConstants(
      new Map([["A", "1"]]),
      new Map<string, string | number>([
        ["A", "1"],
        ["B", "2"],
      ]),
    );
    expect(result.changed).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});

describe.skipIf(SHOULD_SKIP)("against nemar-cli's contract", () => {
  it("finds the contract file", () => {
    expect(CONTRACT_PATH).toBeDefined();
    // In strict mode this is the assertion that turns a broken CI checkout into a red test rather
    // than a silent pass.
    expect(CONTRACT_EXISTS).toBe(true);
  });

  it("carries the same literals nemar-cli declares", () => {
    const source = fs.readFileSync(CONTRACT_PATH as string, "utf8");
    const contract = extractConstants(source);
    // Guard against the extractor silently reading nothing, which would make every comparison
    // below vacuously pass.
    expect(contract.size).toBeGreaterThan(3);
    const { changed, missing } = compareConstants(OURS, contract);
    expect(changed.map(formatDifference)).toEqual([]);
    expect(missing).toEqual([]);
  });

  it("serves the authorize page at the path the contract names", () => {
    // This repo implements the path as a route rather than declaring it, so the honest check is
    // that the file the contract points at is the file that exists. A rename on either side
    // breaks the handoff at its first hop, where the docs Function sends the visitor.
    const source = fs.readFileSync(CONTRACT_PATH as string, "utf8");
    const authorizePath = extractConstants(source).get("DOCS_AUTHORIZE_PATH");
    expect(typeof authorizePath).toBe("string");
    const pagePath = pathFromUrl(
      new URL(`../src/pages${authorizePath as string}.astro`, import.meta.url),
    );
    expect({ authorizePath, exists: fs.existsSync(pagePath) }).toEqual({
      authorizePath,
      exists: true,
    });
  });
});
