/**
 * Drift check between this repo's copy of the mail category table and nemar-cli's
 * `shared/contract/mail-categories.ts` (epic nemarOrg/nemar-cli#2260, nemar-cli ADR 0132).
 *
 * Shaped like `mail-admin-contract-drift.test.ts`, including the strict/soft split and the CI
 * sparse checkout of nemar-cli `dev` (nemar-cli ADR 0046): `NEMAR_CLI_MAIL_CATEGORIES` set means
 * strict (a missing file fails), unset means look for a sibling checkout and skip visibly when there
 * is none. It compares what the Settings card and the unsubscribe page branch on: the switchable
 * categories and their order, the recall id, `canBeTurnedOff` and `defaultOn` per category, and the
 * refusal codes whose `message` the card shows.
 *
 * Until the nemar-cli epic reaches `dev`, CI's checkout has no such file and the strict run is
 * red on purpose: that is this PR's merge gate.
 */

import { describe, expect, it } from "vitest";
import {
  COMMUNITY_MAIL_CATEGORIES,
  MAIL_CATEGORIES,
  MAIL_CATEGORY_TABLE,
  RECALL_CATEGORY,
  SELF_MAIL_PREFERENCE_ERROR_CODES,
} from "../src/lib/mail-categories";
import {
  compareLists,
  extractAnnotatedStringArray,
  extractCategoryTable,
  extractStringArray,
  extractStringConstant,
} from "./mail-contract-drift";

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
 *  `NEMAR_CLI_MAIL_CATEGORIES` is unset. */
const CONTRACT_CANDIDATES = [
  "../../nemar-cli-worktrees/epic-mail-categories/shared/contract/mail-categories.ts",
  "../../nemar-cli/shared/contract/mail-categories.ts",
];

const fs = await nodeFs();
const proc = await nodeProcess();

const ENV_PATH = proc.env.NEMAR_CLI_MAIL_CATEGORIES;
const STRICT_CONTRACT_PATH = ENV_PATH ? resolveFromCwd(ENV_PATH, proc.cwd()) : undefined;
const FOUND_CANDIDATE = STRICT_CONTRACT_PATH
  ? undefined
  : CONTRACT_CANDIDATES.map((rel) => pathFromUrl(new URL(rel, import.meta.url))).find((path) =>
      fs.existsSync(path),
    );
const CONTRACT_PATH = STRICT_CONTRACT_PATH ?? FOUND_CANDIDATE;
const CONTRACT_EXISTS = CONTRACT_PATH !== undefined && fs.existsSync(CONTRACT_PATH);

// Strict mode never skips: a missing file when the env var is set means the CI checkout step
// failed, or the contract has not reached nemar-cli `dev` yet, and either has to be loud.
const SHOULD_SKIP = !STRICT_CONTRACT_PATH && !CONTRACT_EXISTS;

if (SHOULD_SKIP) {
  console.info(
    `[mail-categories drift] skipped: no nemar-cli contract found at any of ${CONTRACT_CANDIDATES.join(", ")} (relative to test/), and NEMAR_CLI_MAIL_CATEGORIES is unset.`,
  );
}

describe.skipIf(SHOULD_SKIP)("against nemar-cli's mail category table", () => {
  const source = (): string => fs.readFileSync(CONTRACT_PATH as string, "utf8");

  it("finds the contract file", () => {
    expect(CONTRACT_PATH).toBeDefined();
    expect(CONTRACT_EXISTS).toBe(true);
  });

  it("lists the same switchable categories, in the same order", () => {
    expect(
      compareLists(
        "COMMUNITY_MAIL_CATEGORIES",
        COMMUNITY_MAIL_CATEGORIES,
        extractStringArray(source(), "COMMUNITY_MAIL_CATEGORIES"),
      ),
    ).toBeNull();
  });

  it("names the same recall category", () => {
    expect(extractStringConstant(source(), "RECALL_CATEGORY")).toBe(RECALL_CATEGORY);
  });

  it("declares the same categories with the same switches, in the same order", () => {
    const ours = MAIL_CATEGORIES.map((id) => ({
      id,
      canBeTurnedOff: MAIL_CATEGORY_TABLE[id].canBeTurnedOff,
      defaultOn: MAIL_CATEGORY_TABLE[id].defaultOn,
    }));
    expect(extractCategoryTable(source(), "MAIL_CATEGORY_TABLE")).toEqual(ours);
  });

  it("declares the same self-service refusal codes", () => {
    expect(
      compareLists(
        "SELF_MAIL_PREFERENCE_ERROR_CODES",
        SELF_MAIL_PREFERENCE_ERROR_CODES,
        extractAnnotatedStringArray(source(), "SELF_MAIL_PREFERENCE_ERROR_CODES"),
      ),
    ).toBeNull();
  });
});
