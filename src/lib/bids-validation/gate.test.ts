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
  isSchemaLoadFailure,
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

// The validator's own finding when a HED schema could not be loaded, as a browser reported it for a
// dataset naming HED 9.9.9 when the download failed. It carries no location.
const schemaNotLoaded: ReportIssue = {
  severity: "error",
  code: "HED_ERROR",
  subCode: "SCHEMA_LOAD_FAILED",
  issueMessage:
    'ERROR: [SCHEMA_LOAD_FAILED] Could not load HED schema "{"prefix":"","version":"9.9.9","library":"","localPath":""}" from remote repository - "Failed to fetch". ',
};

describe("isSchemaLoadFailure", () => {
  it("recognizes the validator's finding for a schema it could not load", () => {
    expect(isSchemaLoadFailure(schemaNotLoaded)).toBe(true);
  });

  it("does not take another HED error for it", () => {
    expect(
      isSchemaLoadFailure({
        severity: "error",
        code: "HED_ERROR",
        subCode: "TAG_INVALID",
        location: "/sub-01/eeg/sub-01_task-rest_events.tsv",
      }),
    ).toBe(false);
  });

  it("does not take another code with that sub-code for it", () => {
    expect(
      isSchemaLoadFailure({ severity: "error", code: "X", subCode: "SCHEMA_LOAD_FAILED" }),
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

  it("does not stop the upload for a HED schema that could not be loaded", () => {
    const verdict = applyGate([schemaNotLoaded], new Set());
    expect(verdict.blocking).toEqual([]);
    expect(verdict.schemaNotLoaded).toEqual([schemaNotLoaded]);
  });

  it("still stops it for a real error beside that one", () => {
    const verdict = applyGate([schemaNotLoaded, elsewhere], new Set());
    expect(verdict.blocking).toEqual([elsewhere]);
    expect(verdict.schemaNotLoaded).toEqual([schemaNotLoaded]);
  });

  it("drops what the validator was told to ignore", () => {
    const verdict = applyGate([{ severity: "ignore", code: "X", location: "/a" }], new Set());
    expect(verdict).toEqual({ blocking: [], annexSkipped: [], schemaNotLoaded: [], warnings: [] });
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
