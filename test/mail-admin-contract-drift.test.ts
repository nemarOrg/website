/**
 * Drift check between this repo's copy of the mail-admin contract and nemar-cli's
 * `shared/contract/mail-admin.ts` (epic nemarOrg/nemar-cli#1893).
 *
 * Shaped like `private-site-contract-drift.test.ts`, including the strict/soft split and the CI
 * sparse checkout of nemar-cli `dev` (nemar-cli ADR 0046). It compares the four closed lists the
 * UI branches on: ticket statuses, settable statuses, queue strategies and error codes. A
 * status the site does not know would render as nothing, and an error code it has no wording for
 * would fall back to the server's sentence, so both are caught here rather than by an admin.
 *
 * Until the nemar-cli epic reaches `dev`, CI's checkout has no such file and the strict run is
 * red on purpose: that is this PR's merge gate.
 */

import { describe, expect, it } from "vitest";
import {
  MAIL_ERROR_CODES,
  QUEUE_STRATEGIES,
  SETTABLE_STATUSES,
  TICKET_STATUSES,
} from "../src/lib/mail-admin-contract";
import { compareLists, extractStringArray, extractStringUnion } from "./mail-contract-drift";

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
 *  `NEMAR_CLI_MAIL_ADMIN_CONTRACT` is unset. */
const CONTRACT_CANDIDATES = [
  "../../nemar-cli-worktrees/epic-email-cf/shared/contract/mail-admin.ts",
  "../../nemar-cli/shared/contract/mail-admin.ts",
];

const fs = await nodeFs();
const proc = await nodeProcess();

const ENV_PATH = proc.env.NEMAR_CLI_MAIL_ADMIN_CONTRACT;
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
    `[mail-admin drift] skipped: no nemar-cli contract found at any of ${CONTRACT_CANDIDATES.join(", ")} (relative to test/), and NEMAR_CLI_MAIL_ADMIN_CONTRACT is unset.`,
  );
}

/** The four lists, as this repo spells them, with how the contract declares each. */
const LISTS: ReadonlyArray<{
  name: string;
  ours: readonly string[];
  read: (source: string) => string[] | undefined;
}> = [
  {
    name: "TICKET_STATUSES",
    ours: TICKET_STATUSES,
    read: (s) => extractStringArray(s, "TICKET_STATUSES"),
  },
  {
    name: "SETTABLE_STATUSES",
    ours: SETTABLE_STATUSES,
    read: (s) => extractStringArray(s, "SETTABLE_STATUSES"),
  },
  {
    name: "QUEUE_STRATEGIES",
    ours: QUEUE_STRATEGIES,
    read: (s) => extractStringArray(s, "QUEUE_STRATEGIES"),
  },
  {
    name: "MAIL_ERROR_CODES",
    ours: MAIL_ERROR_CODES,
    read: (s) =>
      extractStringUnion(s, "MailErrorCode") ?? extractStringArray(s, "MAIL_ERROR_CODES"),
  },
];

describe.skipIf(SHOULD_SKIP)("against nemar-cli's mail-admin contract", () => {
  it("finds the contract file", () => {
    expect(CONTRACT_PATH).toBeDefined();
    expect(CONTRACT_EXISTS).toBe(true);
  });

  it("declares the same four closed lists, in the same order", () => {
    const source = fs.readFileSync(CONTRACT_PATH as string, "utf8");
    const differences = LISTS.map((l) => compareLists(l.name, l.ours, l.read(source))).filter(
      (d): d is string => d !== null,
    );
    expect(differences).toEqual([]);
  });
});
