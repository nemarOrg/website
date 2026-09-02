import { describe, expect, it } from "vitest";
import { bidsRowId, classifyFile, isDirRecordingName, signalDirExt } from "./bids-tree";

describe("classifyFile", () => {
  it("flags EEG raw formats", () => {
    expect(classifyFile("sub-01_task-rest_eeg.set").isEEG).toBe(true);
    expect(classifyFile("sub-01_task-rest_eeg.edf").isEEG).toBe(true);
    expect(classifyFile("sub-01_task-rest_eeg.bdf").isEEG).toBe(true);
    expect(classifyFile("sub-01_task-rest_eeg.vhdr").isEEG).toBe(true);
    expect(classifyFile("sub-01_task-rest_eeg.fif").isEEG).toBe(true);
  });

  it("flags TSV files", () => {
    expect(classifyFile("participants.tsv").isTSV).toBe(true);
    expect(classifyFile("dataset.tsv").isTSV).toBe(true);
  });

  it("flags JSON sidecars", () => {
    expect(classifyFile("dataset_description.json").isJSON).toBe(true);
    expect(classifyFile("task-rest_eeg.json").isJSON).toBe(true);
  });

  it("flags README variants case-insensitively", () => {
    expect(classifyFile("README.md").isReadme).toBe(true);
    expect(classifyFile("readme").isReadme).toBe(true);
    expect(classifyFile("README.txt").isReadme).toBe(true);
    expect(classifyFile("ReadMe.md").isReadme).toBe(true);
  });

  it("does not flag files that aren't BIDS raw, TSV, JSON, or README", () => {
    const cls = classifyFile("sub-01_task-rest_eeg.fdt");
    expect(cls.isEEG).toBe(false);
    expect(cls.isTSV).toBe(false);
    expect(cls.isJSON).toBe(false);
    expect(cls.isReadme).toBe(false);
    expect(cls.ext).toBe("fdt");
  });

  it("handles files with no extension", () => {
    expect(classifyFile(".gitattributes").ext).toBe("gitattributes");
    expect(classifyFile("LICENSE").ext).toBe("");
  });
});

describe("signalDirExt", () => {
  it("flags MEF3 and CTF recording directories", () => {
    expect(signalDirExt("sub-01_ses-ieeg01_task-ccep_run-01_ieeg.mefd")).toBe("mefd");
    expect(signalDirExt("sub-01_task-rest_meg.ds")).toBe("ds");
  });

  it("is case-insensitive", () => {
    expect(signalDirExt("SUB-01_IEEG.MEFD")).toBe("mefd");
    expect(signalDirExt("sub-01_meg.DS")).toBe("ds");
  });

  it("returns null for ordinary directories", () => {
    expect(signalDirExt("sub-01")).toBeNull();
    expect(signalDirExt("ses-ieeg01")).toBeNull();
    expect(signalDirExt("ieeg")).toBeNull();
    expect(signalDirExt("derivatives")).toBeNull();
  });

  it("returns null for a bare dot-name with no stem", () => {
    expect(signalDirExt(".mefd")).toBeNull();
    expect(signalDirExt(".ds")).toBeNull();
  });

  it("does not match the extension mid-name", () => {
    expect(signalDirExt("sub-01_ieeg.mefd.bak")).toBeNull();
    expect(signalDirExt("dsstore")).toBeNull();
  });
});

describe("isDirRecordingName", () => {
  it("is false for every single-file recording format", () => {
    expect(isDirRecordingName("sub-01_task-rest_eeg.set")).toBe(false);
    expect(isDirRecordingName("sub-01_task-rest_eeg.edf")).toBe(false);
    expect(isDirRecordingName("sub-01_task-rest_eeg.bdf")).toBe(false);
    expect(isDirRecordingName("sub-01_task-rest_eeg.vhdr")).toBe(false);
    expect(isDirRecordingName("sub-01_task-rest_meg.fif")).toBe(false);
  });

  it("is true for the named directory formats", () => {
    expect(isDirRecordingName("sub-01_task-ccep_run-01_ieeg.mefd")).toBe(true);
    expect(isDirRecordingName("sub-01_task-rest_meg.ds")).toBe(true);
  });

  it("is true for an extensionless 4D/BTi recording directory", () => {
    // The case `signalDirExt` deliberately cannot answer: no extension, so the
    // zarr index is the only authority that it is a recording at all.
    expect(signalDirExt("sub-01_task-rest_meg")).toBeNull();
    expect(isDirRecordingName("sub-01_task-rest_meg")).toBe(true);
  });
});

describe("bidsRowId (website#277)", () => {
  it("is a valid, whitespace-free DOM id for an ordinary BIDS path", () => {
    const id = bidsRowId("sub-01/eeg/sub-01_task-rest_eeg.set");
    // Hyphen and underscore are left alone (already id-safe); '/' and '.' are
    // escaped to their hex code point so the id has no path/extension syntax.
    expect(id).toBe("rec-sub-01_2feeg_2fsub-01_task-rest_eeg_2eset");
    expect(id).not.toMatch(/\s/);
  });

  it("is stable and deterministic for the same path", () => {
    const path = "sub-02/ses-01/eeg/sub-02_ses-01_task-rest_eeg.edf";
    expect(bidsRowId(path)).toBe(bidsRowId(path));
  });

  it("gives distinct paths distinct ids", () => {
    expect(bidsRowId("sub-01/a.set")).not.toBe(bidsRowId("sub-02/a.set"));
  });

  it("round trips a derivatives path with a different extension", () => {
    const id = bidsRowId("derivatives/sub-01/eeg/sub-01_task-x_ave.fif");
    expect(id.startsWith("rec-derivatives")).toBe(true);
    expect(id).not.toContain("/");
  });
});
