/**
 * Drift check between `src/lib/quality-views/route-contract.ts` and nemar-cli's
 * `shared/contract/quality-route.ts` (nemar-cli ADR 0137 decisions 6 and 7, epic #2324 phase B2;
 * website phase W6, #588).
 *
 * The contract is imported as a module, not read as text: every constant is compared by value,
 * the word table entry for entry and in order, and each function by its answers on the same
 * inputs (paths with spaces, non-ASCII and reserved characters, and the recording-path rule over
 * traversal, schemes, controls and bidirectional code points). Its imports
 * (`../compute-naming.js`, `./compute-stamp.js`) are on the CI sparse checkout beside it.
 *
 * Strict like the other drift tests: when `NEMAR_CLI_QUALITY_ROUTE` names the file a missing one
 * FAILS; without it a sibling checkout is searched and an absent one is a visible skip.
 *
 * EXPECTED RED on the phase PR into the website epic branch until nemar-cli `dev` carries the
 * route (nemar-cli epic #2324). The dependency is one-directional: nemar-cli `dev` merges first.
 */

import { describe, expect, it } from "vitest";
import * as ours from "../src/lib/quality-views/route-contract";
import { nodeFs, nodeProcess } from "./node";

const fs = await nodeFs();
const proc = await nodeProcess();

const ENV_PATH = proc.env.NEMAR_CLI_QUALITY_ROUTE;
const STRICT = ENV_PATH
  ? ENV_PATH.startsWith("/")
    ? ENV_PATH
    : `${proc.cwd()}/${ENV_PATH}`
  : null;
const CANDIDATE = decodeURIComponent(
  new URL("../../nemar-cli/shared/contract/quality-route.ts", import.meta.url).pathname,
);
const PATH = STRICT ?? CANDIDATE;
const PRESENT = fs.existsSync(PATH);
const SKIP = !STRICT && !PRESENT;
if (SKIP) {
  console.info(
    `[quality-route drift] skipped: no nemar-cli quality-route.ts at ${CANDIDATE}, and NEMAR_CLI_QUALITY_ROUTE is unset.`,
  );
}

/** Recording paths both rules must answer alike. */
const PATHS = [
  "sub-01/eeg/sub-01_task-rest_eeg.edf",
  "sub-01/ses-1/eeg/sub-01_ses-1_task-rest_run-2_eeg.set",
  "sub-01/eeg/sub-01 task_eeg.bdf",
  "sub-01/eeg/sub-01_tâche_eeg.edf",
  "sub-01/meg/sub-01_task-rest_meg.fif",
  "sub-01/eeg/sub-01_task-rest_eeg",
  "/sub-01/eeg/sub-01_eeg.edf",
  "../sub-01/eeg/sub-01_eeg.edf",
  "sub-01/./eeg/sub-01_eeg.edf",
  "sub-01//eeg/sub-01_eeg.edf",
  "sub-01/eeg/",
  "https://x/sub-01_eeg.edf",
  "sub-01/eeg/sub-01_eeg.edf ",
  " sub-01/eeg/sub-01_eeg.edf",
  "sub-01/eeg/sub-01%2F_eeg.edf",
  "sub-01/eeg/sub-01?_eeg.edf",
  "sub-01/eeg/sub-01#_eeg.edf",
  "sub-01\\eeg\\sub-01_eeg.edf",
  "sub-01/eeg/sub-01‮_eeg.edf",
  "sub-01/eeg/sub-01\u0085_eeg.edf",
  "sub-01/eeg/sub-01_eeg.edf\n",
  `${"a/".repeat(511)}x_eeg.edf`,
  `${"a/".repeat(512)}x_eeg.edf`,
  "",
];

describe.skipIf(SKIP)("against nemar-cli's quality route contract", () => {
  it("finds the contract file", () => {
    expect(PRESENT, PATH).toBe(true);
  });

  it("holds every constant, the words in order, and the functions' answers", async () => {
    const theirs = await import(/* @vite-ignore */ PATH);
    for (const name of [
      "QUALITY_ROUTE_SEGMENT",
      "QUALITY_ROUTE_VERSION",
      "QUALITY_RECORD_SEGMENT",
      "QUALITY_FILE_SEGMENT",
      "QUALITY_RECORD_FORMAT",
      "QUALITY_RECORD_MAX_BYTES",
      "QUALITY_FILE_MAX_BYTES",
      "QUALITY_RECORDING_PATH_MAX",
      "QUALITY_PUBLIC_MAX_AGE",
      "QUALITY_RELATIVE_LOCATION_SOURCE",
    ] as const) {
      expect(ours[name], name).toBe(theirs[name]);
    }
    expect(Object.entries(ours.QUALITY_ROUTE_WORDS)).toEqual(
      Object.entries(theirs.QUALITY_ROUTE_WORDS),
    );
    for (const path of PATHS) {
      expect(ours.isQualityRecordingPath(path), JSON.stringify(path)).toBe(
        theirs.isQualityRecordingPath(path),
      );
    }
    const key = "a".repeat(64);
    const sha = "0123456789abcdef".repeat(4);
    for (const recording of PATHS.slice(0, 4)) {
      expect(ours.qualityRecordPath("nm000001", "nemar-ica", recording)).toBe(
        theirs.qualityRecordPath("nm000001", "nemar-ica", recording),
      );
      expect(ours.qualityFilePath("nm000001", "nemar-ica", key, sha, recording)).toBe(
        theirs.qualityFilePath("nm000001", "nemar-ica", key, sha, recording),
      );
    }
    // The answers' caching, as the route states it in its words: public answers last 300 seconds.
    expect(theirs.qualityCacheTag("nm000001")).toBe("nemar-dq-nm000001");
  });
});
