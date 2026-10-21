import { describe, expect, it } from "vitest";
import type { ReportIssue } from "./protocol";
import { ITEMS_PER_GROUP, countBySeverity, groupIssues, issuePath, plainText } from "./report";

// Issues as the validator 3.0.2 reports them for the fixture dataset and for the fixture with a
// git-annex pointer in place of `participants.tsv` (see test/fixtures/bids-validation/README.md).
const warning = (code: string, subCode: string, location: string): ReportIssue => ({
  severity: "warning",
  code,
  subCode,
  location,
});
const columnMissing: ReportIssue = {
  severity: "error",
  code: "TSV_COLUMN_MISSING",
  subCode: "participant_id",
  location: "/participants.tsv",
  issueMessage: "Required initial column 1 not found.",
};
const idMismatch: ReportIssue = {
  severity: "error",
  code: "PARTICIPANT_ID_MISMATCH",
  location: "/participants.tsv",
};

const MESSAGES = {
  TOO_FEW_AUTHORS:
    "The 'Authors' field of 'dataset_description.json' should contain an array of values -\nwith one author per value.\nThis was triggered based on the presence of only one author field.\nPlease ignore if all contributors are already properly listed.\n",
  JSON_KEY_RECOMMENDED: "A JSON file is missing a key listed as recommended.",
  SIDECAR_KEY_RECOMMENDED: "A data file's JSON sidecar is missing a key listed as recommended.",
  TSV_COLUMN_MISSING: "A required column is missing from a TSV file.",
};

describe("plainText", () => {
  it("keeps the words of a link and drops its address", () => {
    // A sentence of the validator's own messages, SPEC_ROOT link and all.
    expect(
      plainText(
        "or `fT/cm` for femto Tesla per centimeter\n(see [Units](SPEC_ROOT/common-principles.md#units)).\n",
      ),
    ).toBe("or fT/cm for femto Tesla per centimeter (see Units).");
  });

  it("joins the hard-wrapped lines of a message", () => {
    expect(plainText(MESSAGES.TOO_FEW_AUTHORS)).toBe(
      "The 'Authors' field of 'dataset_description.json' should contain an array of values - with one author per value. This was triggered based on the presence of only one author field. Please ignore if all contributors are already properly listed.",
    );
  });

  it("handles a link whose text is wrapped in code", () => {
    expect(
      plainText(
        "MUST be indexed with the [`run-<index>`](SPEC_ROOT/appendices/entities.md#run) entity",
      ),
    ).toBe("MUST be indexed with the run-<index> entity");
  });

  it("takes the backticks off a name", () => {
    expect(plainText('`"TaskName"` field, or `"n/a"` if not available')).toBe(
      '"TaskName" field, or "n/a" if not available',
    );
  });
});

describe("issuePath", () => {
  it("is the location when there is one", () => {
    expect(issuePath(columnMissing)).toBe("/participants.tsv");
  });

  it("is the file a check expected, when the check is about a file that is missing", () => {
    expect(
      issuePath({
        severity: "error",
        code: "MISSING_DATASET_DESCRIPTION",
        affects: ["/dataset_description.json"],
      }),
    ).toBe("/dataset_description.json");
  });

  it("is empty for a finding about the dataset as a whole", () => {
    expect(issuePath({ severity: "error", code: "HED_ERROR", subCode: "SCHEMA_LOAD_FAILED" })).toBe(
      "",
    );
  });
});

describe("countBySeverity", () => {
  it("counts errors and warnings and nothing else", () => {
    expect(
      countBySeverity([
        columnMissing,
        idMismatch,
        warning("JSON_KEY_RECOMMENDED", "HEDVersion", "/dataset_description.json"),
        { severity: "ignore", code: "X" },
      ]),
    ).toEqual({ errors: 2, warnings: 1 });
  });
});

describe("groupIssues", () => {
  const issues: ReportIssue[] = [
    warning("JSON_KEY_RECOMMENDED", "HEDVersion", "/dataset_description.json"),
    warning("JSON_KEY_RECOMMENDED", "GeneratedBy", "/dataset_description.json"),
    warning("SIDECAR_KEY_RECOMMENDED", "Manufacturer", "/sub-01/eeg/sub-01_task-rest_eeg.edf"),
    warning("SIDECAR_KEY_RECOMMENDED", "TaskDescription", "/sub-01/eeg/sub-01_task-rest_eeg.edf"),
    warning("SIDECAR_KEY_RECOMMENDED", "Instructions", "/sub-01/eeg/sub-01_task-rest_eeg.edf"),
    { severity: "warning", code: "TOO_FEW_AUTHORS", location: "/dataset_description.json" },
    columnMissing,
  ];

  it("puts errors first, then warnings by how many findings they hold", () => {
    expect(groupIssues(issues, MESSAGES).map((group) => group.key)).toEqual([
      "error:TSV_COLUMN_MISSING",
      "warning:SIDECAR_KEY_RECOMMENDED",
      "warning:JSON_KEY_RECOMMENDED",
      "warning:TOO_FEW_AUTHORS",
    ]);
  });

  it("breaks a tie by code, so the order does not depend on the walk", () => {
    const tied = [warning("B_CODE", "x", "/b"), warning("A_CODE", "x", "/a")];
    expect(groupIssues(tied, {}).map((group) => group.code)).toEqual(["A_CODE", "B_CODE"]);
    expect(groupIssues([...tied].reverse(), {}).map((group) => group.code)).toEqual([
      "A_CODE",
      "B_CODE",
    ]);
  });

  it("describes a group in the words of the validator, as text", () => {
    const groups = groupIssues(issues, MESSAGES);
    expect(groups.find((group) => group.code === "TOO_FEW_AUTHORS")?.description).toBe(
      "The 'Authors' field of 'dataset_description.json' should contain an array of values - with one author per value. This was triggered based on the presence of only one author field. Please ignore if all contributors are already properly listed.",
    );
    expect(groupIssues([idMismatch], MESSAGES)[0].description).toBe("");
  });

  it("labels each finding with its sub-code and its message", () => {
    const [errors] = groupIssues(issues, MESSAGES);
    expect(errors.items).toEqual([
      { path: "/participants.tsv", label: "participant_id: Required initial column 1 not found." },
    ]);
    const sidecar = groupIssues(issues, MESSAGES).find(
      (group) => group.code === "SIDECAR_KEY_RECOMMENDED",
    );
    expect(sidecar?.items.map((item) => item.label)).toEqual([
      "Manufacturer",
      "TaskDescription",
      "Instructions",
    ]);
  });

  it("does not repeat the validator's own 'Field description:' after the key it describes", () => {
    // A missing required key, as the validator words it.
    const [group] = groupIssues(
      [
        {
          severity: "error",
          code: "SIDECAR_KEY_REQUIRED",
          subCode: "TaskName",
          location: "/sub-01/eeg/sub-01_task-rest_eeg.edf",
          issueMessage:
            "Field description: Name of the task. No two tasks should have the same name.\n",
        },
      ],
      {},
    );
    expect(group.items[0].label).toBe(
      "TaskName: Name of the task. No two tasks should have the same name.",
    );
  });

  it("lists the first findings of a large group and counts the rest", () => {
    const many = Array.from({ length: 100 }, (_, index) =>
      warning("SIDECAR_KEY_RECOMMENDED", "Manufacturer", `/sub-${index}/eeg/file.edf`),
    );
    const [group] = groupIssues(many, MESSAGES);
    expect(group.count).toBe(100);
    expect(group.items).toHaveLength(ITEMS_PER_GROUP);
    expect(group.omitted).toBe(100 - ITEMS_PER_GROUP);
    expect(group.items[0].path).toBe("/sub-0/eeg/file.edf");
  });

  it("keeps one code at two severities as two groups", () => {
    const both: ReportIssue[] = [
      { severity: "error", code: "SAME", location: "/a" },
      { severity: "warning", code: "SAME", location: "/b" },
    ];
    expect(groupIssues(both, {}).map((group) => group.key)).toEqual(["error:SAME", "warning:SAME"]);
  });

  it("leaves out what the validator was told to ignore", () => {
    expect(groupIssues([{ severity: "ignore", code: "X", location: "/a" }], {})).toEqual([]);
  });

  it("cuts a very long message so one finding cannot take the page", () => {
    const [group] = groupIssues(
      [{ severity: "error", code: "LONG", location: "/a", issueMessage: "x".repeat(5000) }],
      {},
    );
    expect(group.items[0].label.length).toBeLessThanOrEqual(200);
    expect(group.items[0].label.endsWith("...")).toBe(true);
  });
});
