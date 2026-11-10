/**
 * Drift check between `src/lib/compute-terms.ts` and nemar-cli's
 * `shared/contract/compute-terms.ts` (website ADR 0030).
 *
 * `COMPUTE_TERMS_VERSION` is transcribed here as an INTERIM measure: the
 * intended route to the current version is `GET /compute/me`
 * (`current_terms_version`, nemar-cli phase D2), and this file and its test
 * are deleted when a page reads it from there. Until then a version that moved
 * on one side only would make every request fail `terms_not_accepted`.
 *
 * Reads the contract file as TEXT, like `account-copy-drift.test.ts`, for the
 * same reason (nemar-cli's module graph is not this repo's).
 *
 * CI sparse-checks out nemar-cli `dev` and points `NEMAR_CLI_COMPUTE_ACCESS_CONTRACT`
 * at the contract file, as every other drift test here does. When that variable is
 * set it is strict: a missing file FAILS. Without it, this looks for a sibling
 * checkout and skips visibly (`describe.skipIf`) when there is none.
 *
 * EXPECTED RED on a phase PR into the epic branch until nemar-cli `dev` carries
 * compute-terms.ts (the compute epic merges there). Never put this on `staging`
 * before then.
 */

import { describe, expect, it } from "vitest";
import { COMPUTE_TERMS_PUBLISHED, COMPUTE_TERMS_VERSION } from "../src/lib/compute-terms";

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

/** Pull `COMPUTE_TERMS_PUBLISHED = true|false` out of the contract source. */
function extractTermsPublished(source: string): boolean | undefined {
  const word = source.match(/export const COMPUTE_TERMS_PUBLISHED\s*=\s*(true|false)\s*;/)?.[1];
  return word === undefined ? undefined : word === "true";
}

/** Pull `COMPUTE_TERMS_VERSION = "<literal>"` out of the contract source. */
function extractTermsVersion(source: string): string | undefined {
  return source.match(/export const COMPUTE_TERMS_VERSION\s*=\s*"([^"]*)"/)?.[1];
}

const fs = await nodeFs();
const proc = await nodeProcess();

const ENV_PATH = proc.env.NEMAR_CLI_COMPUTE_ACCESS_CONTRACT;
const CANDIDATE_PATHS = [
  "../../nemar-cli/shared/contract/compute-terms.ts",
  "../../epic-account-tiers/shared/contract/compute-terms.ts",
];

function resolveFromCwd(maybeRelative: string): string {
  return maybeRelative.startsWith("/") ? maybeRelative : `${proc.cwd()}/${maybeRelative}`;
}

const STRICT_PATH = ENV_PATH ? resolveFromCwd(ENV_PATH) : undefined;
const FOUND_PATH = STRICT_PATH
  ? undefined
  : CANDIDATE_PATHS.map((rel) => decodeURIComponent(new URL(rel, import.meta.url).pathname)).find(
      (path) => fs.existsSync(path),
    );
const CONTRACT_PATH = STRICT_PATH ?? FOUND_PATH;
const SHOULD_SKIP = !STRICT_PATH && !FOUND_PATH;

if (SHOULD_SKIP) {
  console.info(
    "[compute-terms drift] skipped: no nemar-cli checkout found beside this one and NEMAR_CLI_COMPUTE_ACCESS_CONTRACT is unset. Set it to the contract file to compare.",
  );
}

describe("the extractor", () => {
  it("reads the constant from a source of the contract's shape", () => {
    const source = [
      "/** doc */",
      'export const COMPUTE_TERMS_VERSION = "2026-11-draft";',
      "export const COMPUTE_TERMS_PUBLISHED = false;",
    ].join("\n");
    expect(extractTermsVersion(source)).toBe("2026-11-draft");
  });

  it("answers undefined for a computed or missing constant, never a guess", () => {
    expect(extractTermsVersion("export const COMPUTE_TERMS_VERSION = `${A}`;")).toBeUndefined();
    expect(extractTermsVersion("export const OTHER = 'x';")).toBeUndefined();
  });

  it("reads the published flag, and answers undefined for anything it cannot read", () => {
    expect(extractTermsPublished("export const COMPUTE_TERMS_PUBLISHED = false;")).toBe(false);
    expect(extractTermsPublished("export const COMPUTE_TERMS_PUBLISHED = true;")).toBe(true);
    expect(extractTermsPublished("export const COMPUTE_TERMS_PUBLISHED = flag();")).toBeUndefined();
    expect(extractTermsPublished("export const OTHER = true;")).toBeUndefined();
  });

  it("matches the shape of this repo's own constant", () => {
    expect(COMPUTE_TERMS_VERSION).toMatch(/^[0-9A-Za-z._-]{1,32}$/);
  });
});

describe.skipIf(SHOULD_SKIP)("the compute terms version agrees with nemar-cli", () => {
  it("carries the same version", () => {
    expect(
      CONTRACT_PATH && fs.existsSync(CONTRACT_PATH),
      `${CONTRACT_PATH} is missing: the nemar-cli checkout step failed, or nemar-cli dev does not carry the compute epic yet`,
    ).toBe(true);
    const theirs = extractTermsVersion(fs.readFileSync(CONTRACT_PATH as string, "utf8"));
    expect(theirs, "could not read COMPUTE_TERMS_VERSION from the contract").toBeDefined();
    expect(COMPUTE_TERMS_VERSION).toBe(theirs);
  });

  it("agrees on whether the terms are published (the gap nudges follow it)", () => {
    const theirs = extractTermsPublished(fs.readFileSync(CONTRACT_PATH as string, "utf8"));
    expect(theirs, "could not read COMPUTE_TERMS_PUBLISHED from the contract").toBeDefined();
    expect(COMPUTE_TERMS_PUBLISHED).toBe(theirs);
  });
});
