import { describe, expect, it } from "vitest";
import { nodeFs, repoPath } from "../../../test/node";
import {
  type RawValidationResult,
  type WorkerFileEntry,
  describeFailure,
  toReport,
  validatorOptions,
  withRelativePaths,
} from "./protocol";

const fs = await nodeFs();
const FIXTURE = "test/fixtures/bids-validation/bids-minimal";

/** A file of the real fixture dataset, as a drop of it would hand it over. */
function dropped(path: string): WorkerFileEntry {
  const bytes = fs.readFileSync(repoPath(`${FIXTURE}/${path}`));
  return { path, file: new File([bytes], path.split("/").pop() as string, { lastModified: 1 }) };
}

describe("withRelativePaths", () => {
  it("gives each file the path an <input webkitdirectory> would have", () => {
    const entries = [dropped("participants.tsv"), dropped("sub-01/eeg/sub-01_task-rest_eeg.json")];
    expect(withRelativePaths(entries).map((file) => file.webkitRelativePath)).toEqual([
      "dataset/participants.tsv",
      "dataset/sub-01/eeg/sub-01_task-rest_eeg.json",
    ]);
  });

  it("wraps the same bytes under the same name", async () => {
    const [entry] = [dropped("participants.tsv")];
    const [wrapper] = withRelativePaths([entry]);
    expect(wrapper.name).toBe("participants.tsv");
    expect(wrapper.size).toBe(entry.file.size);
    expect(wrapper.lastModified).toBe(1);
    expect(await wrapper.text()).toBe(await entry.file.text());
  });

  it("leaves the caller's file alone", () => {
    const entry = dropped("participants.tsv");
    withRelativePaths([entry]);
    expect(Object.hasOwn(entry.file, "webkitRelativePath")).toBe(false);
  });
});

describe("validatorOptions", () => {
  it("is what the repository check runs, so the page and the check can agree", () => {
    // `deno run -A jsr:@bids/validator@<pin> . --json --ignoreWarnings`: every option but the two
    // flags is the command line's default. `--max-rows` defaults to 1000.
    expect(validatorOptions()).toEqual({
      datasetPath: "/",
      debug: "ERROR",
      datasetTypes: [],
      blacklistModalities: [],
      maxRows: 1000,
    });
  });

  it("keeps warnings, which the page lists, and the bundled schema, which needs no network", () => {
    // `ignoreWarnings` would hide what the panel shows; a `schema` value makes the validator fetch.
    expect(validatorOptions()).not.toHaveProperty("ignoreWarnings");
    expect(validatorOptions()).not.toHaveProperty("schema");
  });

  it("returns a fresh object, so one run cannot change the next", () => {
    validatorOptions().datasetTypes.push("derivative");
    expect(validatorOptions().datasetTypes).toEqual([]);
  });
});

describe("toReport", () => {
  // The shape `validate` returns for the fixture's `dataset_description.json`: a `DatasetIssues`
  // (a list and a `Map`) and the summary, with `undefined` where a field was not set.
  const raw: RawValidationResult = {
    issues: {
      issues: [
        {
          code: "TOO_FEW_AUTHORS",
          severity: "warning",
          location: "/dataset_description.json",
          rule: "rules.checks.hints.TooFewAuthors",
          subCode: undefined,
          issueMessage: undefined,
        },
        { code: "MISSING_DATASET_DESCRIPTION", affects: ["/dataset_description.json"] },
        {
          code: "JSON_KEY_RECOMMENDED",
          subCode: "HEDVersion",
          severity: "warning",
          location: "/dataset_description.json",
          issueMessage:
            "Field description: If HED tags are used:\nThe version of the HED schema.\n",
        },
      ],
      codeMessages: new Map([
        ["TOO_FEW_AUTHORS", "The 'Authors' field should contain an array of values."],
        ["JSON_KEY_RECOMMENDED", "A JSON file is missing a key listed as recommended."],
      ]),
    },
    summary: {
      totalFiles: 7,
      size: 1898,
      subjects: ["01"],
      sessions: [],
      tasks: ["rest"],
      modalities: ["EEG"],
      dataTypes: ["eeg"],
      schemaVersion: "1.2.7",
    },
  };

  it("carries every finding, with no key that has no value", () => {
    const { issues } = toReport(raw);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toEqual({
      severity: "warning",
      code: "TOO_FEW_AUTHORS",
      location: "/dataset_description.json",
      rule: "rules.checks.hints.TooFewAuthors",
    });
    expect(Object.hasOwn(issues[0], "subCode")).toBe(false);
  });

  it("calls a finding with no severity an error, as the validator does", () => {
    expect(toReport(raw).issues[1]).toEqual({
      severity: "error",
      code: "MISSING_DATASET_DESCRIPTION",
      affects: ["/dataset_description.json"],
    });
  });

  it("turns the code descriptions into a plain object", () => {
    expect(toReport(raw).codeMessages).toEqual({
      TOO_FEW_AUTHORS: "The 'Authors' field should contain an array of values.",
      JSON_KEY_RECOMMENDED: "A JSON file is missing a key listed as recommended.",
    });
  });

  it("counts subjects and sessions instead of listing them", () => {
    expect(toReport(raw).summary).toEqual({
      totalFiles: 7,
      size: 1898,
      subjectCount: 1,
      sessionCount: 0,
      tasks: ["rest"],
      modalities: ["EEG"],
      dataTypes: ["eeg"],
      schemaVersion: "1.2.7",
    });
  });

  it("survives a structured clone, which is what a worker message does to it", () => {
    const report = toReport(raw);
    expect(structuredClone(report)).toEqual(report);
  });
});

describe("describeFailure", () => {
  it("keeps the name and the message of an error", () => {
    expect(describeFailure(new RangeError("too many files"))).toEqual({
      name: "RangeError",
      message: "too many files",
    });
  });

  it("writes out a plain object, which is how the validator throws some of its refusals", () => {
    // `throw { code: "FILE_READ", ... }` in the validator's file access: String() of it would be
    // "[object Object]".
    expect(describeFailure({ code: "FILE_READ", location: "/participants.tsv" })).toEqual({
      name: "Error",
      message: '{"code":"FILE_READ","location":"/participants.tsv"}',
    });
  });

  it("says what a value is when it cannot be written out", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(describeFailure(cycle)).toEqual({ name: "Error", message: "[object Object]" });
  });

  it("says something for a thrown value that is not an object", () => {
    expect(describeFailure("boom")).toEqual({ name: "Error", message: "boom" });
    expect(describeFailure(undefined)).toEqual({ name: "Error", message: "undefined" });
  });
});
