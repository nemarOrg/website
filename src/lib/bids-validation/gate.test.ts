import { describe, expect, it } from "vitest";
import { nodeFs, repoPath } from "../../../test/node";
import {
  ANNEX_POINTER_MAX_BYTES,
  type ValidationState,
  applyGate,
  canUpload,
  errorLocations,
  findAnnexPointers,
  isAnnexPointer,
  isSchemaDownloadFailure,
} from "./gate";
import type { ReportIssue } from "./protocol";

const fs = await nodeFs();
const FIXTURES = "test/fixtures/bids-validation";

// A pointer that git-annex itself wrote (see the fixtures README), and a file of the real dataset
// that is exactly 1024 bytes long.
const POINTER = fs.readFileSync(repoPath(`${FIXTURES}/annex-pointer/participants.tsv`));
const POINTER_TEXT = new TextDecoder().decode(POINTER);
const EDF = fs.readFileSync(
  repoPath(`${FIXTURES}/bids-minimal/sub-01/eeg/sub-01_task-rest_eeg.edf`),
);
const TSV = fs.readFileSync(repoPath(`${FIXTURES}/bids-minimal/participants.tsv`));

describe("isAnnexPointer", () => {
  it("recognizes a pointer git-annex wrote", () => {
    expect(POINTER_TEXT).toMatch(/^\/annex\/objects\/SHA256E-s35--[0-9a-f]{64}\.tsv\n$/);
    expect(isAnnexPointer(POINTER.byteLength, POINTER_TEXT)).toBe(true);
  });

  it("draws the line where the repository check does: fewer than 1024 bytes", () => {
    // `find -size -1024c`
    expect(ANNEX_POINTER_MAX_BYTES).toBe(1024);
    expect(isAnnexPointer(1023, POINTER_TEXT)).toBe(true);
    expect(isAnnexPointer(1024, POINTER_TEXT)).toBe(false);
  });

  it("finds the line anywhere in the file, as `grep '^/annex/objects/'` does", () => {
    expect(isAnnexPointer(120, `# note\n${POINTER_TEXT}`)).toBe(true);
  });

  it("wants the line to start with the prefix, not merely contain it", () => {
    expect(isAnnexPointer(120, `see ${POINTER_TEXT}`)).toBe(false);
  });

  it("is not fooled by an ordinary table or by an empty file", () => {
    expect(isAnnexPointer(TSV.byteLength, new TextDecoder().decode(TSV))).toBe(false);
    expect(isAnnexPointer(0, "")).toBe(false);
  });
});

const error = (code: string, location?: string): ReportIssue => ({
  severity: "error",
  code,
  ...(location ? { location } : {}),
});

describe("errorLocations", () => {
  it("lists each location of an error once, and nothing else", () => {
    expect(
      errorLocations([
        error("TSV_COLUMN_MISSING", "/participants.tsv"),
        error("PARTICIPANT_ID_MISMATCH", "/participants.tsv"),
        error("MISSING_DATASET_DESCRIPTION"),
        {
          severity: "warning",
          code: "JSON_KEY_RECOMMENDED",
          location: "/dataset_description.json",
        },
        error("JSON_INVALID", "/participants.json"),
      ]),
    ).toEqual(["/participants.tsv", "/participants.json"]);
  });
});

describe("findAnnexPointers", () => {
  const pointerFile = new File([POINTER], "participants.tsv");
  // The same pointer with filler after it, to exactly 1023 bytes and exactly 1024: the pointer line
  // is in both, so only the size can tell them apart, which is the check's `-size -1024c`.
  const padded = (bytes: number) =>
    new File([POINTER_TEXT + "#".repeat(bytes - POINTER.byteLength)], "padded.tsv");
  const realFiles = new Map<string, File>([
    ["/participants.tsv", pointerFile],
    ["/participants-real.tsv", new File([TSV], "participants-real.tsv")],
    ["/under-the-limit.tsv", padded(1023)],
    ["/at-the-limit.tsv", padded(1024)],
    ["/sub-01/eeg/sub-01_task-rest_eeg.edf", new File([EDF], "sub-01_task-rest_eeg.edf")],
  ]);
  const lookup = (location: string) => realFiles.get(location);

  it("finds the pointer files among the locations", async () => {
    const found = await findAnnexPointers(
      ["/participants.tsv", "/participants-real.tsv", "/sub-01/eeg/sub-01_task-rest_eeg.edf"],
      lookup,
    );
    expect([...found]).toEqual(["/participants.tsv"]);
  });

  it("stops at 1024 bytes: a file that size with the pointer line in it is not a pointer", async () => {
    expect(padded(1023).size).toBe(1023);
    expect(padded(1024).size).toBe(1024);
    const found = await findAnnexPointers(["/under-the-limit.tsv", "/at-the-limit.tsv"], lookup);
    expect([...found]).toEqual(["/under-the-limit.tsv"]);
  });

  it("does not make a pointer of a location it has no file for", async () => {
    expect([...(await findAnnexPointers(["/not-dropped.tsv"], lookup))]).toEqual([]);
  });

  it("finds them all when there are many, in more than one batch", async () => {
    const locations = Array.from({ length: 200 }, (_, index) => `/sub-${index}/participants.tsv`);
    const found = await findAnnexPointers(locations, () => pointerFile);
    expect(found.size).toBe(200);
  });
});

/**
 * What the committed validator (3.0.2) said, copied from real runs on 2026-10-21 and not written
 * by hand: each is the `issueMessage` of the `HED_ERROR` with sub-code `SCHEMA_LOAD_FAILED` that
 * the run produced, and every run used the real bundle, the real `fetch` and a real dataset
 * (`test/fixtures/bids-validation/bids-minimal` with the HED overlay, `dataset_description.json`
 * edited as the name says). The runs that need no network were repeated by
 * `test/bids-validator-integration.test.ts`, which fails if a release rewords any of them.
 */
const HED_FOOTER =
  "(For more information on this HED error, see https://hed-specification.readthedocs.io/en/latest/Appendix_B.html#schema-load-failed.)";
const SPEC_9_9_9 = '"{"prefix":"","version":"9.9.9","library":"","localPath":""}"';
const REAL_MESSAGES = {
  // The request for HEDVersion "9.9.9" got no answer. The cause is the browser's own wording, so
  // it is the one part that differs between engines.
  //   Chrome 155.0.8059.85, the worker served by a Cloudflare Pages preview, with requests to
  //   raw.githubusercontent.com aborted (Playwright `route.abort("internetdisconnected")`).
  noAnswerChrome: `ERROR: [SCHEMA_LOAD_FAILED] Could not load HED schema ${SPEC_9_9_9} from remote repository - "Failed to fetch".  ${HED_FOOTER}`,
  //   Node 26.12.0 with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY=http://127.0.0.1:1 (a closed port),
  //   and Deno 2.9.7 with HTTPS_PROXY=http://127.0.0.1:1: the same words.
  noAnswerNodeAndDeno: `ERROR: [SCHEMA_LOAD_FAILED] Could not load HED schema ${SPEC_9_9_9} from remote repository - "fetch failed".  ${HED_FOOTER}`,

  // GitHub answered. HEDVersion "9.9.9", live: Chrome 155 and Node 26 both got a 404 (`statusText`
  // is empty over HTTP/2, hence "404 .").
  answered404:
    'ERROR: [SCHEMA_LOAD_FAILED] Could not load HED schema "{"prefix":"","version":"9.9.9","library":"","localPath":""}" from remote repository - "ERROR: [INTERNAL_ERROR] I/O error when reading from network - server responded to URL "https://raw.githubusercontent.com/hed-standard/hed-schemas/refs/heads/main/standard_schema/hedxml/HED9.9.9.xml" with HTTP status code 404 .  (For more information on this HED error, see https://hed-specification.readthedocs.io/en/latest/Appendix_B.html#internal-error.)".  (For more information on this HED error, see https://hed-specification.readthedocs.io/en/latest/Appendix_B.html#schema-load-failed.)',
  // GitHub does not give a 503 on demand: this is Node 26 with a `fetch` that returned one, put
  // through the real validator (HEDVersion "8.4.1").
  answered503:
    'ERROR: [SCHEMA_LOAD_FAILED] Could not load HED schema "{"prefix":"","version":"8.4.1","library":"","localPath":""}" from remote repository - "ERROR: [INTERNAL_ERROR] I/O error when reading from network - server responded to URL "https://raw.githubusercontent.com/hed-standard/hed-schemas/refs/heads/main/standard_schema/hedxml/HED8.4.1.xml" with HTTP status code 503 Service Unavailable.  (For more information on this HED error, see https://hed-specification.readthedocs.io/en/latest/Appendix_B.html#internal-error.)".  (For more information on this HED error, see https://hed-specification.readthedocs.io/en/latest/Appendix_B.html#schema-load-failed.)',

  // The other conditions with this sub-code, none of which is a request at all (Chrome 155 and
  // Node 26 agree).
  //   HED columns in an events.tsv and no HEDVersion in dataset_description.json.
  noSpecification: `ERROR: [SCHEMA_LOAD_FAILED] No valid HED schema specification was supplied.  ${HED_FOOTER}`,
  //   HEDVersion "a:b:8.3.0".
  invalidSpecification: `ERROR: [SCHEMA_LOAD_FAILED] The supplied HED schema specification is invalid. Specification: a:b:8.3.0.  ${HED_FOOTER}`,
  //   HEDVersion ["score_1.2.0", "score_2.0.0"] (Node 26).
  cannotMerge: `ERROR: [SCHEMA_LOAD_FAILED] Could not merge lazy partnered schemas with different "withStandard" values: "8.3.0" and "8.2.0".  ${HED_FOOTER}`,
  //   A HEDVersion that quotes the download wording: the validator repeats it inside its own
  //   sentence. Node 26.
  quotesTheWording: `ERROR: [SCHEMA_LOAD_FAILED] The supplied HED schema specification is invalid. Specification: Could not load HED schema "x" from remote repository - "y.  ${HED_FOOTER}`,
};

const hedError = (issueMessage: string, location?: string): ReportIssue => ({
  severity: "error",
  code: "HED_ERROR",
  subCode: "SCHEMA_LOAD_FAILED",
  ...(location ? { location } : {}),
  issueMessage,
});

describe("isSchemaDownloadFailure", () => {
  it.each([
    ["Chrome", REAL_MESSAGES.noAnswerChrome],
    ["Node and Deno", REAL_MESSAGES.noAnswerNodeAndDeno],
  ])("recognizes a schema request that got no answer, worded by %s", (_engine, message) => {
    expect(isSchemaDownloadFailure(hedError(message))).toBe(true);
  });

  const EVENTS = "/sub-01/eeg/sub-01_task-rest_events.tsv";
  const notDownloadFailures: [string, string, string | undefined][] = [
    ["GitHub answered 404, a version that does not exist", REAL_MESSAGES.answered404, undefined],
    ["GitHub answered 503", REAL_MESSAGES.answered503, undefined],
    ["there are HED columns and no HEDVersion", REAL_MESSAGES.noSpecification, EVENTS],
    ["the specification is invalid", REAL_MESSAGES.invalidSpecification, undefined],
    ["two library schemas cannot be merged", REAL_MESSAGES.cannotMerge, undefined],
  ];
  it.each(notDownloadFailures)("does not recognize it when %s", (_why, message, location) => {
    expect(isSchemaDownloadFailure(hedError(message, location))).toBe(false);
  });

  it("is not told otherwise by a HEDVersion that quotes the download wording", () => {
    // The validator puts the dataset's own text in this message, so the pattern is anchored at the
    // start: wording the dataset controls must not be able to make its error exempt.
    const message = REAL_MESSAGES.quotesTheWording;
    expect(message).toContain('Could not load HED schema "x" from remote repository - "y');
    expect(isSchemaDownloadFailure(hedError(message))).toBe(false);
  });

  it("does not recognize a message in a wording it does not know, or none", () => {
    // The answer to an unknown message is to stop the upload.
    expect(isSchemaDownloadFailure(hedError("Something else went wrong."))).toBe(false);
    expect(
      isSchemaDownloadFailure({
        severity: "error",
        code: "HED_ERROR",
        subCode: "SCHEMA_LOAD_FAILED",
      }),
    ).toBe(false);
  });

  it("does not take another HED error for it", () => {
    expect(
      isSchemaDownloadFailure({
        severity: "error",
        code: "HED_ERROR",
        subCode: "TAG_INVALID",
        location: "/sub-01/eeg/sub-01_task-rest_events.tsv",
        issueMessage: REAL_MESSAGES.noAnswerChrome,
      }),
    ).toBe(false);
  });

  it("does not take another code with that sub-code for it", () => {
    expect(
      isSchemaDownloadFailure({
        severity: "error",
        code: "X",
        subCode: "SCHEMA_LOAD_FAILED",
        issueMessage: REAL_MESSAGES.noAnswerChrome,
      }),
    ).toBe(false);
  });
});

describe("applyGate", () => {
  const warning: ReportIssue = {
    severity: "warning",
    code: "JSON_KEY_RECOMMENDED",
    subCode: "HEDVersion",
    location: "/dataset_description.json",
  };
  const onPointer = error("TSV_COLUMN_MISSING", "/participants.tsv");
  const elsewhere = error("JSON_INVALID", "/participants.json");
  const missing: ReportIssue = {
    severity: "error",
    code: "MISSING_DATASET_DESCRIPTION",
    affects: ["/dataset_description.json"],
  };

  it("never lets a warning stop the upload", () => {
    const verdict = applyGate([warning, warning], new Set());
    expect(verdict.blocking).toEqual([]);
    expect(verdict.warnings).toHaveLength(2);
  });

  it("stops the upload for an error", () => {
    expect(applyGate([elsewhere], new Set()).blocking).toEqual([elsewhere]);
  });

  it("does not count an error on a pointer file, as the repository check does not", () => {
    const verdict = applyGate([onPointer, elsewhere], new Set(["/participants.tsv"]));
    expect(verdict.annexSkipped).toEqual([onPointer]);
    expect(verdict.blocking).toEqual([elsewhere]);
  });

  it("counts the same error when the file is not a pointer", () => {
    expect(applyGate([onPointer], new Set()).blocking).toEqual([onPointer]);
  });

  it("never takes an error with no location for a pointer", () => {
    expect(applyGate([missing], new Set(["/dataset_description.json"])).blocking).toEqual([
      missing,
    ]);
  });

  it("compares a location whole, not as a prefix", () => {
    expect(
      applyGate([error("X", "/participants.tsv.bak")], new Set(["/participants.tsv"])).blocking,
    ).toHaveLength(1);
  });

  const downloadFailed = hedError(REAL_MESSAGES.noAnswerChrome);

  it("does not stop the upload for a HED schema the browser could not download", () => {
    const verdict = applyGate([downloadFailed], new Set());
    expect(verdict.blocking).toEqual([]);
    expect(verdict.schemaDownloadFailed).toEqual([downloadFailed]);
  });

  it("still stops it for a real error beside that one", () => {
    const verdict = applyGate([downloadFailed, elsewhere], new Set());
    expect(verdict.blocking).toEqual([elsewhere]);
    expect(verdict.schemaDownloadFailed).toEqual([downloadFailed]);
  });

  const stopped: [string, ReportIssue][] = [
    ["a version GitHub answered 404 for", hedError(REAL_MESSAGES.answered404)],
    ["a server error", hedError(REAL_MESSAGES.answered503)],
    [
      "HED columns and no HEDVersion",
      hedError(REAL_MESSAGES.noSpecification, "/sub-01/eeg/sub-01_task-rest_events.tsv"),
    ],
    ["an invalid specification", hedError(REAL_MESSAGES.invalidSpecification)],
    ["schemas that cannot be merged", hedError(REAL_MESSAGES.cannotMerge)],
  ];
  it.each(stopped)(
    "stops the upload for %s, which the repository check fails too",
    (_why, issue) => {
      const verdict = applyGate([issue], new Set());
      expect(verdict.blocking).toEqual([issue]);
      expect(verdict.schemaDownloadFailed).toEqual([]);
    },
  );

  it("drops what the validator was told to ignore", () => {
    const verdict = applyGate([{ severity: "ignore", code: "X", location: "/a" }], new Set());
    expect(verdict).toEqual({
      blocking: [],
      annexSkipped: [],
      schemaDownloadFailed: [],
      warnings: [],
    });
  });
});

describe("canUpload", () => {
  const states: [string, ValidationState, boolean][] = [
    ["has not run", { kind: "idle" }, false],
    ["is running", { kind: "running" }, false],
    ["found no errors", { kind: "finished", blockingErrors: 0 }, true],
    ["found errors", { kind: "finished", blockingErrors: 3 }, false],
    ["could not run", { kind: "unavailable", reason: "no Web Workers" }, true],
  ];

  it.each(states)(
    "when the validation %s, with a sound structure",
    (_name, validation, allowed) => {
      expect(canUpload({ structurePassed: true, validation })).toBe(allowed);
    },
  );

  it.each(states)(
    "never when the structure failed, whatever the validation %s",
    (_name, validation) => {
      expect(canUpload({ structurePassed: false, validation })).toBe(false);
    },
  );
});
