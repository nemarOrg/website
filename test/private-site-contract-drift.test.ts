/**
 * Drift check between this repo's half of the private-site sign-in handoff and nemar-cli's
 * `shared/contract/private-site.ts`.
 *
 * The handoff has three parties that share no package: this site's authorize page, the backend,
 * and the private site's own Worker. Each spells the shared literals itself, and the contract file
 * is written to be read as text by the other two. A renamed query parameter or callback path on
 * either side breaks every sign-in to `private.nemar.org` while each side's own tests stay green.
 *
 * Shaped exactly like `docs-auth-contract-drift.test.ts`, including the strict/soft split and the
 * CI sparse checkout of nemar-cli `dev` (nemar-cli ADR 0046), and reusing its extractor from
 * `docs-contract-drift.ts`, whose own behavior that test already covers.
 *
 * WHAT IS COMPARED. Only the literals this page uses: the authorize path, the `state` parameter
 * name and the callback path. The authorize path is checked twice, as the constant the middleware
 * keys `Referrer-Policy` on and as the page FILE the contract points at, because a rename that
 * moved one without the other would either break the first hop or silently drop the no-referrer
 * header. The grant and session lifetimes are the backend's and the private site's business; this
 * page never reads them, so it does not mirror them.
 */

import { describe, expect, it } from "vitest";
import {
  PRIVATE_AUTHORIZE_PAGE_PATH,
  PRIVATE_AUTHORIZE_STATE_PARAM,
  PRIVATE_CALLBACK_PATH,
} from "../src/lib/private-authorize";
import { compareConstants, extractConstants, formatDifference } from "./docs-contract-drift";

/** `node:fs` reached without a static import: this project has no `@types/node`, so `astro check`
 *  rejects a bare one in CI while vitest resolves it locally. Same escape hatch, same reason, as
 *  `docs-auth-contract-drift.test.ts`. */
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
 *  `NEMAR_CLI_PRIVATE_SITE_CONTRACT` is unset. */
const CONTRACT_CANDIDATES = ["../../nemar-cli/shared/contract/private-site.ts"];

/** This repo's mirrored values, keyed by the contract's own names. */
const OURS = new Map<string, string | number>([
  ["PRIVATE_AUTHORIZE_PATH", PRIVATE_AUTHORIZE_PAGE_PATH],
  ["PRIVATE_AUTHORIZE_STATE_PARAM", PRIVATE_AUTHORIZE_STATE_PARAM],
  ["PRIVATE_CALLBACK_PATH", PRIVATE_CALLBACK_PATH],
]);

const fs = await nodeFs();
const proc = await nodeProcess();

const ENV_PATH = proc.env.NEMAR_CLI_PRIVATE_SITE_CONTRACT;
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
    `[private-site drift] skipped: no nemar-cli contract found at any of ${CONTRACT_CANDIDATES.join(", ")} (relative to test/), and NEMAR_CLI_PRIVATE_SITE_CONTRACT is unset.`,
  );
}

describe.skipIf(SHOULD_SKIP)("against nemar-cli's private-site contract", () => {
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
    // The private site sends a visitor to this path on the app host; a rename on either side
    // breaks the handoff at its first hop.
    const source = fs.readFileSync(CONTRACT_PATH as string, "utf8");
    const authorizePath = extractConstants(source).get("PRIVATE_AUTHORIZE_PATH");
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
