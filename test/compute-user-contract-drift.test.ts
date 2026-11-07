/**
 * Drift check between `src/lib/compute-contract.ts` and nemar-cli's compute read vocabulary
 * (website ADR 0030 phase E2 addendum; epic nemarOrg/website#493, issue #495).
 *
 * Compared as TEXT, like the other contract drift tests (nemar-cli's module graph is not this repo's):
 *  - `shared/compute-state.ts`: the ten job states (in the backend's order), the terminal three and
 *    the four front doors;
 *  - `shared/contract/compute-user.ts`: the usage groups, the page default and maximum, the longest
 *    window, the minimum queue sample and the words a read refusal carries with their statuses;
 *  - `shared/contract/compute.ts`: the job id pattern.
 *
 * CI sparse-checks out nemar-cli `dev` and points `NEMAR_CLI_COMPUTE_STATE`,
 * `NEMAR_CLI_COMPUTE_USER_CONTRACT` and `NEMAR_CLI_COMPUTE_CONTRACT` at the three files. When a
 * variable is set it is strict: a missing file FAILS. Without them this looks for a sibling checkout
 * and skips visibly when there is none.
 *
 * EXPECTED RED on a phase PR into the epic branch until the compute epic reaches nemar-cli `dev`.
 * Never put this on `staging` before then.
 */

import { describe, expect, it } from "vitest";
import {
  COMPUTE_JOBS_PAGE_DEFAULT,
  COMPUTE_JOBS_PAGE_MAX,
  COMPUTE_JOB_ID_RE,
  COMPUTE_JOB_SOURCES,
  COMPUTE_JOB_STATES,
  COMPUTE_QUEUE_MIN_SAMPLES,
  COMPUTE_TERMINAL_STATES,
  COMPUTE_USAGE_GROUPS,
  COMPUTE_USER_ERROR_STATUS,
  COMPUTE_WINDOW_MAX_DAYS,
} from "../src/lib/compute-contract";
import {
  extractNumber,
  extractNumberMap,
  extractRegexSource,
  extractSatisfiedArray,
} from "./compute-contract-drift";
import { compareLists, extractStringArray } from "./mail-contract-drift";

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

const fs = await nodeFs();
const proc = await nodeProcess();

function resolveFromCwd(maybeRelative: string): string {
  return maybeRelative.startsWith("/") ? maybeRelative : `${proc.cwd()}/${maybeRelative}`;
}

interface Source {
  readonly envName: string;
  readonly candidates: readonly string[];
}

function locate(src: Source): { path: string | undefined; strict: boolean } {
  const fromEnv = proc.env[src.envName];
  if (fromEnv) return { path: resolveFromCwd(fromEnv), strict: true };
  const found = src.candidates
    .map((rel) => decodeURIComponent(new URL(rel, import.meta.url).pathname))
    .find((p) => fs.existsSync(p));
  return { path: found, strict: false };
}

const STATE = locate({
  envName: "NEMAR_CLI_COMPUTE_STATE",
  candidates: ["../../nemar-cli/shared/compute-state.ts"],
});
const USER = locate({
  envName: "NEMAR_CLI_COMPUTE_USER_CONTRACT",
  candidates: ["../../nemar-cli/shared/contract/compute-user.ts"],
});
const CONTRACT = locate({
  envName: "NEMAR_CLI_COMPUTE_CONTRACT",
  candidates: ["../../nemar-cli/shared/contract/compute.ts"],
});

const SHOULD_SKIP = [STATE, USER, CONTRACT].some((s) => !s.strict && !s.path);
if (SHOULD_SKIP) {
  console.info(
    "[compute-user drift] skipped: no nemar-cli checkout found beside this one and the NEMAR_CLI_COMPUTE_* variables are unset.",
  );
}

function read(src: { path: string | undefined }): string {
  expect(
    src.path && fs.existsSync(src.path),
    `${src.path} is missing: the nemar-cli checkout step failed, or nemar-cli dev does not carry the compute epic yet`,
  ).toBe(true);
  return fs.readFileSync(src.path as string, "utf8");
}

describe.skipIf(SHOULD_SKIP)("the compute read vocabulary agrees with nemar-cli", () => {
  it("has the same ten job states in the same order", () => {
    const theirs = extractStringArray(read(STATE), "COMPUTE_STATES");
    expect(compareLists("COMPUTE_STATES", COMPUTE_JOB_STATES, theirs)).toBeNull();
  });

  it("has the same terminal states", () => {
    const theirs = extractSatisfiedArray(read(STATE), "TERMINAL_COMPUTE_STATES");
    expect(compareLists("TERMINAL_COMPUTE_STATES", COMPUTE_TERMINAL_STATES, theirs)).toBeNull();
  });

  it("has the same front doors", () => {
    const theirs = extractStringArray(read(STATE), "COMPUTE_SOURCES");
    expect(compareLists("COMPUTE_SOURCES", COMPUTE_JOB_SOURCES, theirs)).toBeNull();
  });

  it("has the same usage groups", () => {
    const theirs = extractStringArray(read(USER), "COMPUTE_USAGE_GROUPS");
    expect(compareLists("COMPUTE_USAGE_GROUPS", COMPUTE_USAGE_GROUPS, theirs)).toBeNull();
  });

  it("has the same page and window numbers", () => {
    const source = read(USER);
    expect(extractNumber(source, "COMPUTE_JOBS_PAGE_DEFAULT")).toBe(COMPUTE_JOBS_PAGE_DEFAULT);
    expect(extractNumber(source, "COMPUTE_JOBS_PAGE_MAX")).toBe(COMPUTE_JOBS_PAGE_MAX);
    expect(extractNumber(source, "COMPUTE_WINDOW_MAX_DAYS")).toBe(COMPUTE_WINDOW_MAX_DAYS);
    expect(extractNumber(source, "COMPUTE_QUEUE_MIN_SAMPLES")).toBe(COMPUTE_QUEUE_MIN_SAMPLES);
  });

  it("has the same refusal words with the same statuses", () => {
    const theirs = extractNumberMap(read(USER), "COMPUTE_USER_ERROR_STATUS");
    expect(theirs, "COMPUTE_USER_ERROR_STATUS not found").toBeDefined();
    expect(COMPUTE_USER_ERROR_STATUS).toEqual(theirs);
  });

  it("has the same job id pattern", () => {
    const theirs = extractRegexSource(read(CONTRACT), "COMPUTE_JOB_ID_RE");
    expect(COMPUTE_JOB_ID_RE.source).toBe(theirs);
  });
});
