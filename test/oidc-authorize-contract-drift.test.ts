/**
 * Drift check between `/oauth/authorize`'s half of the authorization endpoint and nemar-cli's
 * `shared/contract/oidc-authorize.ts` (and, for the page's own path, `shared/oidc.ts`).
 *
 * The page and the API share no package. A renamed route, a new answer kind, an error code or a
 * refusal reason added on one side breaks sign-in at every client while each side's own tests stay
 * green, so the literals and the closed lists are compared here, as text.
 *
 * Shaped like `private-site-contract-drift.test.ts`, including the strict/soft split: with
 * `NEMAR_CLI_OIDC_AUTHORIZE_CONTRACT` set (CI, or a developer pointing at a worktree) the named file
 * IS the contract and its absence fails; unset, a sibling nemar-cli checkout is looked for and a
 * missing one is a visible skip. `shared/oidc.ts` is read from beside the contract file.
 */

import { describe, expect, it } from "vitest";
import {
  OIDC_AUTHORIZE_CALLER_HEADER,
  OIDC_AUTHORIZE_CALLER_VALUE,
  OIDC_AUTHORIZE_CHECK_PATH,
  OIDC_AUTHORIZE_CONSENT_PATH,
  OIDC_AUTHORIZE_KINDS,
  OIDC_AUTHORIZE_PAGE_PATH,
  OIDC_AUTHORIZE_REDIRECT_ERRORS,
  OIDC_AUTHORIZE_REQUEST_MAX_LENGTH,
  OIDC_AUTH_AFTER_PARAM,
  OIDC_AUTH_AFTER_TTL_SECONDS,
  OIDC_CONSENT_DECISIONS,
  OIDC_ERROR_PAGE_CODES,
  OIDC_RULE_REFUSAL_REASONS,
} from "../src/lib/oidc-authorize";
import { compareConstants, extractConstants, formatDifference } from "./docs-contract-drift";
import { compareLists, extractStringArray } from "./mail-contract-drift";

/** `node:fs` reached without a static import (no `@types/node` here); see the private-site test. */
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

const CONTRACT_CANDIDATES = ["../../nemar-cli/shared/contract/oidc-authorize.ts"];

const fs = await nodeFs();
const proc = await nodeProcess();

const ENV_PATH = proc.env.NEMAR_CLI_OIDC_AUTHORIZE_CONTRACT;
const STRICT_CONTRACT_PATH = ENV_PATH ? resolveFromCwd(ENV_PATH, proc.cwd()) : undefined;
const FOUND_CANDIDATE = STRICT_CONTRACT_PATH
  ? undefined
  : CONTRACT_CANDIDATES.map((rel) => pathFromUrl(new URL(rel, import.meta.url))).find((path) =>
      fs.existsSync(path),
    );
const CONTRACT_PATH = STRICT_CONTRACT_PATH ?? FOUND_CANDIDATE;
const CONTRACT_EXISTS = CONTRACT_PATH !== undefined && fs.existsSync(CONTRACT_PATH);
/** `shared/oidc.ts`, beside `shared/contract/`. */
const OIDC_PATH = CONTRACT_PATH?.replace(/contract\/oidc-authorize\.ts$/, "oidc.ts");

const SHOULD_SKIP = !STRICT_CONTRACT_PATH && !CONTRACT_EXISTS;

if (SHOULD_SKIP) {
  console.info(
    `[oidc-authorize drift] skipped: no nemar-cli contract found at any of ${CONTRACT_CANDIDATES.join(", ")} (relative to test/), and NEMAR_CLI_OIDC_AUTHORIZE_CONTRACT is unset.`,
  );
}

/** This repo's mirrored constants, keyed by the contract's own names. */
const OURS = new Map<string, string | number>([
  ["OIDC_AUTHORIZE_CHECK_PATH", OIDC_AUTHORIZE_CHECK_PATH],
  ["OIDC_AUTHORIZE_CONSENT_PATH", OIDC_AUTHORIZE_CONSENT_PATH],
  ["OIDC_AUTH_AFTER_PARAM", OIDC_AUTH_AFTER_PARAM],
  ["OIDC_AUTHORIZE_REQUEST_MAX_LENGTH", OIDC_AUTHORIZE_REQUEST_MAX_LENGTH],
  ["OIDC_AUTHORIZE_CALLER_HEADER", OIDC_AUTHORIZE_CALLER_HEADER],
  ["OIDC_AUTHORIZE_CALLER_VALUE", OIDC_AUTHORIZE_CALLER_VALUE],
  ["OIDC_AUTH_AFTER_TTL_SECONDS", OIDC_AUTH_AFTER_TTL_SECONDS],
]);

const LISTS: Array<[string, readonly string[]]> = [
  ["OIDC_AUTHORIZE_KINDS", OIDC_AUTHORIZE_KINDS],
  ["OIDC_ERROR_PAGE_CODES", OIDC_ERROR_PAGE_CODES],
  ["OIDC_RULE_REFUSAL_REASONS", OIDC_RULE_REFUSAL_REASONS],
  ["OIDC_CONSENT_DECISIONS", OIDC_CONSENT_DECISIONS],
  ["OIDC_AUTHORIZE_REDIRECT_ERRORS", OIDC_AUTHORIZE_REDIRECT_ERRORS],
];

describe.skipIf(SHOULD_SKIP)("against nemar-cli's authorization contract", () => {
  it("finds the contract file and shared/oidc.ts beside it", () => {
    expect(CONTRACT_PATH).toBeDefined();
    expect(CONTRACT_EXISTS).toBe(true);
    expect(OIDC_PATH && fs.existsSync(OIDC_PATH)).toBe(true);
  });

  it("carries the same constants nemar-cli declares", () => {
    const contract = extractConstants(fs.readFileSync(CONTRACT_PATH as string, "utf8"));
    // Guard against the extractor reading nothing, which would make every comparison pass.
    expect(contract.size).toBeGreaterThanOrEqual(OURS.size);
    const { changed, missing } = compareConstants(OURS, contract);
    expect(changed.map(formatDifference)).toEqual([]);
    expect(missing).toEqual([]);
  });

  it("carries the same closed lists, in the same order", () => {
    const source = fs.readFileSync(CONTRACT_PATH as string, "utf8");
    const drift = LISTS.map(([name, ours]) =>
      compareLists(name, ours, extractStringArray(source, name)),
    ).filter((d) => d !== null);
    expect(drift).toEqual([]);
  });

  it("serves this page at the authorization path nemar-cli's discovery names", () => {
    const oidc = extractConstants(fs.readFileSync(OIDC_PATH as string, "utf8"));
    expect(oidc.get("OIDC_AUTHORIZE_PATH")).toBe(OIDC_AUTHORIZE_PAGE_PATH);
    const pagePath = pathFromUrl(
      new URL(`../src/pages${OIDC_AUTHORIZE_PAGE_PATH}.astro`, import.meta.url),
    );
    expect(fs.existsSync(pagePath)).toBe(true);
  });
});
