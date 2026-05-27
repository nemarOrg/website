import { describe, expect, it } from "vitest";
import { dirListingUrl, fileDownloadUrl } from "./dir-listing";

describe("dirListingUrl", () => {
  it("emits the root listing URL when path is empty", () => {
    expect(dirListingUrl("on005514", "v1.0.0", "")).toBe(
      "https://data.nemar.org/on005514/v1.0.0/?format=json",
    );
  });

  it("encodes nested paths segment-by-segment so embedded slashes survive", () => {
    expect(dirListingUrl("on005514", "v1.0.0", "sub-NDARAA947ZG5/eeg")).toBe(
      "https://data.nemar.org/on005514/v1.0.0/sub-NDARAA947ZG5/eeg/?format=json",
    );
  });

  it("strips leading and trailing slashes from the path", () => {
    expect(dirListingUrl("on005514", "v1.0.0", "/sub-01/")).toBe(
      "https://data.nemar.org/on005514/v1.0.0/sub-01/?format=json",
    );
  });

  it("percent-encodes path segments with special chars", () => {
    expect(dirListingUrl("on005514", "v1.0.0", "code/run script.py")).toBe(
      "https://data.nemar.org/on005514/v1.0.0/code/run%20script.py/?format=json",
    );
  });

  it("respects a custom dataBase override (for tests / staging)", () => {
    expect(dirListingUrl("on005514", "v1.0.0", "", "https://stage.example/")).toBe(
      "https://stage.example/on005514/v1.0.0/?format=json",
    );
  });
});

describe("fileDownloadUrl", () => {
  it("builds the canonical worker download URL", () => {
    expect(fileDownloadUrl("on005514", "v1.0.0", "README.md")).toBe(
      "https://data.nemar.org/on005514/v1.0.0/README.md",
    );
  });

  it("preserves nested paths with per-segment encoding", () => {
    expect(fileDownloadUrl("on005514", "v1.0.0", "sub-NDARAA947ZG5/eeg/file.set")).toBe(
      "https://data.nemar.org/on005514/v1.0.0/sub-NDARAA947ZG5/eeg/file.set",
    );
  });

  it("encodes special chars per segment without escaping the slash separators", () => {
    expect(fileDownloadUrl("on005514", "v1.0.0", "code/run script.py")).toBe(
      "https://data.nemar.org/on005514/v1.0.0/code/run%20script.py",
    );
  });
});
