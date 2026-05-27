import { describe, expect, it } from "vitest";
import { classifyFile } from "./bids-tree";

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
