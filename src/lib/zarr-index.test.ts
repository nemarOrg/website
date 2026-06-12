import { describe, expect, it } from "vitest";
import { parseZarrIndex, zarrAvailablePaths, zarrStoreByPath } from "./zarr-index";

describe("parseZarrIndex", () => {
  it("keeps valid stores and drops malformed entries", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      stores: [
        {
          path: "sub-01/eeg/sub-01_task-rest_eeg.set",
          zarr: "sub-01/eeg/sub-01_task-rest_eeg.zarr",
        },
        { path: "bad" },
        null,
      ],
    });

    expect(index?.stores).toEqual([
      { path: "sub-01/eeg/sub-01_task-rest_eeg.set", zarr: "sub-01/eeg/sub-01_task-rest_eeg.zarr" },
    ]);
  });

  it("rejects non-index payloads", () => {
    expect(parseZarrIndex(null)).toBeNull();
    expect(parseZarrIndex({ stores: [] })).toBeNull();
    expect(
      parseZarrIndex({ dataset_id: "nm000132", format: "nemar-zarr-index", stores: "x" }),
    ).toBeNull();
  });
});

describe("zarrAvailablePaths", () => {
  it("returns BIDS source paths, not .zarr paths", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      stores: [
        { path: "sub-01/eeg/a.set", zarr: "sub-01/eeg/a.zarr" },
        { path: "sub-02/eeg/b.edf", zarr: "sub-02/eeg/b.zarr" },
      ],
    });

    expect(index).not.toBeNull();
    expect([...zarrAvailablePaths(index!)]).toEqual(["sub-01/eeg/a.set", "sub-02/eeg/b.edf"]);
  });
});

describe("zarrStoreByPath", () => {
  it("maps BIDS source paths to their Zarr store metadata", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      stores: [
        {
          path: "sub-01/eeg/a.set",
          zarr: "sub-01/eeg/a.zarr",
          groups: [{ name: "eeg_250hz" }],
        },
      ],
    });

    expect(index).not.toBeNull();
    expect(zarrStoreByPath(index!).get("sub-01/eeg/a.set")?.groups?.[0]?.name).toBe("eeg_250hz");
  });
});
