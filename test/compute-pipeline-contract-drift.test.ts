/**
 * Drift check between `src/lib/compute-pipeline-contract.ts` and nemar-cli's pipeline grid contract
 * (nemar-cli ADR 0134 decision 5; epic nemarOrg/nemar-cli#2324 phase 4b, website#586).
 *
 * The THIRTEENTH drift test on the CI sparse checkout. Strict like the admin Compute tab's: when
 * `NEMAR_CLI_COMPUTE_ADMIN_CONTRACT` names `shared/contract/compute-admin.ts` a missing file FAILS;
 * without it a sibling checkout is searched and an absent one is a visible skip. The other files
 * are read from beside it: `../compute-recipes.ts`, `./compute-runner.ts`, `./compute.ts` and
 * `./compute-progress.ts`.
 *
 * EXPECTED RED on the phase PR into the website epic branch until nemar-cli `dev` carries the
 * grid contract (nemar-cli epic #2324). The dependency is ONE-DIRECTIONAL: nemar-cli reads nothing
 * this phase adds, so nemar-cli `dev` merges first and website `staging` second (website ADR 0030,
 * addendum of 2026-11-23).
 */

import { describe, expect, it } from "vitest";
import {
  COMPUTE_DATASET_ID_RE,
  COMPUTE_PIPELINE_CELL_MARKS,
  COMPUTE_PIPELINE_GRID_PAGE_DEFAULT,
  COMPUTE_PIPELINE_GRID_PAGE_MAX,
  COMPUTE_PIPELINE_GRID_STATUSES,
  COMPUTE_PIPELINE_RECIPE_VERSION_RE,
  COMPUTE_PIPELINE_RUN_OUTCOMES,
  COMPUTE_PIPELINE_STAMP_ID_RE,
  COMPUTE_PIPELINE_TREND_DAYS_DEFAULT,
  COMPUTE_PIPELINE_TREND_DAYS_MAX,
  PIPELINE_STAMP_NOT_FOUND,
  PROGRESS_MAX_FAILURES,
  RUNNER_ID_RE,
  STANDARD_CHECKPOINTS,
  STORED_CHECKPOINT,
} from "../src/lib/compute-pipeline-contract";
import { extractSatisfiedNumberMap } from "./compute-contract-drift";
import { compareConstants, extractConstants, formatDifference } from "./docs-contract-drift";
import { compareLists, extractRegexLiteral, extractStringArray } from "./mail-contract-drift";

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

describe("the extractors read inline sources", () => {
  it("lift a list, a number, a string and a pattern, and report a computed value as absent", () => {
    const source = `
      // export const L = ["wrong"] as const;
      export const L = [
        "a", // one
        "b",
      ] as const;
      export const N = 500;
      export const S = "stored";
      export const R = /^[1-9][0-9]{0,15}$/;
      export const C = 2 * 250;`;
    expect(extractStringArray(source, "L")).toEqual(["a", "b"]);
    const constants = extractConstants(source);
    expect(constants.get("N")).toBe(500);
    expect(constants.get("S")).toBe("stored");
    expect(constants.has("C")).toBe(false);
    expect(extractRegexLiteral(source, "R")).toEqual({ source: "^[1-9][0-9]{0,15}$", flags: "" });
    expect(extractStringArray(source, "Z")).toBeUndefined();
  });
});

const fs = await nodeFs();
const proc = await nodeProcess();

const ENV_PATH = proc.env.NEMAR_CLI_COMPUTE_ADMIN_CONTRACT;
const STRICT_CONTRACT_PATH = ENV_PATH ? resolveFromCwd(ENV_PATH, proc.cwd()) : undefined;
const CONTRACT_CANDIDATES = ["../../nemar-cli/shared/contract/compute-admin.ts"];
const FOUND_CANDIDATE = STRICT_CONTRACT_PATH
  ? undefined
  : CONTRACT_CANDIDATES.map((rel) => pathFromUrl(new URL(rel, import.meta.url))).find((path) =>
      fs.existsSync(path),
    );
const CONTRACT_PATH = STRICT_CONTRACT_PATH ?? FOUND_CANDIDATE;
const CONTRACT_EXISTS = CONTRACT_PATH !== undefined && fs.existsSync(CONTRACT_PATH);
// A sibling checkout on a branch without the grid contract is not this contract: skip it visibly
// rather than call it drift. In strict mode (CI) it fails instead.
const CARRIES_GRID =
  CONTRACT_EXISTS &&
  (fs.readFileSync(CONTRACT_PATH as string, "utf8") as string).includes(
    "COMPUTE_PIPELINE_GRID_STATUSES",
  );
const SHOULD_SKIP = !STRICT_CONTRACT_PATH && !CARRIES_GRID;

if (SHOULD_SKIP) {
  console.info(
    `[compute-pipeline drift] skipped: no nemar-cli contract carrying the pipeline grid at ${CONTRACT_CANDIDATES.join(", ")} (relative to test/), and NEMAR_CLI_COMPUTE_ADMIN_CONTRACT is unset.`,
  );
}

function sibling(relative: string): string {
  const dir = (CONTRACT_PATH as string).replace(/\/[^/]*$/, "");
  return `${dir}/${relative}`;
}

function read(path: string): string {
  if (!fs.existsSync(path)) {
    throw new Error(
      `[compute-pipeline drift] ${path} does not exist. In CI this is the sparse-checkout step; the grid contract reaches nemar-cli dev with epic #2324.`,
    );
  }
  return fs.readFileSync(path, "utf8");
}

describe.skipIf(SHOULD_SKIP)("against nemar-cli's pipeline grid contract", () => {
  it("finds the contract file", () => {
    expect(CONTRACT_PATH).toBeDefined();
    expect(CONTRACT_EXISTS).toBe(true);
  });

  it("declares the same words, in the same order", () => {
    const admin = read(CONTRACT_PATH as string);
    const recipes = read(sibling("../compute-recipes.ts"));
    const lists: ReadonlyArray<[string, readonly string[], string[] | undefined]> = [
      [
        "COMPUTE_PIPELINE_GRID_STATUSES",
        COMPUTE_PIPELINE_GRID_STATUSES,
        extractStringArray(admin, "COMPUTE_PIPELINE_GRID_STATUSES"),
      ],
      [
        "COMPUTE_PIPELINE_CELL_MARKS",
        COMPUTE_PIPELINE_CELL_MARKS,
        extractStringArray(admin, "COMPUTE_PIPELINE_CELL_MARKS"),
      ],
      [
        "COMPUTE_PIPELINE_RUN_OUTCOMES",
        COMPUTE_PIPELINE_RUN_OUTCOMES,
        extractStringArray(admin, "COMPUTE_PIPELINE_RUN_OUTCOMES"),
      ],
      [
        "STANDARD_CHECKPOINTS",
        STANDARD_CHECKPOINTS,
        extractStringArray(recipes, "STANDARD_CHECKPOINTS"),
      ],
    ];
    const differences = lists
      .map(([name, ours, theirs]) => compareLists(name, ours, theirs))
      .filter((d): d is string => d !== null);
    expect(differences).toEqual([]);
  });

  it("declares the same bounds and the same stored checkpoint", () => {
    const merged = new Map([
      ...extractConstants(read(sibling("../compute-recipes.ts"))),
      ...extractConstants(read(sibling("compute-progress.ts"))),
      ...extractConstants(read(CONTRACT_PATH as string)),
    ]);
    const ours = new Map<string, string | number>([
      ["COMPUTE_PIPELINE_GRID_PAGE_DEFAULT", COMPUTE_PIPELINE_GRID_PAGE_DEFAULT],
      ["COMPUTE_PIPELINE_GRID_PAGE_MAX", COMPUTE_PIPELINE_GRID_PAGE_MAX],
      ["COMPUTE_PIPELINE_TREND_DAYS_DEFAULT", COMPUTE_PIPELINE_TREND_DAYS_DEFAULT],
      ["COMPUTE_PIPELINE_TREND_DAYS_MAX", COMPUTE_PIPELINE_TREND_DAYS_MAX],
      ["PROGRESS_MAX_FAILURES", PROGRESS_MAX_FAILURES],
      ["STORED_CHECKPOINT", STORED_CHECKPOINT],
    ]);
    const result = compareConstants(ours, merged);
    expect(result.changed.map(formatDifference)).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("declares the same patterns", () => {
    const admin = read(CONTRACT_PATH as string);
    const patterns: ReadonlyArray<[string, RegExp, string]> = [
      ["COMPUTE_PIPELINE_STAMP_ID_RE", COMPUTE_PIPELINE_STAMP_ID_RE, admin],
      ["COMPUTE_PIPELINE_RECIPE_VERSION_RE", COMPUTE_PIPELINE_RECIPE_VERSION_RE, admin],
      ["RUNNER_ID_RE", RUNNER_ID_RE, read(sibling("compute-runner.ts"))],
      ["COMPUTE_DATASET_ID_RE", COMPUTE_DATASET_ID_RE, read(sibling("compute.ts"))],
    ];
    for (const [name, ours, source] of patterns) {
      expect(extractRegexLiteral(source, name), name).toEqual({
        source: ours.source,
        flags: ours.flags,
      });
    }
  });

  it("refuses an unknown stamp with stamp_not_found, a 404", () => {
    const admin = read(CONTRACT_PATH as string);
    expect(extractStringArray(admin, "COMPUTE_ADMIN_ERROR_CODES")).toContain(
      PIPELINE_STAMP_NOT_FOUND,
    );
    expect(
      extractSatisfiedNumberMap(admin, "COMPUTE_ADMIN_ERROR_STATUS")?.[PIPELINE_STAMP_NOT_FOUND],
    ).toBe(404);
  });
});
