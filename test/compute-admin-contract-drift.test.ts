/**
 * Drift check between `src/lib/compute-admin-contract.ts` and nemar-cli's compute contracts
 * (website ADR 0030; epic nemarOrg/website#493 phase E4, issue #497).
 *
 * Shaped like `mail-admin-contract-drift.test.ts`, including the strict/soft split: when
 * `NEMAR_CLI_COMPUTE_ADMIN_CONTRACT` names `shared/contract/compute-admin.ts` the run is strict and
 * a missing file FAILS (CI sparse-checks out nemar-cli `dev`); without it a sibling checkout is
 * searched and an absent one is a visible skip. The other three files are read from beside it
 * (`../compute-state.ts`, `../compute-access-state.ts`, `./compute-access.ts`).
 *
 * EXPECTED RED on a phase PR into the epic branch until nemar-cli `dev` carries the compute
 * contracts (the compute epic merges there). Never put this on `staging` before then.
 */

import { describe, expect, it } from "vitest";
import {
  COMPUTE_ACCESS_ADMIN_ERROR_CODES,
  COMPUTE_ACCESS_DECISIONS,
  COMPUTE_ACCESS_LISTED_STATES,
  COMPUTE_ACCESS_PAGE_MAX,
  COMPUTE_ACCESS_REASON_MAX_CHARS,
  COMPUTE_ACCESS_TRANSITIONS,
  COMPUTE_DECISION_TARGET,
  COMPUTE_JOB_FLAGS,
  COMPUTE_POOLS_PAGE_MAX,
  COMPUTE_POOL_HOLDER_KINDS,
  COMPUTE_REPORT_PAGE_MAX,
} from "../src/lib/compute-admin-contract";
import { extractTargets, extractTransitions } from "./compute-contract-drift";
import { compareConstants, extractConstants, formatDifference } from "./docs-contract-drift";
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

function pathFromUrl(url: URL): string {
  return decodeURIComponent(url.pathname);
}

function resolveFromCwd(maybeRelative: string, cwd: string): string {
  return maybeRelative.startsWith("/") ? maybeRelative : `${cwd}/${maybeRelative}`;
}

describe("the extractors read inline sources", () => {
  it("lifts a transitions record and a target record, ignoring comments", () => {
    const source = `
      // none: ["wrong"],
      export const T: Readonly<Record<S, readonly S[]>> = {
        none: ["requested"],
        active: ["suspended", "revoked"], // trailing
      };
      export const D: Readonly<Record<X, S>> =
        {
          grant: "active",
          deny: "denied",
        };`;
    expect(extractTransitions(source, "T")).toEqual({
      none: ["requested"],
      active: ["suspended", "revoked"],
    });
    expect(extractTargets(source, "D")).toEqual({ grant: "active", deny: "denied" });
  });

  it("reports a list or a record it cannot find as absent, never empty", () => {
    expect(extractTransitions("export const Z = 1;", "T")).toBeUndefined();
    expect(extractTargets("export const Z = 1;", "D")).toBeUndefined();
    expect(extractStringArray("export const Z = 1;", "L")).toBeUndefined();
  });
});

const fs = await nodeFs();
const proc = await nodeProcess();

const ENV_PATH = proc.env.NEMAR_CLI_COMPUTE_ADMIN_CONTRACT;
const STRICT_CONTRACT_PATH = ENV_PATH ? resolveFromCwd(ENV_PATH, proc.cwd()) : undefined;
const CONTRACT_CANDIDATES = [
  "../../../nemar-cli-worktrees/docs-gen-epicD/shared/contract/compute-admin.ts",
  "../../nemar-cli-worktrees/docs-gen-epicD/shared/contract/compute-admin.ts",
  "../../nemar-cli/shared/contract/compute-admin.ts",
];
const FOUND_CANDIDATE = STRICT_CONTRACT_PATH
  ? undefined
  : CONTRACT_CANDIDATES.map((rel) => pathFromUrl(new URL(rel, import.meta.url))).find((path) =>
      fs.existsSync(path),
    );
const CONTRACT_PATH = STRICT_CONTRACT_PATH ?? FOUND_CANDIDATE;
const CONTRACT_EXISTS = CONTRACT_PATH !== undefined && fs.existsSync(CONTRACT_PATH);
const SHOULD_SKIP = !STRICT_CONTRACT_PATH && !CONTRACT_EXISTS;

if (SHOULD_SKIP) {
  console.info(
    `[compute-admin drift] skipped: no nemar-cli contract found at any of ${CONTRACT_CANDIDATES.join(", ")} (relative to test/), and NEMAR_CLI_COMPUTE_ADMIN_CONTRACT is unset.`,
  );
}

function sibling(relative: string): string {
  const dir = (CONTRACT_PATH as string).replace(/\/[^/]*$/, "");
  return `${dir}/${relative}`;
}

function read(path: string): string {
  if (!fs.existsSync(path)) {
    throw new Error(
      `[compute-admin drift] ${path} does not exist. In CI this is the sparse-checkout step; the compute contracts reach nemar-cli dev with the compute epic.`,
    );
  }
  return fs.readFileSync(path, "utf8");
}

describe.skipIf(SHOULD_SKIP)("against nemar-cli's compute contracts", () => {
  it("finds the contract file", () => {
    expect(CONTRACT_PATH).toBeDefined();
    expect(CONTRACT_EXISTS).toBe(true);
  });

  it("declares the same closed lists, in the same order", () => {
    const admin = read(CONTRACT_PATH as string);
    const access = read(sibling("compute-access.ts"));
    const state = read(sibling("../compute-state.ts"));
    const accessState = read(sibling("../compute-access-state.ts"));
    const lists: ReadonlyArray<[string, readonly string[], string[] | undefined]> = [
      [
        "COMPUTE_ACCESS_DECISIONS",
        COMPUTE_ACCESS_DECISIONS,
        extractStringArray(accessState, "COMPUTE_ACCESS_DECISIONS"),
      ],
      [
        "COMPUTE_ACCESS_ADMIN_ERROR_CODES",
        COMPUTE_ACCESS_ADMIN_ERROR_CODES,
        extractStringArray(access, "COMPUTE_ACCESS_ADMIN_ERROR_CODES"),
      ],
      [
        "COMPUTE_POOL_HOLDER_KINDS",
        COMPUTE_POOL_HOLDER_KINDS,
        extractStringArray(admin, "COMPUTE_POOL_HOLDER_KINDS"),
      ],
      ["COMPUTE_JOB_FLAGS", COMPUTE_JOB_FLAGS, extractStringArray(state, "COMPUTE_JOB_FLAGS")],
    ];
    const differences = lists
      .map(([name, ours, theirs]) => compareLists(name, ours, theirs))
      .filter((d): d is string => d !== null);
    expect(differences).toEqual([]);
  });

  it("lists the states an administrator can filter by: every state but none", () => {
    const accessState = read(sibling("../compute-access-state.ts"));
    const all = extractStringArray(accessState, "COMPUTE_ACCESS_STATES");
    expect(all).toBeDefined();
    expect([...COMPUTE_ACCESS_LISTED_STATES]).toEqual((all ?? []).filter((s) => s !== "none"));
  });

  it("declares the same edges and the same decision targets", () => {
    const accessState = read(sibling("../compute-access-state.ts"));
    expect(extractTransitions(accessState, "COMPUTE_ACCESS_TRANSITIONS")).toEqual(
      Object.fromEntries(Object.entries(COMPUTE_ACCESS_TRANSITIONS).map(([k, v]) => [k, [...v]])),
    );
    expect(extractTargets(accessState, "COMPUTE_DECISION_TARGET")).toEqual({
      ...COMPUTE_DECISION_TARGET,
    });
  });

  it("declares the same bounds", () => {
    const merged = new Map([
      ...extractConstants(read(sibling("compute-access.ts"))),
      ...extractConstants(read(CONTRACT_PATH as string)),
    ]);
    const ours = new Map<string, number>([
      ["COMPUTE_ACCESS_REASON_MAX_CHARS", COMPUTE_ACCESS_REASON_MAX_CHARS],
      ["COMPUTE_ACCESS_PAGE_MAX", COMPUTE_ACCESS_PAGE_MAX],
      ["COMPUTE_POOLS_PAGE_MAX", COMPUTE_POOLS_PAGE_MAX],
      ["COMPUTE_REPORT_PAGE_MAX", COMPUTE_REPORT_PAGE_MAX],
    ]);
    const result = compareConstants(ours, merged);
    expect(result.changed.map(formatDifference)).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});
