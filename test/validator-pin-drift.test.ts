/**
 * Drift check between this repo's `validator-version.json` and nemar-cli's (website#161, ADR 0028).
 *
 * The pin is the release of @bids/validator that three things run: `nemar dataset validate` on a
 * person's machine, the repository check that gates publication, and now the upload page. They
 * must say the same thing about a dataset, so they must run the same release, and the two repos
 * share no package: this file is a copy of nemar-cli's, and a copy with nothing watching it is a
 * fork with a delay (see `account-copy-drift.test.ts`, which this follows).
 *
 * When nemar-cli moves the pin, which its monthly bump workflow does on its own, this fails on
 * every pull request here until the website follows: copy nemar-cli's file over
 * `validator-version.json`, then `deno run -A scripts/vendor-bids-validator.ts --relock`, then
 * commit the new `public/vendor/bids-validator/<version>/`. That is the lockstep, and the failure
 * is its prompt.
 *
 * **CI enforces it by checking nemar-cli out.** `.github/workflows/ci.yml` sparse-checks out the
 * file from nemar-cli `dev` and points `NEMAR_CLI_VALIDATOR_PIN` at it. When that variable is set
 * its path IS the pin for this run, and a missing file fails: a check that skipped there would be
 * a check that was never run. Without the variable (a maintainer's machine) this looks for a
 * sibling checkout, and an absent one is a visible skip.
 */

import { describe, expect, it } from "vitest";
import pin from "../validator-version.json";
import { nodeFs, nodeProcess } from "./node";

interface Pin {
  readonly version: string;
  readonly specifier: string;
}

/** Why two pins differ, or null if they do not. */
function describeDrift(ours: Pin, theirs: Pin): string | null {
  const differences = (["version", "specifier"] as const)
    .filter((key) => ours[key] !== theirs[key])
    .map((key) => `${key}: website "${ours[key]}", nemar-cli "${theirs[key]}"`);
  return differences.length > 0 ? differences.join("; ") : null;
}

describe("describeDrift", () => {
  const ours = { version: "3.0.2", specifier: "jsr:@bids/validator" };

  it("says nothing about two pins that agree", () => {
    expect(describeDrift(ours, { ...ours })).toBeNull();
  });

  it("names the version when only the version differs", () => {
    expect(describeDrift(ours, { ...ours, version: "3.1.0" })).toBe(
      'version: website "3.0.2", nemar-cli "3.1.0"',
    );
  });

  it("names both when both differ", () => {
    const message = describeDrift(ours, { version: "2.4.1", specifier: "npm:@bids/validator" });
    expect(message).toContain('version: website "3.0.2", nemar-cli "2.4.1"');
    expect(message).toContain(
      'specifier: website "jsr:@bids/validator", nemar-cli "npm:@bids/validator"',
    );
  });
});

/** Where a nemar-cli checkout is expected, relative to `test/`, when the variable is unset. */
const PIN_CANDIDATES = ["../../nemar-cli/validator-version.json"];

const fs = await nodeFs();
const proc = await nodeProcess();

const fromEnv = proc.env.NEMAR_CLI_VALIDATOR_PIN;
const STRICT_PATH = fromEnv
  ? fromEnv.startsWith("/")
    ? fromEnv
    : `${proc.cwd()}/${fromEnv}`
  : undefined;
const FOUND = STRICT_PATH
  ? undefined
  : PIN_CANDIDATES.map((relative) =>
      decodeURIComponent(new URL(relative, import.meta.url).pathname),
    ).find((path) => fs.existsSync(path));
const PIN_PATH = STRICT_PATH ?? FOUND;
const SHOULD_SKIP = !STRICT_PATH && !FOUND;

if (SHOULD_SKIP) {
  console.info(
    `[validator pin drift] skipped: no nemar-cli checkout at ${PIN_CANDIDATES.join(", ")} (relative to test/), and NEMAR_CLI_VALIDATOR_PIN is unset.`,
  );
}

describe.skipIf(SHOULD_SKIP)("website pin vs the nemar-cli pin", () => {
  it("names the same release", () => {
    if (STRICT_PATH && !fs.existsSync(STRICT_PATH)) {
      throw new Error(
        `[validator pin drift] NEMAR_CLI_VALIDATOR_PIN=${fromEnv} resolved to ${STRICT_PATH}, which does not exist. This test enforces the pin when the variable is set; it does not skip on a missing file. Check the sparse-checkout step in .github/workflows/ci.yml.`,
      );
    }
    const path = PIN_PATH as string;
    const theirs = JSON.parse(fs.readFileSync(path, "utf8")) as Pin;
    expect(
      describeDrift(pin, theirs),
      [
        `validator-version.json drifted from ${path}.`,
        "nemar-cli is the source of truth: copy its file here, then run",
        "`deno run -A scripts/vendor-bids-validator.ts --relock` and commit the result.",
        "If this is a sibling checkout, make sure it is up to date with origin/dev first.",
      ].join(" "),
    ).toBeNull();
  });
});

describe("the CI job that enforces it", () => {
  it("checks the pin out of nemar-cli and makes the test strict about it", () => {
    const ci = fs.readFileSync(
      decodeURIComponent(new URL("../.github/workflows/ci.yml", import.meta.url).pathname),
      "utf8",
    );
    expect(ci).toContain("/validator-version.json");
    expect(ci).toContain("NEMAR_CLI_VALIDATOR_PIN: nemar-cli-contract/validator-version.json");
  });
});
