import { describe, expect, it } from "vitest";
import pin from "../../../validator-version.json";
import {
  VALIDATOR_VERSION,
  describeError,
  isValidationReport,
  runValidation,
  workerUrl,
} from "./client";

describe("workerUrl", () => {
  it("serves the pinned release by default", () => {
    expect(VALIDATOR_VERSION).toBe(pin.version);
    expect(workerUrl()).toBe(`/vendor/bids-validator/${pin.version}/bids-validator-worker.js`);
  });

  it("is a different address for another release, so a cached worker is never the new one", () => {
    expect(workerUrl("9.9.9")).toBe("/vendor/bids-validator/9.9.9/bids-validator-worker.js");
    expect(workerUrl("9.9.9")).not.toBe(workerUrl());
  });
});

describe("isValidationReport", () => {
  // The shape `toReport` makes, with a finding of each kind: what a worker sends. The real
  // validator's reports are held to this in `test/bids-validator-integration.test.ts`.
  const report = {
    issues: [
      {
        severity: "error",
        code: "MISSING_DATASET_DESCRIPTION",
        affects: ["/dataset_description.json"],
      },
      {
        severity: "warning",
        code: "JSON_KEY_RECOMMENDED",
        subCode: "HEDVersion",
        location: "/dataset_description.json",
        issueMessage: "A recommended key is missing.",
        suggestion: "Add it.",
        rule: "rules.x",
      },
    ],
    codeMessages: { JSON_KEY_RECOMMENDED: "A JSON key that is recommended is missing." },
    summary: {
      totalFiles: 7,
      size: 1898,
      subjectCount: 1,
      sessionCount: 0,
      tasks: ["rest"],
      modalities: ["EEG"],
      dataTypes: ["eeg"],
      schemaVersion: "1.2.7",
    },
  };

  it("accepts a report in the declared shape, empty or not", () => {
    expect(isValidationReport(report)).toBe(true);
    expect(isValidationReport({ ...report, issues: [], codeMessages: {} })).toBe(true);
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["a string", "report"],
    ["a list", [report]],
    ["no findings list", { ...report, issues: undefined }],
    ["findings that are not a list", { ...report, issues: "none" }],
    [
      "a finding with an unknown severity",
      { ...report, issues: [{ severity: "fatal", code: "X" }] },
    ],
    ["a finding with no code", { ...report, issues: [{ severity: "error" }] }],
    [
      "a finding whose location is not text",
      { ...report, issues: [{ severity: "error", code: "X", location: 4 }] },
    ],
    [
      "a finding whose affected files are not a list",
      { ...report, issues: [{ severity: "error", code: "X", affects: "/a" }] },
    ],
    ["a finding that is not an object", { ...report, issues: [null] }],
    ["code descriptions that are a list", { ...report, codeMessages: [] }],
    ["a description that is not text", { ...report, codeMessages: { X: 1 } }],
    ["no summary", { ...report, summary: undefined }],
    [
      "a summary with no schema version",
      { ...report, summary: { ...report.summary, schemaVersion: undefined } },
    ],
    [
      "a count that is not a number",
      { ...report, summary: { ...report.summary, totalFiles: "7" } },
    ],
    [
      "a list of tasks that is not a list",
      { ...report, summary: { ...report.summary, tasks: "rest" } },
    ],
  ])("rejects %s", (_what, value) => {
    expect(isValidationReport(value)).toBe(false);
  });
});

describe("describeError", () => {
  it("names an error and its message, and writes anything else out", () => {
    expect(describeError(new TypeError("x is not a function"))).toBe(
      "TypeError: x is not a function",
    );
    expect(describeError("plain text")).toBe("plain text");
  });
});

describe("runValidation, where there is no browser to run it in", () => {
  // Node has no `Worker` global, which is the situation of a browser that cannot run one.
  it("says so as an outcome, and does not throw", async () => {
    expect(await runValidation([])).toEqual({
      kind: "unavailable",
      reason: "this browser has no Web Workers",
    });
  });

  it("is cancelled at once when the person had already stopped it", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runValidation([], { signal: controller.signal })).toEqual({ kind: "cancelled" });
  });
});
