import { describe, expect, it } from "vitest";
import {
  type DroppedFileMeta,
  MAX_FILE_BYTES,
  MAX_PATH_LENGTH,
  detectDatatypeFromPath,
  detectModalityFromPath,
  scanBidsDrop,
  validateDatasetDescription,
} from "./bids-precheck";

function f(path: string, size = 1024): DroppedFileMeta {
  const name = path.split("/").pop() ?? path;
  return { path, size, name };
}

describe("scanBidsDrop", () => {
  it("accepts a complete minimal valid drop", () => {
    const result = scanBidsDrop([
      f("dataset_description.json", 200),
      f("README", 100),
      f("sub-01/eeg/sub-01_task-rest_eeg.set"),
      f("sub-01/eeg/sub-01_task-rest_eeg.fdt", 1024 * 1024),
    ]);
    expect(result.errors).toEqual([]);
    expect(result.subjects).toEqual(["sub-01"]);
    expect(result.modalities).toEqual(["EEG"]);
    expect(result.datatypes).toEqual(["eeg"]);
    expect(result.hasDatasetDescription).toBe(true);
    expect(result.hasReadme).toBe(true);
    expect(result.fileCount).toBe(4);
  });

  it("rejects an empty drop", () => {
    const result = scanBidsDrop([]);
    expect(result.errors.map((e) => e.code)).toContain("empty_drop");
  });

  it("rejects a drop missing dataset_description.json", () => {
    const result = scanBidsDrop([f("sub-01/eeg/sub-01_eeg.set")]);
    expect(result.errors.map((e) => e.code)).toContain("no_dataset_description");
  });

  it("rejects a drop with no sub-*/", () => {
    const result = scanBidsDrop([f("dataset_description.json"), f("CHANGES")]);
    expect(result.errors.map((e) => e.code)).toContain("no_subjects");
  });

  it("rejects a drop with no recognizable modality", () => {
    const result = scanBidsDrop([
      f("dataset_description.json"),
      f("sub-01/unknown_datatype/sub-01_file.set"),
    ]);
    expect(result.errors.map((e) => e.code)).toContain("no_modality");
  });

  it("detects both EEG and iEEG with two subjects", () => {
    const result = scanBidsDrop([
      f("dataset_description.json"),
      f("sub-01/eeg/sub-01_eeg.set"),
      f("sub-02/ieeg/sub-02_ieeg.edf"),
    ]);
    expect(result.errors).toEqual([]);
    expect(result.subjects).toEqual(["sub-01", "sub-02"]);
    expect(result.modalities).toEqual(["EEG", "iEEG"]);
  });

  it("detects sessions when present", () => {
    const result = scanBidsDrop([
      f("dataset_description.json"),
      f("sub-01/ses-1/eeg/sub-01_ses-1_eeg.set"),
      f("sub-01/ses-2/eeg/sub-01_ses-2_eeg.set"),
    ]);
    expect(result.sessions).toEqual(["ses-1", "ses-2"]);
  });

  it("flags path traversal", () => {
    const result = scanBidsDrop([f("dataset_description.json"), f("sub-01/../etc/passwd")]);
    expect(result.errors.map((e) => e.code)).toContain("path_traversal");
  });

  it("flags files exceeding 5 GB", () => {
    const result = scanBidsDrop([
      f("dataset_description.json"),
      f("sub-01/eeg/sub-01_big.eeg", MAX_FILE_BYTES + 1),
    ]);
    expect(result.errors.map((e) => e.code)).toContain("file_too_large");
  });

  it("flags paths exceeding the S3 key length limit", () => {
    const longPath = `sub-01/eeg/${"x".repeat(MAX_PATH_LENGTH + 10)}`;
    const result = scanBidsDrop([f("dataset_description.json"), f(longPath)]);
    expect(result.errors.map((e) => e.code)).toContain("path_too_long");
  });

  it("warns on zero-byte files without counting them in totalBytes", () => {
    const result = scanBidsDrop([
      f("dataset_description.json", 200),
      f("sub-01/eeg/sub-01_eeg.set", 1000),
      f("sub-01/eeg/empty", 0),
    ]);
    expect(result.warnings.map((w) => w.code)).toContain("zero_byte_file");
    expect(result.totalBytes).toBe(1200);
  });

  it("warns on missing README when no errors present", () => {
    const result = scanBidsDrop([f("dataset_description.json"), f("sub-01/eeg/sub-01_eeg.set")]);
    expect(result.warnings.map((w) => w.code)).toContain("missing_readme");
  });

  it("suppresses the missing-README warning when hard errors are already present", () => {
    const result = scanBidsDrop([f("sub-01/eeg/sub-01_eeg.set")]);
    expect(result.warnings.map((w) => w.code)).not.toContain("missing_readme");
  });
});

describe("detectModalityFromPath", () => {
  it.each([
    ["sub-01/eeg/file.set", "EEG"],
    ["sub-01/ses-1/meg/file.fif", "MEG"],
    ["sub-01/ieeg/file.edf", "iEEG"],
    ["sub-01/emg/file.set", "EMG"],
    ["sub-01/anat/file.nii", "MRI"],
    ["sub-01/unknown/file", null],
  ])("%s -> %s", (path, expected) => {
    expect(detectModalityFromPath(path)).toBe(expected);
  });
});

describe("detectDatatypeFromPath", () => {
  it("returns the first recognized datatype segment", () => {
    expect(detectDatatypeFromPath("sub-01/ses-1/eeg/foo.set")).toBe("eeg");
    expect(detectDatatypeFromPath("sub-01/anat/foo.nii")).toBe("anat");
    expect(detectDatatypeFromPath("sub-01/funky/foo")).toBeNull();
  });
});

describe("validateDatasetDescription", () => {
  it("accepts a complete dataset_description.json", () => {
    const text = JSON.stringify({
      Name: "Test dataset",
      BIDSVersion: "1.7.0",
      Authors: ["Jane Doe"],
    });
    const result = validateDatasetDescription(text);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects invalid JSON", () => {
    const result = validateDatasetDescription("{not json}");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not valid JSON");
  });

  it("rejects missing Name", () => {
    const result = validateDatasetDescription(JSON.stringify({ BIDSVersion: "1.7.0" }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Name"))).toBe(true);
  });

  it("rejects missing BIDSVersion", () => {
    const result = validateDatasetDescription(JSON.stringify({ Name: "Test" }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("BIDSVersion"))).toBe(true);
  });

  it("warns on missing Authors but does not block", () => {
    const text = JSON.stringify({ Name: "Test", BIDSVersion: "1.7.0" });
    const result = validateDatasetDescription(text);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("Authors"))).toBe(true);
  });

  it("rejects a JSON array (not an object)", () => {
    const result = validateDatasetDescription("[1,2,3]");
    expect(result.ok).toBe(false);
  });
});
