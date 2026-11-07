/**
 * Drift check between `src/lib/compute-contract.ts` and nemar-cli's job-route vocabulary (website ADR
 * 0030 phase E3 addendum; epic nemarOrg/website#493, issue #496).
 *
 * Compared as TEXT, like the other contract drift tests:
 *  - `shared/compute-state.ts`: the launcher, platform and submitter failure codes (the job page has
 *    one sentence for each) and the status every refusal answers with;
 *  - `shared/contract/compute-submit.ts`: the truncated-log header, the log and result-page bounds and
 *    the one refusal sentence this site transcribes (`upload_expired`);
 *  - `shared/contract/compute-responses.ts`: the cancel outcomes.
 *
 * CI sparse-checks out nemar-cli `dev` and points `NEMAR_CLI_COMPUTE_STATE`,
 * `NEMAR_CLI_COMPUTE_SUBMIT_CONTRACT` and `NEMAR_CLI_COMPUTE_RESPONSES_CONTRACT` at the files. When a
 * variable is set it is strict: a missing file FAILS. Without them this looks for a sibling checkout
 * and skips visibly when there is none.
 *
 * EXPECTED RED on a phase PR into the epic branch until the compute epic reaches nemar-cli `dev`.
 */

import { describe, expect, it } from "vitest";
import {
  COMPUTE_CANCEL_OUTCOMES,
  COMPUTE_JOB_ROUTE_STATUS,
  COMPUTE_LAUNCHER_FAILURE_CODES,
  COMPUTE_LOG_MAX_BYTES,
  COMPUTE_PLATFORM_FAILURE_CODES,
  COMPUTE_RESULTS_PAGE_MAX,
  COMPUTE_SUBMITTER_FAILURE_CODES,
  COMPUTE_TRUNCATED_HEADER,
  COMPUTE_UPLOAD_EXPIRED_SENTENCE,
} from "../src/lib/compute-contract";
import {
  extractNumber,
  extractProduct,
  extractSatisfiedNumberMap,
  extractString,
  extractStringMap,
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
const SUBMIT = locate({
  envName: "NEMAR_CLI_COMPUTE_SUBMIT_CONTRACT",
  candidates: ["../../nemar-cli/shared/contract/compute-submit.ts"],
});
const RESPONSES = locate({
  envName: "NEMAR_CLI_COMPUTE_RESPONSES_CONTRACT",
  candidates: ["../../nemar-cli/shared/contract/compute-responses.ts"],
});

const SHOULD_SKIP = [STATE, SUBMIT, RESPONSES].some((s) => !s.strict && !s.path);
if (SHOULD_SKIP) {
  console.info(
    "[compute-job drift] skipped: no nemar-cli checkout found beside this one and the NEMAR_CLI_COMPUTE_* variables are unset.",
  );
}

function read(src: { path: string | undefined }): string {
  expect(
    src.path && fs.existsSync(src.path),
    `${src.path} is missing: the nemar-cli checkout step failed, or nemar-cli dev does not carry the compute epic yet`,
  ).toBe(true);
  return fs.readFileSync(src.path as string, "utf8");
}

describe.skipIf(SHOULD_SKIP)("the job page's vocabulary agrees with nemar-cli", () => {
  it("has the same launcher failure codes in the same order", () => {
    const theirs = extractStringArray(read(STATE), "LAUNCHER_FAILURE_CODES");
    expect(
      compareLists("LAUNCHER_FAILURE_CODES", COMPUTE_LAUNCHER_FAILURE_CODES, theirs),
    ).toBeNull();
  });

  it("has the same platform failure codes", () => {
    const theirs = extractStringArray(read(STATE), "PLATFORM_FAILURE_CODES");
    expect(
      compareLists("PLATFORM_FAILURE_CODES", COMPUTE_PLATFORM_FAILURE_CODES, theirs),
    ).toBeNull();
  });

  it("has the same submitter failure codes", () => {
    const theirs = extractStringArray(read(STATE), "SUBMITTER_FAILURE_CODES");
    expect(
      compareLists("SUBMITTER_FAILURE_CODES", COMPUTE_SUBMITTER_FAILURE_CODES, theirs),
    ).toBeNull();
  });

  it("has the same status for every job-route refusal", () => {
    const theirs = extractSatisfiedNumberMap(read(STATE), "COMPUTE_REFUSAL_STATUS");
    expect(theirs, "COMPUTE_REFUSAL_STATUS not found").toBeDefined();
    for (const [code, status] of Object.entries(COMPUTE_JOB_ROUTE_STATUS)) {
      expect([code, theirs?.[code]]).toEqual([code, status]);
    }
  });

  it("has the same truncated-log header and the same bounds", () => {
    const source = read(SUBMIT);
    expect(extractString(source, "COMPUTE_TRUNCATED_HEADER")).toBe(COMPUTE_TRUNCATED_HEADER);
    expect(extractProduct(source, "COMPUTE_LOG_MAX_BYTES")).toBe(COMPUTE_LOG_MAX_BYTES);
    expect(extractNumber(source, "COMPUTE_RESULTS_PAGE_MAX")).toBe(COMPUTE_RESULTS_PAGE_MAX);
  });

  it("has the same sentence for an upload that expired", () => {
    const theirs = extractStringMap(read(SUBMIT), "COMPUTE_SUBMIT_SENTENCES");
    expect(theirs, "COMPUTE_SUBMIT_SENTENCES not found").toBeDefined();
    expect(theirs?.upload_expired).toBe(COMPUTE_UPLOAD_EXPIRED_SENTENCE);
  });

  it("has the same cancel outcomes", () => {
    const theirs = extractStringArray(read(RESPONSES), "COMPUTE_CANCEL_OUTCOMES");
    expect(compareLists("COMPUTE_CANCEL_OUTCOMES", COMPUTE_CANCEL_OUTCOMES, theirs)).toBeNull();
  });
});
