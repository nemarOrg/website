import { describe, expect, it } from "vitest";
import {
  parseZarrIndex,
  zarrAvailablePaths,
  zarrFailureReasonByPath,
  zarrStoreByPath,
} from "./zarr-index";

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

  it("parses data failures and tolerates an absent failures array", () => {
    const index = parseZarrIndex({
      dataset_id: "on005261",
      format: "nemar-zarr-index",
      stores: [],
      failures: [
        {
          path: "derivatives/sub-01_task-x_ave.fif",
          zarr: "derivatives/sub-01_task-x_ave.zarr",
          code: "not_continuous",
          reason: "trial-averaged derivative",
        },
        { path: "bad-missing-path-field-only-zarr", zarr: "x.zarr" }, // kept (path is a string)
        { zarr: "no-path.zarr" }, // dropped (no path)
        null,
      ],
    });
    expect(index?.failures.map((f) => f.code)).toEqual(["not_continuous", undefined]);
    // Older index without `failures` -> empty array, not null.
    const legacy = parseZarrIndex({ dataset_id: "x", format: "nemar-zarr-index", stores: [] });
    expect(legacy?.failures).toEqual([]);
  });
});

describe("zarrFailureReasonByPath", () => {
  it("maps both the BIDS path and the .zarr path to the reason, skipping reasonless entries", () => {
    const index = parseZarrIndex({
      dataset_id: "on005261",
      format: "nemar-zarr-index",
      stores: [],
      failures: [
        { path: "a-ave.fif", zarr: "a-ave.zarr", code: "not_continuous", reason: "derivative" },
        { path: "b.edf", zarr: "b.zarr", code: "corrupt_or_truncated" }, // no reason -> skipped
      ],
    });
    expect(index).not.toBeNull();
    const m = zarrFailureReasonByPath(index!);
    expect(m.get("a-ave.fif")).toBe("derivative");
    expect(m.get("a-ave.zarr")).toBe("derivative"); // fallback key
    expect(m.has("b.edf")).toBe(false);
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
