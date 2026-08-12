import { describe, expect, it } from "vitest";
import { storeRelPath, zarrCacheToken, zarrIndexUrl, zarrKeyUrl, zarrStoreUrl } from "./zarr-base";

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
    expect(zarrStoreUrl("nm000132", "sub-01/eeg/sub-01_task-rest_eeg.set", { base: BASE })).toBe(
      "https://zarr.nemar.org/nm000132/zarr/sub-01/eeg/sub-01_task-rest_eeg.zarr/",
    );
  });

  it("encodes the dataset id but not the BIDS path segments", () => {
    expect(zarrStoreUrl("nm000132", "sub-01/eeg/sub-01_eeg.set", { base: BASE })).toContain(
      "/nm000132/zarr/sub-01/eeg/sub-01_eeg.zarr/",
    );
  });
});

describe("zarrIndexUrl", () => {
  it("points at the dataset's index.json manifest", () => {
    expect(zarrIndexUrl("nm000132", BASE)).toBe("https://zarr.nemar.org/nm000132/zarr/index.json");
  });
});

describe("zarrCacheToken", () => {
  it("strips characters that would need escaping in a query value", () => {
    expect(zarrCacheToken("2026-08-11T23:38:13Z")).toBe("2026-08-11T233813Z");
  });

  it("is empty for a missing or non-string stamp, so no ?v= is emitted", () => {
    expect(zarrCacheToken(undefined)).toBe("");
    expect(zarrCacheToken(null)).toBe("");
    expect(zarrCacheToken("")).toBe("");
    expect(zarrCacheToken(":::")).toBe("");
  });

  it("caps length so a hostile index can't produce an unbounded URL", () => {
    expect(zarrCacheToken("a".repeat(500))).toHaveLength(64);
  });

  it("gives different tokens to different conversion stamps", () => {
    // The whole point: a re-conversion must not reuse the previous token.
    expect(zarrCacheToken("2026-08-11T23:38:13Z")).not.toBe(zarrCacheToken("2026-08-12T10:56:23Z"));
  });
});

describe("zarrStoreUrl cache busting", () => {
  const PATH = "sub-01/eeg/sub-01_task-rest_eeg.set";

  it("appends the conversion token as ?v=", () => {
    expect(zarrStoreUrl("nm000132", PATH, { base: BASE, token: "2026-08-11T23:38:13Z" })).toBe(
      "https://zarr.nemar.org/nm000132/zarr/sub-01/eeg/sub-01_task-rest_eeg.zarr/?v=2026-08-11T233813Z",
    );
  });

  it("omits the query entirely without a token, matching the pre-#240 URL", () => {
    expect(zarrStoreUrl("nm000132", PATH, { base: BASE })).toBe(
      "https://zarr.nemar.org/nm000132/zarr/sub-01/eeg/sub-01_task-rest_eeg.zarr/",
    );
    expect(zarrStoreUrl("nm000132", PATH, { base: BASE, token: "" })).not.toContain("?");
  });

  it("changes the URL when the dataset is re-converted", () => {
    const before = zarrStoreUrl("nm000132", PATH, { base: BASE, token: "2026-08-11T23:38:13Z" });
    const after = zarrStoreUrl("nm000132", PATH, { base: BASE, token: "2026-08-12T10:56:23Z" });
    expect(before).not.toBe(after);
  });

  it("keeps the token out of the path, so the Worker's S3 key is unaffected", () => {
    const url = new URL(zarrStoreUrl("nm000132", PATH, { base: BASE, token: "abc123" }));
    expect(url.pathname).toBe("/nm000132/zarr/sub-01/eeg/sub-01_task-rest_eeg.zarr/");
    expect(url.searchParams.get("v")).toBe("abc123");
  });
});

describe("zarrKeyUrl", () => {
  const PATH = "sub-01/eeg/sub-01_task-rest_eeg.set";

  it("resolves a store key onto the PATH and carries the token across", () => {
    const store = zarrStoreUrl("nm000132", PATH, { base: BASE, token: "abc123" });
    // Naive `store + key` concatenation would splice the key into the query.
    expect(zarrKeyUrl(store, "zarr.json")).toBe(
      "https://zarr.nemar.org/nm000132/zarr/sub-01/eeg/sub-01_task-rest_eeg.zarr/zarr.json?v=abc123",
    );
    expect(zarrKeyUrl(store, "eeg_250hz/0/zarr.json")).toBe(
      "https://zarr.nemar.org/nm000132/zarr/sub-01/eeg/sub-01_task-rest_eeg.zarr/eeg_250hz/0/zarr.json?v=abc123",
    );
  });

  it("leaves an untokened store URL query-free", () => {
    const store = zarrStoreUrl("nm000132", PATH, { base: BASE });
    expect(zarrKeyUrl(store, "zarr.json")).toBe(
      "https://zarr.nemar.org/nm000132/zarr/sub-01/eeg/sub-01_task-rest_eeg.zarr/zarr.json",
    );
  });
});

describe("zarrKeyUrl reuse safety", () => {
  it("descends into a store URL that is missing its trailing slash", () => {
    // zarrStoreUrl always appends one; this guards a future caller that doesn't,
    // where `new URL` would otherwise REPLACE the last segment instead.
    expect(zarrKeyUrl("https://zarr.nemar.org/nm000132/zarr/sub-01_eeg.zarr", "zarr.json")).toBe(
      "https://zarr.nemar.org/nm000132/zarr/sub-01_eeg.zarr/zarr.json",
    );
  });

  it("preserves the token when the trailing slash has to be added", () => {
    expect(
      zarrKeyUrl("https://zarr.nemar.org/nm000132/zarr/sub-01_eeg.zarr?v=abc", "zarr.json"),
    ).toBe("https://zarr.nemar.org/nm000132/zarr/sub-01_eeg.zarr/zarr.json?v=abc");
  });
});
