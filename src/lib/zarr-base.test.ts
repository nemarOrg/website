import { describe, expect, it } from "vitest";
import { storeRelPath, zarrIndexUrl, zarrStoreUrl } from "./zarr-base";

const BASE = "https://zarr.nemar.org";

describe("storeRelPath", () => {
  it("strips the data extension and appends .zarr, preserving the BIDS suffix", () => {
    expect(storeRelPath("sub-01/eeg/sub-01_task-rest_eeg.set")).toBe(
      "sub-01/eeg/sub-01_task-rest_eeg.zarr",
    );
    expect(storeRelPath("sub-01/ieeg/sub-01_task-x_ieeg.edf")).toBe(
      "sub-01/ieeg/sub-01_task-x_ieeg.zarr",
    );
    expect(storeRelPath("sub-02/emg/sub-02_task-grip_emg.bdf")).toBe(
      "sub-02/emg/sub-02_task-grip_emg.zarr",
    );
  });

  it("handles a bare filename with no directory", () => {
    expect(storeRelPath("sub-01_task-rest_eeg.vhdr")).toBe("sub-01_task-rest_eeg.zarr");
  });

  it("leaves a dotfile-only name intact (no extension to strip)", () => {
    expect(storeRelPath(".bidsignore")).toBe(".bidsignore.zarr");
  });
});

describe("zarrStoreUrl", () => {
  it("builds the trailing-slash store URL under <id>/zarr/", () => {
    expect(zarrStoreUrl("nm000132", "sub-01/eeg/sub-01_task-rest_eeg.set", BASE)).toBe(
      "https://zarr.nemar.org/nm000132/zarr/sub-01/eeg/sub-01_task-rest_eeg.zarr/",
    );
  });

  it("encodes the dataset id but not the BIDS path segments", () => {
    expect(zarrStoreUrl("nm000132", "sub-01/eeg/sub-01_eeg.set", BASE)).toContain(
      "/nm000132/zarr/sub-01/eeg/sub-01_eeg.zarr/",
    );
  });
});

describe("zarrIndexUrl", () => {
  it("points at the dataset's index.json manifest", () => {
    expect(zarrIndexUrl("nm000132", BASE)).toBe("https://zarr.nemar.org/nm000132/zarr/index.json");
  });
});
