import { describe, expect, it } from "vitest";
import { classifyFile, isDirRecordingName, signalDirExt } from "./bids-tree";

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
