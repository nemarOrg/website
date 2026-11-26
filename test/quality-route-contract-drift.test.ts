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
 * Widened in phase W9 to the admin mount (`src/lib/quality-views/admin-route-contract.ts`): its
 * constants, words, the segment pattern, the stamp pattern (`./compute-stamp.ts`), the path
 * builders and the grammar, answer for answer on nemar-cli #2390's cases, and the text of the
 * proxy's obligations, item for item, so an obligation nemar-cli adds turns this red.
 *
 * EXPECTED RED on the phase PR into the website epic branch until nemar-cli `dev` carries the
 * route (nemar-cli epic #2324). The dependency is one-directional: nemar-cli `dev` merges first.
 */

import { describe, expect, it } from "vitest";
import * as admin from "../src/lib/quality-views/admin-route-contract";
import ADMIN_SOURCE from "../src/lib/quality-views/admin-route-contract.ts?raw";
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

/** Rests for the admin grammar: inside it, and nemar-cli #2390's cases outside it. */
const SHA = "a".repeat(64);
const REC = "sub-01/eeg/sub-01_task-rest_eeg.edf";
const RESTS = [
  `record/${REC}`,
  `file/${SHA}/${REC}`,
  "record/sub-01/eeg/sub-01_task-a%20b_eeg.edf",
  "record/a/b/c%20(1)/sub-%C2%B5_task-x_eeg.edf",
  "",
  "record",
  "record/",
  `record/${REC}/`,
  `record//${REC}`,
  `record/../${REC}`,
  `record/./${REC}`,
  "record/sub-01/..",
  `record/%2E%2E/${REC}`,
  `record/.%2e/${REC}`,
  `record/%2e/${REC}`,
  "record/sub-01%2Feeg%2Fsub-01_task-rest_eeg.edf",
  "record/sub-01%5Ceeg/sub-01_task-rest_eeg.edf",
  "record/sub-01/%2Eeeg/sub-01_task-rest_eeg.edf",
  "record/sub-01/.eeg/sub-01_task-rest_eeg.edf",
  "record/sub-01\\eeg/sub-01_task-rest_eeg.edf",
  "record/sub-01/eeg/sub-01_task-rest_eeg.edf%00",
  "record/sub-01/eeg/sub-01_task-rest%0A_eeg.edf",
  "record/sub-01/eeg/sub-01_task-rest%7F_eeg.edf",
  "record/sub-01/eeg/sub-01_task-rest%ZZ_eeg.edf",
  "record/sub-01/eeg/sub-01_task-rest%E0%A4_eeg.edf",
  "record/sub-01/eeg/sub-01?x_eeg.edf",
  "record/sub-01/eeg/sub-01#x_eeg.edf",
  "record/sub 01/eeg/sub-01_task-rest_eeg.edf",
  `file/${SHA.toUpperCase()}/${REC}`,
  `file/${SHA.slice(1)}/${REC}`,
  `file/${SHA}0/${REC}`,
  `file/${SHA}`,
  `views/${REC}`,
  `RECORD/${REC}`,
  `record/${"a/".repeat(600)}x_eeg.edf`,
  "record/sub-01/eeg/sub-01_task-rest%C2%85_eeg.edf",
  "record/sub-01/eeg/sub-01_task-rest_eeg.edf%3F",
  "record/sub-01/eeg/sub-01_task-rest_eeg.edf%23x",
  "record/sub-01/eeg/sub-01_task-%E2%80%AErest_eeg.edf",
  "record/sub-01%252Feeg/sub-01_task-rest_eeg.edf",
  "record/sub-01/eeg/sub-01_task-rest_channels.tsv",
  "record/%20sub-01/eeg/sub-01_task-rest_eeg.edf",
  "record/http:/eeg/sub-01_task-rest_eeg.edf",
  "record/%2e%2e/%2e%2e/%2e%2e/users/x_eeg.edf",
  "record/.%2e/.%2e/.%2e/users/x_eeg.edf",
  "record/%2E./%2E./users/x_eeg.edf",
  "record/../../../users/x_eeg.edf",
  `file/${SHA}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/users`,
  `record/${REC}?x=1`,
  `record/${REC}?`,
  `record/${REC}#x`,
];
const STAMPS = [
  "7",
  "12",
  "",
  "0",
  "01",
  "-1",
  "1e3",
  "1.0",
  " 1",
  "99999999999999999",
  "9999999999999999",
  "5/..",
  "%35",
];

/** The proxy's obligations as numbered items, comment markers and line breaks dropped. */
function obligations(source: string): string[] {
  const start = source.indexOf("THE PROXY'S OBLIGATIONS");
  if (start < 0) return [];
  const items: string[] = [];
  for (const raw of source.slice(start).split("\n").slice(1)) {
    const marked = /^\s*(?:\/\/|\*)(.*)$/.exec(raw);
    if (!marked) break;
    const body = marked[1];
    const item = /^\s+(\d+\.\s.*)$/.exec(body);
    if (item) items.push(item[1]);
    else if (items.length > 0 && /^\s{3,}\S/.test(body)) items[items.length - 1] += ` ${body}`;
    else if (items.length > 0) break;
  }
  return items.map((i) => i.replace(/\s+/g, " ").trim());
}

describe.skipIf(SKIP)("against nemar-cli's admin quality mount (phase W9)", () => {
  it("holds the constants, the words in order, and both patterns", async () => {
    const theirs = await import(/* @vite-ignore */ PATH);
    expect(admin.QUALITY_ADMIN_SEGMENT).toBe(theirs.QUALITY_ADMIN_SEGMENT);
    expect(Object.entries(admin.QUALITY_ADMIN_ROUTE_WORDS)).toEqual(
      Object.entries(theirs.QUALITY_ADMIN_ROUTE_WORDS),
    );
    expect(admin.QUALITY_ADMIN_SEGMENT_RE.source).toBe(theirs.QUALITY_ADMIN_SEGMENT_RE.source);
    expect(admin.QUALITY_ADMIN_SEGMENT_RE.flags).toBe(theirs.QUALITY_ADMIN_SEGMENT_RE.flags);
    const stamp = await import(
      /* @vite-ignore */ PATH.replace(/quality-route\.ts$/, "compute-stamp.ts")
    );
    expect(admin.COMPUTE_PIPELINE_STAMP_ID_RE.source).toBe(
      stamp.COMPUTE_PIPELINE_STAMP_ID_RE.source,
    );
    expect(admin.COMPUTE_PIPELINE_STAMP_ID_RE.flags).toBe(stamp.COMPUTE_PIPELINE_STAMP_ID_RE.flags);
  });

  it("answers the grammar, the forward path and the builders as nemar-cli does", async () => {
    const theirs = await import(/* @vite-ignore */ PATH);
    for (const rest of RESTS) {
      expect(admin.qualityAdminRest(rest), JSON.stringify(rest)).toEqual(
        theirs.qualityAdminRest(rest),
      );
      for (const stamp of STAMPS) {
        expect(admin.qualityAdminForwardPath(stamp, rest), `${stamp} ${rest}`).toBe(
          theirs.qualityAdminForwardPath(stamp, rest),
        );
      }
    }
    for (const recording of [REC, "a/b/c (1)/sub-µ_task-x_eeg.edf", "sub-01_task-x_eeg.set"]) {
      expect(admin.qualityAdminRecordPath(7, recording)).toBe(
        theirs.qualityAdminRecordPath(7, recording),
      );
      expect(admin.qualityAdminFilePath(7, SHA, recording)).toBe(
        theirs.qualityAdminFilePath(7, SHA, recording),
      );
    }
  });

  it("copies the proxy's obligations, item for item", () => {
    const theirs = obligations(fs.readFileSync(PATH, "utf8"));
    expect(theirs.length).toBeGreaterThanOrEqual(7);
    expect(obligations(ADMIN_SOURCE)).toEqual(theirs);
  });
});
